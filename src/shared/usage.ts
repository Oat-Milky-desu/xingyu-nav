/**
 * 星屿导航 —— 用量监控的前后端共享契约。
 *
 * 该文件必须保持环境无关（浏览器 / Cloudflare Workers 均可运行）。
 * 监控配置与用量数据完全独立于导航内容：既不出现在 /api/content，
 * 也不进入 JSON 备份，凭据永远只以密文形式留在服务端。
 */

export const USAGE_PROVIDERS = ['cloudflare', 'deepseek'] as const;

export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = {
  cloudflare: 'Cloudflare Workers',
  deepseek: 'DeepSeek API',
};

export function isUsageProvider(value: unknown): value is UsageProvider {
  return typeof value === 'string' && (USAGE_PROVIDERS as readonly string[]).includes(value);
}

/* --------------------------------- 配置 --------------------------------- */

export type CloudflarePlan = 'free' | 'paid';

/** Cloudflare 的非敏感配置（凭据单独加密存储，不在这里） */
export interface CloudflareProviderConfig {
  accountId: string;
  plan: CloudflarePlan;
  /** 为空表示统计整个账号；填写后只统计该 Worker */
  scriptName: string;
}

/** DeepSeek 余额接口不需要额外标识，凭据只有 API Key */
export type DeepSeekProviderConfig = Record<string, never>;

/* --------------------------------- 数据 --------------------------------- */

export interface CloudflareUsageData {
  plan: CloudflarePlan;
  scope: 'account' | 'worker';
  scriptName: string | null;
  /** 今日（UTC）请求数 */
  requestsToday: number;
  /** 今日（UTC）错误数 */
  errorsToday: number;
  /** 本月（UTC，自本月 1 日起）请求数 */
  requestsMonth: number;
  /** 本月（UTC）错误数 */
  errorsMonth: number;
  /** 免费套餐每日请求上限；付费套餐为 null */
  dailyLimit: number | null;
  /** 当日额度下一次重置时间（UTC ISO） */
  quotaResetAt: string;
  /** 上游返回行数触及查询上限，统计值可能不完整 */
  truncated: boolean;
}

export interface DeepSeekUsageData {
  /** 余额是否足以继续调用 */
  isAvailable: boolean;
  /** 账户币种，由 DeepSeek 决定（CNY / USD） */
  currency: string;
  /** 可用总余额（含赠送与充值） */
  totalBalance: number;
  /** 未过期的赠送余额 */
  grantedBalance: number;
  /** 充值余额 */
  toppedUpBalance: number;
}

/**
 * 单个服务的展示状态。
 * `data` 是最近一次成功取数的结果：取数失败时会保留旧数据，
 * 同时把 `failed` / `errorMessage` 置为失败信息，界面据此标注“数据可能过期”。
 */
export interface UsageProviderStateBase {
  configured: boolean;
  updatedAt: string | null;
  dataFetchedAt: string | null;
  failed: boolean;
  errorMessage: string | null;
  /** 缓存数据是否已超过自动刷新窗口 */
  stale: boolean;
}

export interface CloudflareProviderState extends UsageProviderStateBase {
  provider: 'cloudflare';
  data: CloudflareUsageData | null;
  /** 非敏感配置，用于表单回填与展示 */
  config: CloudflareProviderConfig | null;
}

export interface DeepSeekProviderState extends UsageProviderStateBase {
  provider: 'deepseek';
  data: DeepSeekUsageData | null;
  /** DeepSeek 没有非敏感配置 */
  config: null;
}

export type UsageProviderState = CloudflareProviderState | DeepSeekProviderState;

export interface UsageOverview {
  /** 服务端是否配置了 USAGE_ENCRYPTION_KEY；未配置时无法保存凭据 */
  credentialsReady: boolean;
  providers: UsageProviderState[];
}

/** 保存配置时提交的字段；凭据字段留空表示沿用已保存的旧凭据 */
export interface CloudflareProviderInput {
  accountId: string;
  plan: CloudflarePlan;
  scriptName?: string;
  apiToken?: string;
  /** 默认 true：保存前先向 Cloudflare 校验凭据，校验失败则不保存 */
  verify?: boolean;
}

export interface DeepSeekProviderInput {
  apiKey?: string;
  /** 默认 true：保存前先向 DeepSeek 校验凭据 */
  verify?: boolean;
}

/* ------------------------------- 展示辅助 ------------------------------- */

/** 千分位分组，避免依赖运行环境 locale，保证测试稳定 */
export function formatUsageNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const negative = rounded < 0;
  const digits = String(Math.abs(rounded));
  let output = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) output += ',';
    output += digits[index];
  }
  return negative ? `-${output}` : output;
}

/** 百分比保留一位小数，用于错误率 */
export function formatUsagePercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 金额统一保留两位小数（千分位分组），币种由服务端给出 */
export function formatUsageAmount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = value.toFixed(2);
  const [integer, decimals] = fixed.split('.');
  const grouped = formatUsageNumber(Number(integer ?? '0'));
  return decimals ? `${grouped}.${decimals}` : grouped;
}

export function cloudflareErrorRate(data: CloudflareUsageData): number {
  if (data.requestsToday <= 0) return 0;
  return data.errorsToday / data.requestsToday;
}

/** 免费套餐当日额度使用比例（0~1）；付费套餐返回 null */
export function cloudflareQuotaRatio(data: CloudflareUsageData): number | null {
  if (data.dailyLimit === null || data.dailyLimit <= 0) return null;
  return Math.min(1, data.requestsToday / data.dailyLimit);
}

/** 额度进度条语气：接近或超过上限时高亮 */
export function cloudflareQuotaTone(ratio: number): 'default' | 'warning' | 'danger' {
  if (ratio >= 1) return 'danger';
  if (ratio >= 0.8) return 'warning';
  return 'default';
}
