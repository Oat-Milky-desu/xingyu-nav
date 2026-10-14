import {
  USAGE_PROVIDERS,
  isUsageProvider,
  type CloudflarePlan,
  type CloudflareProviderConfig,
  type CloudflareUsageData,
  type DeepSeekUsageData,
  type UsageOverview,
  type UsageProvider,
  type UsageProviderState,
} from '../../src/shared/usage';
import { bool, oneOf, optional, parseObject, str } from '../../src/shared/validate';
import { JSON_BODY_LIMIT, requireAuth, type Ctx } from './context';
import { HttpError, jsonResponse, notFound, readJson } from './http';
import { decryptSecret, encryptSecret, hasUsableEncryptionKey, requireEncryptionKey } from './secret-box';
import {
  fetchCloudflareUsage,
  fetchDeepSeekBalance,
  type CloudflareCredentials,
  type ProviderFetchResult,
} from './usage-providers';

/** 打开面板时若缓存已超过该时长，界面会主动触发一次刷新 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** 取数租约：并发刷新时只有一个请求真正访问上游 */
const LEASE_MS = 20 * 1000;
/** 主动刷新的最小间隔，避免手抖连点打爆上游限流 */
const REFRESH_COOLDOWN_MS = 10 * 1000;

interface ProviderRow {
  provider: string;
  config_json: string;
  secret_json: string;
  generation: number;
  created_at: string;
  updated_at: string;
}

interface CacheRow {
  provider: string;
  generation: number;
  status: string;
  payload_json: string | null;
  error_message: string | null;
  last_success_at: string | null;
  last_success_ms: number | null;
  last_attempt_ms: number;
  lease_id: string | null;
  lease_until_ms: number | null;
}

interface CloudflareSecret {
  apiToken: string;
}

interface DeepSeekSecret {
  apiKey: string;
}

const PROVIDER_COLUMNS = 'provider, config_json, secret_json, generation, created_at, updated_at';
const CACHE_COLUMNS =
  'provider, generation, status, payload_json, error_message, last_success_at, last_success_ms, last_attempt_ms, lease_id, lease_until_ms';

const accountIdField = str({
  min: 1,
  max: 64,
  pattern: /^[A-Za-z0-9_-]+$/,
  patternMessage: '只能包含字母、数字、下划线和连字符',
  label: 'Account ID',
});
const planField = oneOf<CloudflarePlan>(['free', 'paid'], '套餐');
const scriptNameField = str({ min: 0, max: 128, label: 'Worker 名称' });
const credentialField = (label: string) => str({ min: 0, max: 512, label });

const cloudflareSaveShape = {
  accountId: accountIdField,
  plan: planField,
  scriptName: optional(scriptNameField),
  apiToken: optional(credentialField('API Token')),
  verify: optional(bool('保存前校验')),
};

const deepSeekSaveShape = {
  apiKey: optional(credentialField('API Key')),
  verify: optional(bool('保存前校验')),
};

const refreshShape = {
  provider: optional(oneOf(USAGE_PROVIDERS, '服务')),
  force: optional(bool('强制刷新')),
};

/* ------------------------------- 读取与展示 ------------------------------- */

function parseJsonObject<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function buildState(
  provider: UsageProvider,
  row: ProviderRow | null,
  cache: CacheRow | null,
  now: number,
): UsageProviderState {
  const current = usableCache(row, cache);
  const failed = current?.status === 'error';
  const dataFetchedAt = current?.last_success_at ?? null;
  const lastSuccessMs = current?.last_success_ms ?? null;
  const stale = lastSuccessMs === null || now - lastSuccessMs >= CACHE_TTL_MS;
  const common = {
    configured: row !== null,
    updatedAt: row?.updated_at ?? null,
    dataFetchedAt,
    failed,
    errorMessage: failed ? current?.error_message ?? '取数失败' : null,
    stale,
  };

  if (provider === 'cloudflare') {
    return {
      provider: 'cloudflare',
      ...common,
      config: normalizeCloudflareConfig(row ? parseJsonObject<Partial<CloudflareProviderConfig>>(row.config_json) : null),
      data: parseJsonObject<CloudflareUsageData>(current?.payload_json),
    };
  }
  return { provider: 'deepseek', ...common, config: null, data: parseJsonObject<DeepSeekUsageData>(current?.payload_json) };
}

/** 只在行存在时返回配置；配置损坏时给出安全默认值，避免界面崩溃 */
function normalizeCloudflareConfig(value: Partial<CloudflareProviderConfig> | null): CloudflareProviderConfig | null {
  if (!value) return null;
  return {
    accountId: typeof value.accountId === 'string' ? value.accountId : '',
    plan: value.plan === 'paid' ? 'paid' : 'free',
    scriptName: typeof value.scriptName === 'string' ? value.scriptName : '',
  };
}

/** 缓存只有在与当前配置代际一致时才可信 */
function usableCache(row: ProviderRow | null, cache: CacheRow | null): CacheRow | null {
  if (!row || !cache) return null;
  return cache.generation === row.generation ? cache : null;
}

async function readOverview(ctx: Ctx): Promise<UsageOverview> {
  const db = ctx.env.DB;
  const [providerResult, cacheResult] = await db.batch([
    db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM usage_providers`),
    db.prepare(`SELECT ${CACHE_COLUMNS} FROM usage_cache`),
  ]);
  const providerRows = (providerResult?.results ?? []) as unknown as ProviderRow[];
  const cacheRows = (cacheResult?.results ?? []) as unknown as CacheRow[];
  const providers = USAGE_PROVIDERS.map((provider) =>
    buildState(
      provider,
      providerRows.find((row) => row.provider === provider) ?? null,
      cacheRows.find((row) => row.provider === provider) ?? null,
      ctx.now,
    ),
  );
  return { credentialsReady: hasUsableEncryptionKey(ctx.env.USAGE_ENCRYPTION_KEY), providers };
}

async function getProviderRow(db: D1Database, provider: string): Promise<ProviderRow | null> {
  return db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM usage_providers WHERE provider = ?1`).bind(provider).first<ProviderRow>();
}

async function getCacheRow(db: D1Database, provider: string): Promise<CacheRow | null> {
  return db.prepare(`SELECT ${CACHE_COLUMNS} FROM usage_cache WHERE provider = ?1`).bind(provider).first<CacheRow>();
}

/**
 * 解密已保存的凭据。密钥被更换或数据损坏时返回 null（由调用方提示重新保存），
 * 不会把解密失败升级成 500 —— 单个服务不可用不应影响其它服务。
 */
async function readSecret<T>(row: ProviderRow, keyMaterial: string): Promise<T | null> {
  try {
    const parsed = JSON.parse(await decryptSecret(row.secret_json, keyMaterial)) as T;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/* --------------------------------- 处理器 --------------------------------- */

export async function handleGetUsage(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  return jsonResponse(await readOverview(ctx));
}

export async function handlePutUsageProvider(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const provider = ctx.params.provider ?? '';
  if (!isUsageProvider(provider)) throw notFound('不支持该用量服务');

  const keyMaterial = requireEncryptionKey(ctx.env);
  const existing = await getProviderRow(ctx.env.DB, provider);
  const body = await readJson(ctx.request, JSON_BODY_LIMIT);

  if (provider === 'cloudflare') {
    const input = parseObject(cloudflareSaveShape, body);
    const existingSecret = existing ? await readSecret<CloudflareSecret>(existing, keyMaterial) : null;
    const existingConfig = existing ? parseJsonObject<Partial<CloudflareProviderConfig>>(existing.config_json) : null;
    const apiToken = (input.apiToken ?? '').trim() || existingSecret?.apiToken || '';
    if (!apiToken) {
      throw new HttpError(400, 'validation_error', '请填写 Cloudflare API Token', {
        issues: [{ path: 'apiToken', message: '请填写 API Token' }],
      });
    }
    const scriptName = (
      input.scriptName ?? (typeof existingConfig?.scriptName === 'string' ? existingConfig.scriptName : '')
    ).trim();
    const config: CloudflareProviderConfig = { accountId: input.accountId, plan: input.plan, scriptName };
    const credentials: CloudflareCredentials = { ...config, apiToken };

    let verified: CloudflareUsageData | null = null;
    if (input.verify !== false) {
      const result = await fetchCloudflareUsage(credentials, new Date(ctx.now));
      if (!result.ok) {
        throw new HttpError(400, 'validation_error', result.message, {
          issues: [{ path: 'apiToken', message: result.message }],
        });
      }
      verified = result.data;
    }

    await persistProvider(ctx, provider, JSON.stringify(config), await encryptSecret(JSON.stringify({ apiToken }), keyMaterial), existing, verified);
    return jsonResponse(await readOverview(ctx));
  }

  const input = parseObject(deepSeekSaveShape, body);
  const existingSecret = existing ? await readSecret<DeepSeekSecret>(existing, keyMaterial) : null;
  const apiKey = (input.apiKey ?? '').trim() || existingSecret?.apiKey || '';
  if (!apiKey) {
    throw new HttpError(400, 'validation_error', '请填写 DeepSeek API Key', {
      issues: [{ path: 'apiKey', message: '请填写 API Key' }],
    });
  }

  let verified: DeepSeekUsageData | null = null;
  if (input.verify !== false) {
    const result = await fetchDeepSeekBalance({ apiKey });
    if (!result.ok) {
      throw new HttpError(400, 'validation_error', result.message, {
        issues: [{ path: 'apiKey', message: result.message }],
      });
    }
    verified = result.data;
  }

  await persistProvider(ctx, provider, JSON.stringify({}), await encryptSecret(JSON.stringify({ apiKey }), keyMaterial), existing, verified);
  return jsonResponse(await readOverview(ctx));
}

export async function handleDeleteUsageProvider(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const provider = ctx.params.provider ?? '';
  if (!isUsageProvider(provider)) throw notFound('不支持该用量服务');
  const result = await ctx.env.DB.prepare('DELETE FROM usage_providers WHERE provider = ?1').bind(provider).run();
  if (result.meta.changes === 0) throw new HttpError(404, 'not_found', '该服务尚未配置');
  // usage_cache 通过外键级联删除
  return jsonResponse(await readOverview(ctx));
}

export async function handleRefreshUsage(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const body = await readJson(ctx.request, JSON_BODY_LIMIT);
  const input = parseObject(refreshShape, body);
  const targets: UsageProvider[] = input.provider ? [input.provider] : [...USAGE_PROVIDERS];
  const force = input.force === true || input.provider !== undefined;

  const db = ctx.env.DB;
  for (const provider of targets) {
    const row = await getProviderRow(db, provider);
    if (!row) continue;
    const cache = await getCacheRow(db, provider);
    if (!shouldFetch(row, cache, ctx.now, force)) continue;
    await refreshProvider(ctx, provider, row);
  }
  return jsonResponse(await readOverview(ctx));
}

/* --------------------------------- 取数 --------------------------------- */

function shouldFetch(row: ProviderRow, cache: CacheRow | null, now: number, force: boolean): boolean {
  const current = usableCache(row, cache);
  const lastAttempt = current?.last_attempt_ms ?? 0;
  const cooled = now - lastAttempt >= REFRESH_COOLDOWN_MS;
  if (!current || current.payload_json === null) return cooled;
  if (force) return cooled;
  return current.last_success_ms === null || now - current.last_success_ms >= CACHE_TTL_MS;
}

async function fetchFor(ctx: Ctx, provider: UsageProvider, row: ProviderRow, keyMaterial: string): Promise<ProviderFetchResult<unknown>> {
  const config = parseJsonObject<Partial<CloudflareProviderConfig>>(row.config_json) ?? {};
  if (provider === 'cloudflare') {
    const secret = await readSecret<CloudflareSecret>(row, keyMaterial);
    if (!secret?.apiToken) return { ok: false, message: '已保存的凭据不可用，请重新保存配置' };
    return fetchCloudflareUsage(
      {
        accountId: typeof config.accountId === 'string' ? config.accountId : '',
        plan: config.plan === 'paid' ? 'paid' : 'free',
        scriptName: typeof config.scriptName === 'string' ? config.scriptName : '',
        apiToken: secret.apiToken,
      },
      new Date(ctx.now),
    );
  }
  const secret = await readSecret<DeepSeekSecret>(row, keyMaterial);
  if (!secret?.apiKey) return { ok: false, message: '已保存的凭据不可用，请重新保存配置' };
  return fetchDeepSeekBalance({ apiKey: secret.apiKey });
}

async function refreshProvider(ctx: Ctx, provider: UsageProvider, row: ProviderRow): Promise<void> {
  const db = ctx.env.DB;
  const keyMaterial = requireEncryptionKey(ctx.env);
  const leaseId = crypto.randomUUID();

  // 缓存行在保存配置时建立；这里的兜底插入保证租约一定可被占用
  await db
    .prepare(
      `INSERT INTO usage_cache (provider, generation, status, payload_json, last_attempt_ms, lease_id, lease_until_ms, updated_at)
       VALUES (?1, ?2, 'unknown', NULL, 0, NULL, NULL, ?3)
       ON CONFLICT(provider) DO NOTHING`,
    )
    .bind(provider, row.generation, ctx.nowIso)
    .run();

  const claim = await db
    .prepare(
      `UPDATE usage_cache SET lease_id = ?1, lease_until_ms = ?2, updated_at = ?3
       WHERE provider = ?4 AND generation = ?5 AND (lease_id IS NULL OR lease_until_ms <= ?6)`,
    )
    .bind(leaseId, ctx.now + LEASE_MS, ctx.nowIso, provider, row.generation, ctx.now)
    .run();
  if (claim.meta.changes === 0) return; // 其它请求正在取数，直接沿用缓存

  let result: ProviderFetchResult<unknown>;
  try {
    result = await fetchFor(ctx, provider, row, keyMaterial);
  } catch (error) {
    result = { ok: false, message: error instanceof HttpError ? error.message : '取数失败' };
  }

  if (result.ok) {
    await db
      .prepare(
        `UPDATE usage_cache
         SET status = 'ok', payload_json = ?1, error_message = NULL,
             last_success_at = ?2, last_success_ms = ?3, last_attempt_ms = ?3,
             lease_id = NULL, lease_until_ms = NULL, updated_at = ?2
         WHERE provider = ?4 AND generation = ?5 AND lease_id = ?6`,
      )
      .bind(JSON.stringify(result.data), ctx.nowIso, ctx.now, provider, row.generation, leaseId)
      .run();
    return;
  }

  // 失败时保留上一次成功数据，仅标记失败原因与尝试时间
  await db
    .prepare(
      `UPDATE usage_cache
       SET status = 'error', error_message = ?1, last_attempt_ms = ?2,
           lease_id = NULL, lease_until_ms = NULL, updated_at = ?3
       WHERE provider = ?4 AND generation = ?5 AND lease_id = ?6`,
    )
    .bind(result.message, ctx.now, ctx.nowIso, provider, row.generation, leaseId)
    .run();
}

async function persistProvider(
  ctx: Ctx,
  provider: UsageProvider,
  configJson: string,
  secretJson: string,
  existing: ProviderRow | null,
  verified: unknown | null,
): Promise<void> {
  const db = ctx.env.DB;
  const generation = (existing?.generation ?? 0) + 1;
  const success = verified !== null;
  await db.batch([
    db
      .prepare(
        `INSERT INTO usage_providers (provider, config_json, secret_json, generation, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(provider) DO UPDATE SET
           config_json = excluded.config_json,
           secret_json = excluded.secret_json,
           generation = excluded.generation,
           updated_at = excluded.updated_at`,
      )
      .bind(provider, configJson, secretJson, generation, ctx.nowIso),
    // 代际递增会立即让旧缓存失效；校验通过的取数结果直接写入，省掉一次上游调用
    db
      .prepare(
        `INSERT INTO usage_cache (provider, generation, status, payload_json, error_message, last_success_at, last_success_ms, last_attempt_ms, lease_id, lease_until_ms, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, NULL, NULL, ?8)
         ON CONFLICT(provider) DO UPDATE SET
           generation = excluded.generation,
           status = excluded.status,
           payload_json = excluded.payload_json,
           error_message = NULL,
           last_success_at = excluded.last_success_at,
           last_success_ms = excluded.last_success_ms,
           last_attempt_ms = excluded.last_attempt_ms,
           lease_id = NULL,
           lease_until_ms = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(
        provider,
        generation,
        success ? 'ok' : 'unknown',
        success ? JSON.stringify(verified) : null,
        success ? ctx.nowIso : null,
        success ? ctx.now : null,
        success ? ctx.now : 0,
        ctx.nowIso,
      ),
  ]);
}
