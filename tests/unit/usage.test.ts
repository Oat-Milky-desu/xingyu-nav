import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UsageDrawer from '../../src/components/usage/UsageDrawer.vue';
import {
  USAGE_PROVIDER_LABELS,
  cloudflareErrorRate,
  cloudflareQuotaRatio,
  cloudflareQuotaTone,
  formatUsageAmount,
  formatUsageNumber,
  formatUsagePercent,
  isUsageProvider,
  type UsageOverview,
} from '../../src/shared/usage';
import { usageState } from '../../src/stores/usage';
import { uiState } from '../../src/stores/ui';

const NOW = '2026-03-01T08:00:00.000Z';

function overview(configured: 'cloudflare' | 'deepseek' | 'both' | 'none'): UsageOverview {
  const withCloudflare = configured === 'cloudflare' || configured === 'both';
  const withDeepSeek = configured === 'deepseek' || configured === 'both';
  return {
    credentialsReady: true,
    providers: [
      {
        provider: 'cloudflare',
        configured: withCloudflare,
        updatedAt: withCloudflare ? NOW : null,
        dataFetchedAt: withCloudflare ? NOW : null,
        failed: false,
        errorMessage: null,
        stale: false,
        config: withCloudflare ? { accountId: 'acc-1', plan: 'free', scriptName: '' } : null,
        data: withCloudflare
          ? {
              plan: 'free',
              scope: 'account',
              scriptName: null,
              requestsToday: 1234,
              errorsToday: 12,
              requestsMonth: 4321,
              errorsMonth: 30,
              dailyLimit: 100_000,
              quotaResetAt: '2026-03-02T00:00:00.000Z',
              truncated: false,
            }
          : null,
      },
      {
        provider: 'deepseek',
        configured: withDeepSeek,
        updatedAt: withDeepSeek ? NOW : null,
        dataFetchedAt: withDeepSeek ? NOW : null,
        failed: false,
        errorMessage: null,
        stale: false,
        config: null,
        data: withDeepSeek
          ? { isAvailable: true, currency: 'CNY', totalBalance: 110, grantedBalance: 10, toppedUpBalance: 100 }
          : null,
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(payload: UsageOverview) {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(payload));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await flushPromises();
}

async function mountDrawer() {
  // 关闭 Teleport，让面板内容留在 wrapper 内，便于断言与交互
  const wrapper = mount(UsageDrawer, {
    props: { open: false },
    global: { stubs: { teleport: true } },
  });
  await wrapper.setProps({ open: true });
  await settle();
  return wrapper;
}

describe('用量监控展示辅助函数', () => {
  it('千分位分组不依赖运行环境 locale', () => {
    expect(formatUsageNumber(0)).toBe('0');
    expect(formatUsageNumber(999)).toBe('999');
    expect(formatUsageNumber(1000)).toBe('1,000');
    expect(formatUsageNumber(1234567)).toBe('1,234,567');
    expect(formatUsageNumber(1234.6)).toBe('1,235');
    expect(formatUsageNumber(Number.NaN)).toBe('—');
  });

  it('金额保留两位小数并分组', () => {
    expect(formatUsageAmount(110)).toBe('110.00');
    expect(formatUsageAmount(1234.5)).toBe('1,234.50');
    expect(formatUsageAmount(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('错误率与免费额度进度', () => {
    expect(formatUsagePercent(0.1234)).toBe('12.3%');
    expect(
      cloudflareErrorRate({
        plan: 'free',
        scope: 'account',
        scriptName: null,
        requestsToday: 200,
        errorsToday: 4,
        requestsMonth: 0,
        errorsMonth: 0,
        dailyLimit: 100_000,
        quotaResetAt: NOW,
        truncated: false,
      }),
    ).toBeCloseTo(0.02);
    expect(cloudflareQuotaRatio({ dailyLimit: 100, requestsToday: 250 } as never)).toBe(1);
    expect(cloudflareQuotaRatio({ dailyLimit: null, requestsToday: 250 } as never)).toBeNull();
    expect(cloudflareQuotaTone(0.2)).toBe('default');
    expect(cloudflareQuotaTone(0.85)).toBe('warning');
    expect(cloudflareQuotaTone(1)).toBe('danger');
  });

  it('服务标识与标签', () => {
    expect(isUsageProvider('cloudflare')).toBe(true);
    expect(isUsageProvider('deepseek')).toBe(true);
    expect(isUsageProvider('vercel')).toBe(false);
    expect(USAGE_PROVIDER_LABELS.cloudflare).toBe('Cloudflare Workers');
  });
});

describe('用量面板', () => {
  beforeEach(() => {
    usageState.loaded = false;
    usageState.loading = false;
    usageState.refreshing = false;
    usageState.saving = false;
    usageState.removing = false;
    usageState.error = '';
    usageState.credentialsReady = true;
    usageState.providers = [];
    uiState.confirm = null;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('只展示已配置的服务，未配置的服务只出现在「添加服务」中', async () => {
    stubFetch(overview('deepseek'));
    const wrapper = await mountDrawer();

    expect(wrapper.text()).toContain('DeepSeek API');
    expect(wrapper.text()).toContain('110.00 CNY');
    expect(wrapper.findAll('.usage-card')).toHaveLength(1);
    expect(wrapper.findAll('.usage-add-row')).toHaveLength(1);

    wrapper.unmount();
  });

  it('全部未配置时给出空状态提示', async () => {
    stubFetch(overview('none'));
    const wrapper = await mountDrawer();

    expect(wrapper.findAll('.usage-card')).toHaveLength(0);
    expect(wrapper.text()).toContain('还没有监控任何服务');
    expect(wrapper.findAll('.usage-add-row')).toHaveLength(2);

    wrapper.unmount();
  });

  it('卡片右上角的设置按钮打开对应服务的配置弹窗', async () => {
    stubFetch(overview('both'));
    const wrapper = await mountDrawer();

    const gears = wrapper.findAll('.usage-gear');
    expect(gears).toHaveLength(2);
    await gears[1]!.trigger('click');
    await settle();

    expect(wrapper.text()).toContain('设置 DeepSeek API');
    expect(wrapper.text()).toContain('API Key');

    wrapper.unmount();
  });

  it('服务端未配置加密密钥时给出明确提示且禁止添加', async () => {
    stubFetch({ ...overview('none'), credentialsReady: false });
    const wrapper = await mountDrawer();

    expect(wrapper.text()).toContain('USAGE_ENCRYPTION_KEY');
    const addButtons = wrapper.findAll('.usage-add-row button');
    expect(addButtons.length).toBeGreaterThan(0);
    expect(addButtons[0]!.attributes('disabled')).toBeDefined();

    wrapper.unmount();
  });

  it('打开面板时读取缓存，已有新鲜数据就不再请求上游', async () => {
    const mock = stubFetch(overview('cloudflare'));
    const wrapper = await mountDrawer();

    expect(mock).toHaveBeenCalledTimes(1);
    expect(String(mock.mock.calls[0]?.[0])).toBe('/api/usage');

    wrapper.unmount();
  });

  it('数据缺失或过期时自动触发一次刷新', async () => {
    const stale = overview('none');
    stale.providers[0]!.configured = true;
    stale.providers[0]!.stale = true;
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url === '/api/usage/refresh' ? jsonResponse(overview('cloudflare')) : jsonResponse(stale);
    });
    vi.stubGlobal('fetch', mock);

    const wrapper = await mountDrawer();

    expect(mock.mock.calls.map((call) => String(call[0]))).toEqual(['/api/usage', '/api/usage/refresh']);
    expect(wrapper.text()).toContain('1,234');

    wrapper.unmount();
  });

  it('删除配置需要先确认，取消时不会发起删除请求', async () => {
    const mock = stubFetch(overview('deepseek'));
    const wrapper = await mountDrawer();

    await wrapper.findAll('.usage-gear')[0]!.trigger('click');
    await settle();
    const removeButton = wrapper.findAll('button').find((button) => button.text() === '删除配置');
    expect(removeButton).toBeDefined();
    await removeButton!.trigger('click');
    await settle();

    expect(uiState.confirm?.title).toBe('删除监控配置');
    uiState.confirm?.resolve('cancel');
    await settle();

    const calls = mock.mock.calls.map((call) => `${String(call[0])}:${String(call[1]?.method ?? 'GET')}`);
    expect(calls).toEqual(['/api/usage:GET']);

    wrapper.unmount();
  });

  it('确认删除时使用 DELETE + JSON 请求体，并移除卡片', async () => {
    const configured = overview('deepseek');
    const deleted = overview('none');
    const mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE' ? jsonResponse(deleted) : jsonResponse(configured),
    );
    vi.stubGlobal('fetch', mock);

    const wrapper = await mountDrawer();
    await wrapper.findAll('.usage-gear')[0]!.trigger('click');
    await settle();
    await wrapper.findAll('button').find((button) => button.text() === '删除配置')!.trigger('click');
    await settle();
    uiState.confirm?.resolve('primary');
    await settle();

    const removal = mock.mock.calls.find((call) => call[1]?.method === 'DELETE');
    expect(String(removal?.[0])).toBe('/api/usage/providers/deepseek');
    // 非安全方法必须带 application/json，否则服务端会以 415 拒绝
    expect(removal?.[1]?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(wrapper.findAll('.usage-card')).toHaveLength(0);

    wrapper.unmount();
  });
});
