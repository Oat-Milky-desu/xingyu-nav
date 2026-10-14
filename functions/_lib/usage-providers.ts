import type { CloudflarePlan, CloudflareUsageData, DeepSeekUsageData } from '../../src/shared/usage';

/**
 * 用量监控的上游适配器：只做「取数 + 归一化 + 可展示的错误信息」。
 *
 * 安全约定：
 * - 凭据只出现在请求头里，绝不进入 URL、日志或对外错误信息；
 * - 上游返回体有体积上限，超限立即中止；
 * - 错误信息由本模块生成（或脱敏截断），不直接回传上游原文。
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ERROR_CHARS = 200;
/** 与官方 Workers 免费计划每日请求上限一致（UTC 当日重置） */
const WORKERS_FREE_DAILY_REQUESTS = 100_000;
/** workersInvocationsAdaptive 单次查询行数上限；触及即认为结果可能被截断 */
const ANALYTICS_ROW_LIMIT = 10_000;

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
  plan: CloudflarePlan;
  scriptName: string;
}

export interface DeepSeekCredentials {
  apiKey: string;
}

export type ProviderFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; retryAfterSeconds?: number };

class UpstreamError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'UpstreamError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface JsonResponse {
  status: number;
  json: unknown;
  retryAfterSeconds?: number;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new UpstreamError('上游返回内容过大，已中止');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 流可能已因超限被取消
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function retryAfterFrom(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

const SENSITIVE_KEYS = /token|key|secret|password|authorization/i;

/** 上游报错文本的脱敏截断：去掉换行、限制长度，避免把凭据或长文带出去 */
export function sanitizeUpstreamMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!cleaned) return '';
  if (SENSITIVE_KEYS.test(cleaned)) return '';
  return cleaned.length > MAX_ERROR_CHARS ? `${cleaned.slice(0, MAX_ERROR_CHARS)}…` : cleaned;
}

async function requestJson(
  url: string,
  init: RequestInit,
  failureLabel: string,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: controller.signal, ...init });
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`${failureLabel}失败：无法连接上游服务`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamError(`${failureLabel}失败：上游返回了意外的重定向`);
    }
    const text = await readCapped(response, MAX_RESPONSE_BYTES);
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return { status: response.status, json, retryAfterSeconds: retryAfterFrom(response.headers) };
  } finally {
    clearTimeout(timeout);
  }
}

function toResult<T>(data: T): ProviderFetchResult<T> {
  return { ok: true, data };
}

function toFailure(error: unknown, fallback: string): ProviderFetchResult<never> {
  if (error instanceof UpstreamError) {
    return { ok: false, message: error.message, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
  }
  return { ok: false, message: fallback };
}

/* ------------------------------ Cloudflare ------------------------------ */

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function utcNextDayStart(now: Date): Date {
  const start = utcDayStart(now);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

interface AnalyticsRow {
  sum?: { requests?: unknown; errors?: unknown } | null;
}

function sumRows(rows: AnalyticsRow[]): { requests: number; errors: number } {
  let requests = 0;
  let errors = 0;
  for (const row of rows) {
    requests += asNumber(row.sum?.requests);
    errors += asNumber(row.sum?.errors);
  }
  return { requests, errors };
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 从单个账号节点上取出某个别名（today / month）的分析行 */
function extractAnalyticsGroup(account: unknown, alias: string): AnalyticsRow[] {
  const group = (account as Record<string, unknown> | null ?? {})[alias];
  return Array.isArray(group) ? (group as AnalyticsRow[]) : [];
}

export async function fetchCloudflareUsage(
  credentials: CloudflareCredentials,
  now: Date,
): Promise<ProviderFetchResult<CloudflareUsageData>> {
  const scoped = credentials.scriptName.length > 0;
  const scopeFilter = scoped ? ', scriptName: $scriptName' : '';
  const query = `query XingyuUsage($accountTag: string!, $todayStart: string!, $monthStart: string!, $end: string!${
    scoped ? ', $scriptName: string!' : ''
  }) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      today: workersInvocationsAdaptive(limit: ${ANALYTICS_ROW_LIMIT}, filter: { datetime_geq: $todayStart, datetime_leq: $end${scopeFilter} }) {
        sum { requests errors }
      }
      month: workersInvocationsAdaptive(limit: ${ANALYTICS_ROW_LIMIT}, filter: { datetime_geq: $monthStart, datetime_leq: $end${scopeFilter} }) {
        sum { requests errors }
      }
    }
  }
}`;

  const variables: Record<string, unknown> = {
    accountTag: credentials.accountId,
    todayStart: utcDayStart(now).toISOString(),
    monthStart: utcMonthStart(now).toISOString(),
    end: now.toISOString(),
  };
  if (scoped) variables.scriptName = credentials.scriptName;

  try {
    const response = await requestJson(
      'https://api.cloudflare.com/client/v4/graphql',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
      'Cloudflare 用量查询',
    );

    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError('Cloudflare API Token 无效或权限不足（需要 Account Analytics: Read）');
    }
    if (response.status === 429) {
      throw new UpstreamError('Cloudflare 接口请求过于频繁，请稍后重试', response.retryAfterSeconds ?? 300);
    }
    if (response.status !== 200 || response.json === null) {
      throw new UpstreamError(`Cloudflare 用量查询失败（HTTP ${response.status}）`);
    }

    const payload = response.json as { data?: unknown; errors?: unknown };
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length > 0 && payload.data === undefined) {
      const detail = sanitizeUpstreamMessage(
        (errors[0] as { message?: unknown } | undefined)?.message,
      );
      throw new UpstreamError(detail ? `Cloudflare 接口返回错误：${detail}` : 'Cloudflare 接口返回错误');
    }

    const accounts = (payload.data as { viewer?: { accounts?: unknown } } | null)?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new UpstreamError('未找到该 Account ID 对应的账号，请检查 Account ID 是否正确');
    }

    const todayRows = extractAnalyticsGroup(accounts[0], 'today');
    const monthRows = extractAnalyticsGroup(accounts[0], 'month');
    const today = sumRows(todayRows);
    const month = sumRows(monthRows);

    return toResult<CloudflareUsageData>({
      plan: credentials.plan,
      scope: scoped ? 'worker' : 'account',
      scriptName: scoped ? credentials.scriptName : null,
      requestsToday: today.requests,
      errorsToday: today.errors,
      requestsMonth: month.requests,
      errorsMonth: month.errors,
      dailyLimit: credentials.plan === 'free' ? WORKERS_FREE_DAILY_REQUESTS : null,
      quotaResetAt: utcNextDayStart(now).toISOString(),
      truncated: todayRows.length >= ANALYTICS_ROW_LIMIT || monthRows.length >= ANALYTICS_ROW_LIMIT,
    });
  } catch (error) {
    return toFailure(error, 'Cloudflare 用量查询失败');
  }
}

/* -------------------------------- DeepSeek ------------------------------- */

function parseBalance(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new UpstreamError('DeepSeek 余额接口返回了无法识别的数据');
}

export async function fetchDeepSeekBalance(
  credentials: DeepSeekCredentials,
): Promise<ProviderFetchResult<DeepSeekUsageData>> {
  try {
    const response = await requestJson(
      'https://api.deepseek.com/user/balance',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${credentials.apiKey}`, Accept: 'application/json' },
      },
      'DeepSeek 余额查询',
    );

    if (response.status === 401) {
      throw new UpstreamError('DeepSeek API Key 无效');
    }
    if (response.status === 402) {
      throw new UpstreamError('DeepSeek 账户余额不足，无法继续调用');
    }
    if (response.status === 429) {
      throw new UpstreamError('DeepSeek 接口请求过于频繁，请稍后重试', response.retryAfterSeconds ?? 60);
    }
    if (response.status !== 200 || response.json === null) {
      throw new UpstreamError(`DeepSeek 余额查询失败（HTTP ${response.status}）`);
    }

    const payload = response.json as {
      is_available?: unknown;
      balance_infos?: unknown;
    };
    const infos = payload.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0) {
      throw new UpstreamError('DeepSeek 余额接口未返回余额信息');
    }
    const primary = infos[0] as Record<string, unknown>;
    const currency = typeof primary.currency === 'string' && primary.currency ? primary.currency : 'CNY';

    return toResult<DeepSeekUsageData>({
      isAvailable: payload.is_available === true,
      currency,
      totalBalance: parseBalance(primary.total_balance),
      grantedBalance: parseBalance(primary.granted_balance),
      toppedUpBalance: parseBalance(primary.topped_up_balance),
    });
  } catch (error) {
    return toFailure(error, 'DeepSeek 余额查询失败');
  }
}
