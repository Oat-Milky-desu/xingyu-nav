import { reactive } from 'vue';
import { ApiError, apiRequest, errorText, getSessionEpoch } from '../api/client';
import type {
  CloudflareProviderInput,
  DeepSeekProviderInput,
  UsageOverview,
  UsageProvider,
  UsageProviderState,
} from '../shared/usage';

/**
 * 用量监控状态。
 *
 * 与 content 状态完全独立：不使用内容版本号，也不写入 AppSettings，
 * 因此监控配置既不会出现在 /api/content，也不会进入 JSON 备份。
 * 凭据只存在于服务端（加密保存），这里仅保存非敏感的展示数据。
 */
export const usageState = reactive({
  loaded: false,
  loading: false,
  refreshing: false,
  saving: false,
  removing: false,
  error: '',
  /** 服务端是否配置了加密密钥；未配置时无法保存凭据 */
  credentialsReady: true,
  providers: [] as UsageProviderState[],
});

function applyOverview(overview: UsageOverview): void {
  usageState.credentialsReady = overview.credentialsReady;
  usageState.providers = overview.providers;
  usageState.loaded = true;
  usageState.error = '';
}

function resetState(): void {
  usageState.loaded = false;
  usageState.loading = false;
  usageState.refreshing = false;
  usageState.saving = false;
  usageState.removing = false;
  usageState.error = '';
  usageState.credentialsReady = true;
  usageState.providers = [];
}

export function resetUsageState(): void {
  resetState();
}

/** 只有已配置的服务才会被展示 */
export const configuredProviders = (): UsageProviderState[] => usageState.providers.filter((item) => item.configured);

/** 读取缓存状态（不触发上游取数） */
export async function loadUsage(): Promise<boolean> {
  const epoch = getSessionEpoch();
  usageState.loading = true;
  try {
    const overview = await apiRequest<UsageOverview>('/api/usage');
    if (epoch !== getSessionEpoch()) return false;
    applyOverview(overview);
    return true;
  } catch (error) {
    if (epoch === getSessionEpoch()) usageState.error = errorText(error);
    return false;
  } finally {
    if (epoch === getSessionEpoch()) usageState.loading = false;
  }
}

/**
 * 触发上游取数。
 * - 不传 provider：只刷新缓存缺失或已过期的服务（打开面板时使用）
 * - 传 provider 或 force: 主动刷新（手动按钮）
 * 会话变化期间返回的响应会被丢弃，不会把旧会话数据写回状态。
 */
export async function refreshUsage(options: { provider?: UsageProvider; force?: boolean } = {}): Promise<void> {
  const epoch = getSessionEpoch();
  usageState.refreshing = true;
  try {
    const overview = await apiRequest<UsageOverview>('/api/usage/refresh', {
      method: 'POST',
      body: { ...(options.provider ? { provider: options.provider } : {}), ...(options.force ? { force: true } : {}) },
    });
    if (epoch !== getSessionEpoch()) return;
    applyOverview(overview);
  } catch (error) {
    if (epoch !== getSessionEpoch()) return;
    if (error instanceof ApiError && error.code === 'server_misconfigured') {
      usageState.credentialsReady = false;
    }
    usageState.error = errorText(error);
  } finally {
    if (epoch === getSessionEpoch()) usageState.refreshing = false;
  }
}

export async function saveUsageProvider(
  provider: UsageProvider,
  input: CloudflareProviderInput | DeepSeekProviderInput,
): Promise<void> {
  const epoch = getSessionEpoch();
  usageState.saving = true;
  try {
    const overview = await apiRequest<UsageOverview>(`/api/usage/providers/${provider}`, {
      method: 'PUT',
      body: input,
    });
    if (epoch !== getSessionEpoch()) return;
    applyOverview(overview);
  } finally {
    if (epoch === getSessionEpoch()) usageState.saving = false;
  }
}

export async function deleteUsageProvider(provider: UsageProvider): Promise<void> {
  const epoch = getSessionEpoch();
  usageState.removing = true;
  try {
    const overview = await apiRequest<UsageOverview>(`/api/usage/providers/${provider}`, {
      method: 'DELETE',
      // 非安全方法一律要求 JSON 请求体（与其余写接口一致），因此显式发送空对象
      body: {},
    });
    if (epoch !== getSessionEpoch()) return;
    applyOverview(overview);
  } finally {
    if (epoch === getSessionEpoch()) usageState.removing = false;
  }
}
