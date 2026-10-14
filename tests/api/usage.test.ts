import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../../functions/_lib/router';
import type { Env } from '../../functions/_lib/env';
import type { ApiErrorBody, BackupFile } from '../../src/shared/types';
import type { UsageOverview } from '../../src/shared/usage';
import { HOST, ORIGIN, createHarness, resetDatabase, seedAdmin, type Harness } from './helpers';

type FetchReply = Response | (() => Response | Promise<Response>);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(replies: FetchReply[]) {
  const urls: string[] = [];
  const bodies: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    urls.push(String(input));
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    const next = replies.shift();
    if (!next) return new Response(null, { status: 404 });
    return typeof next === 'function' ? next() : next;
  });
  return { spy, urls, bodies };
}

function cloudflarePayload(requestsToday: number, errorsToday: number, requestsMonth: number, errorsMonth: number): unknown {
  return {
    data: {
      viewer: {
        accounts: [
          {
            today: [{ sum: { requests: requestsToday, errors: errorsToday } }],
            month: [{ sum: { requests: requestsMonth, errors: errorsMonth } }],
          },
        ],
      },
    },
  };
}

function deepSeekPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00', ...overrides },
    ],
  };
}

async function authed(): Promise<Harness> {
  await seedAdmin();
  const harness = createHarness();
  await harness.expectOk(await harness.login());
  return harness;
}

function providerOf(overview: UsageOverview, provider: 'cloudflare' | 'deepseek') {
  const found = overview.providers.find((item) => item.provider === provider);
  if (!found) throw new Error(`缺少服务：${provider}`);
  return found;
}

async function saveCloudflare(
  harness: Harness,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return harness.call('/api/usage/providers/cloudflare', {
    method: 'PUT',
    body: { accountId: 'acc-123', plan: 'free', apiToken: 'cf-secret-token-value', ...body },
  });
}

describe('用量监控 API', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('所有用量接口都需要登录，写操作还要求 CSRF', async () => {
    const anonymous = createHarness();
    expect((await anonymous.call('/api/usage')).status).toBe(401);
    expect((await anonymous.call('/api/usage/refresh', { method: 'POST', body: {} })).status).toBe(401);
    expect((await anonymous.call('/api/usage/providers/cloudflare', { method: 'PUT', body: {} })).status).toBe(401);
    expect((await anonymous.call('/api/usage/providers/cloudflare', { method: 'DELETE', body: {} })).status).toBe(401);

    const harness = await authed();
    expect((await harness.call('/api/usage/refresh', { method: 'POST', body: {}, csrf: null })).status).toBe(403);
    expect(
      (
        await harness.call('/api/usage/providers/cloudflare', {
          method: 'PUT',
          body: { accountId: 'acc', plan: 'free', apiToken: 'token' },
          csrf: null,
        })
      ).status,
    ).toBe(403);
  });

  it('默认返回两个未配置的服务，且不触发任何上游请求', async () => {
    const harness = await authed();
    const network = mockFetch([]);

    const overview = await harness.expectOk<UsageOverview>(await harness.call('/api/usage'));

    expect(overview.credentialsReady).toBe(true);
    expect(overview.providers.map((item) => item.provider)).toEqual(['cloudflare', 'deepseek']);
    expect(overview.providers.every((item) => !item.configured && item.data === null && !item.failed)).toBe(true);
    expect(network.spy).not.toHaveBeenCalled();
  });

  it('保存 Cloudflare 配置时校验凭据、加密落库且不回显明文', async () => {
    const harness = await authed();
    const network = mockFetch([jsonResponse(cloudflarePayload(12, 1, 340, 3))]);

    const overview = await harness.expectOk<UsageOverview>(await saveCloudflare(harness));
    const cloudflare = providerOf(overview, 'cloudflare');

    expect(cloudflare.configured).toBe(true);
    expect(cloudflare.data).toMatchObject({
      plan: 'free',
      scope: 'account',
      scriptName: null,
      requestsToday: 12,
      errorsToday: 1,
      requestsMonth: 340,
      errorsMonth: 3,
      dailyLimit: 100_000,
      truncated: false,
    });
    expect(cloudflare.config).toEqual({ accountId: 'acc-123', plan: 'free', scriptName: '' });
    expect(JSON.stringify(overview)).not.toContain('cf-secret-token-value');

    const row = await env.DB.prepare('SELECT config_json, secret_json FROM usage_providers WHERE provider = ?1')
      .bind('cloudflare')
      .first<{ config_json: string; secret_json: string }>();
    expect(row?.secret_json).toMatch(/^v1\./);
    expect(row?.secret_json).not.toContain('cf-secret-token-value');
    expect(row?.config_json).toContain('acc-123');
    // 校验时的取数结果直接进入缓存，不额外再请求一次
    expect(network.urls).toEqual(['https://api.cloudflare.com/client/v4/graphql']);
    expect(network.spy).toHaveBeenCalledTimes(1);
  });

  it('Cloudflare 查询包含账号、UTC 时间窗口与 Worker 过滤', async () => {
    const harness = await authed();
    const network = mockFetch([jsonResponse(cloudflarePayload(1, 0, 1, 0))]);

    await harness.expectOk<UsageOverview>(await saveCloudflare(harness, { scriptName: 'my-worker' }));

    const request = JSON.parse(network.bodies[0] ?? '{}') as { query: string; variables: Record<string, unknown> };
    expect(request.variables.accountTag).toBe('acc-123');
    expect(request.variables.scriptName).toBe('my-worker');
    expect(request.query).toContain('scriptName: $scriptName');
    expect(String(request.variables.todayStart)).toMatch(/T00:00:00\.000Z$/);
    expect(String(request.variables.monthStart)).toMatch(/-01T00:00:00\.000Z$/);
    // 令牌只出现在请求头里，绝不出现在请求体
    expect(network.bodies[0]).not.toContain('cf-secret-token-value');
  });

  it('凭据校验失败时返回 400 并且不保存配置', async () => {
    const harness = await authed();
    mockFetch([jsonResponse({ errors: [{ message: 'Invalid API Token' }] }, 403)]);

    const response = await saveCloudflare(harness, { apiToken: 'bad-token' });
    expect(response.status).toBe(400);
    const body = await harness.errorBody(response);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toContain('权限不足');

    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM usage_providers').first<{ count: number }>();
    expect(count?.count).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM usage_cache').first<{ count: number }>())?.count).toBe(0);
  });

  it('关闭校验时可直接保存，之后由刷新取数', async () => {
    const harness = await authed();
    const network = mockFetch([]);

    const saved = await harness.expectOk<UsageOverview>(
      await saveCloudflare(harness, { accountId: 'acc-2', plan: 'paid', scriptName: 'xingyu-nav', verify: false }),
    );
    const before = providerOf(saved, 'cloudflare');
    expect(before.configured).toBe(true);
    expect(before.data).toBeNull();
    expect(before.config).toEqual({ accountId: 'acc-2', plan: 'paid', scriptName: 'xingyu-nav' });
    expect(network.spy).not.toHaveBeenCalled();

    network.spy.mockImplementation(async () => jsonResponse(cloudflarePayload(5, 0, 9, 0)));
    const refreshed = await harness.expectOk<UsageOverview>(
      await harness.call('/api/usage/refresh', { method: 'POST', body: { provider: 'cloudflare' } }),
    );
    expect(providerOf(refreshed, 'cloudflare').data).toMatchObject({
      plan: 'paid',
      scope: 'worker',
      scriptName: 'xingyu-nav',
      requestsToday: 5,
      dailyLimit: null,
    });
  });

  it('保存 DeepSeek 密钥并解析字符串金额', async () => {
    const harness = await authed();
    const network = mockFetch([jsonResponse(deepSeekPayload())]);

    const overview = await harness.expectOk<UsageOverview>(
      await harness.call('/api/usage/providers/deepseek', { method: 'PUT', body: { apiKey: 'sk-deepseek-secret' } }),
    );
    const deepseek = providerOf(overview, 'deepseek');

    expect(deepseek.configured).toBe(true);
    expect(deepseek.data).toEqual({
      isAvailable: true,
      currency: 'CNY',
      totalBalance: 110,
      grantedBalance: 10,
      toppedUpBalance: 100,
    });
    expect(JSON.stringify(overview)).not.toContain('sk-deepseek-secret');
    expect(network.urls).toEqual(['https://api.deepseek.com/user/balance']);
  });

  it('上游返回缺少余额字段时报错且不保存', async () => {
    const harness = await authed();
    mockFetch([jsonResponse({ is_available: true })]);

    const response = await harness.call('/api/usage/providers/deepseek', {
      method: 'PUT',
      body: { apiKey: 'sk-no-balance' },
    });
    expect(response.status).toBe(400);
    expect((await harness.errorBody(response)).error.message).toContain('未返回余额信息');
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM usage_providers').first<{ count: number }>())?.count).toBe(0);
  });

  it('取数失败时保留上次成功数据并标注原因', async () => {
    const harness = await authed();
    const network = mockFetch([jsonResponse(deepSeekPayload())]);
    await harness.expectOk(
      await harness.call('/api/usage/providers/deepseek', { method: 'PUT', body: { apiKey: 'sk-key' } }),
    );

    harness.advance(11_000);
    network.spy.mockImplementation(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 }));

    const failed = await harness.expectOk<UsageOverview>(
      await harness.call('/api/usage/refresh', { method: 'POST', body: { provider: 'deepseek' } }),
    );
    const deepseek = providerOf(failed, 'deepseek');
    expect(deepseek.failed).toBe(true);
    expect(deepseek.errorMessage).toBe('DeepSeek API Key 无效');
    expect(deepseek.data).toMatchObject({ totalBalance: 110 });
    expect(deepseek.dataFetchedAt).not.toBeNull();
  });

  it('更换凭据后旧缓存立即失效', async () => {
    const harness = await authed();
    const network = mockFetch([jsonResponse(deepSeekPayload())]);
    await harness.expectOk(
      await harness.call('/api/usage/providers/deepseek', { method: 'PUT', body: { apiKey: 'sk-first' } }),
    );

    const overview = await harness.expectOk<UsageOverview>(
      await harness.call('/api/usage/providers/deepseek', {
        method: 'PUT',
        body: { apiKey: 'sk-second', verify: false },
      }),
    );
    const deepseek = providerOf(overview, 'deepseek');
    expect(deepseek.configured).toBe(true);
    expect(deepseek.data).toBeNull();
    expect(deepseek.failed).toBe(false);
    expect(network.spy).toHaveBeenCalledTimes(1);
  });

  it('TTL 内复用缓存，过期后才重新取数', async () => {
    const harness = await authed();
    const network = mockFetch([jsonResponse(deepSeekPayload())]);
    await harness.expectOk(
      await harness.call('/api/usage/providers/deepseek', { method: 'PUT', body: { apiKey: 'sk-key' } }),
    );
    expect(network.spy).toHaveBeenCalledTimes(1);

    harness.advance(11_000);
    await harness.expectOk(await harness.call('/api/usage/refresh', { method: 'POST', body: {} }));
    expect(network.spy).toHaveBeenCalledTimes(1);

    harness.advance(5 * 60 * 1000);
    await harness.expectOk(await harness.call('/api/usage/refresh', { method: 'POST', body: {} }));
    expect(network.spy).toHaveBeenCalledTimes(2);
  });

  it('主动刷新在冷却窗口内不会重复访问上游', async () => {
    const harness = await authed();
    const network = mockFetch([jsonResponse(deepSeekPayload())]);
    await harness.expectOk(
      await harness.call('/api/usage/providers/deepseek', { method: 'PUT', body: { apiKey: 'sk-key' } }),
    );

    harness.advance(2_000);
    await harness.expectOk(
      await harness.call('/api/usage/refresh', { method: 'POST', body: { provider: 'deepseek' } }),
    );
    expect(network.spy).toHaveBeenCalledTimes(1);
  });

  it('并发刷新共享租约，只向上游请求一次', async () => {
    const harness = await authed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      await gate;
      return jsonResponse(deepSeekPayload());
    });

    await harness.expectOk(
      await harness.call('/api/usage/providers/deepseek', { method: 'PUT', body: { apiKey: 'sk-key', verify: false } }),
    );

    const first = harness.call('/api/usage/refresh', { method: 'POST', body: { provider: 'deepseek' } });
    await vi.waitFor(() => expect(calls).toBe(1));

    const second = await harness.json<UsageOverview>(
      await harness.call('/api/usage/refresh', { method: 'POST', body: { provider: 'deepseek' } }),
    );
    expect(calls).toBe(1);
    expect(providerOf(second, 'deepseek').data).toBeNull();

    release();
    await first;
    const after = await harness.expectOk<UsageOverview>(await harness.call('/api/usage'));
    expect(providerOf(after, 'deepseek').data).toMatchObject({ totalBalance: 110 });
  });

  it('删除配置会移除卡片并级联清除缓存', async () => {
    const harness = await authed();
    mockFetch([jsonResponse(deepSeekPayload())]);
    await harness.expectOk(
      await harness.call('/api/usage/providers/deepseek', { method: 'PUT', body: { apiKey: 'sk-key' } }),
    );
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM usage_cache').first<{ count: number }>())?.count).toBe(1);

    const overview = await harness.expectOk<UsageOverview>(
      await harness.call('/api/usage/providers/deepseek', { method: 'DELETE', body: {} }),
    );
    const deepseek = providerOf(overview, 'deepseek');
    expect(deepseek.configured).toBe(false);
    expect(deepseek.data).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM usage_cache').first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM usage_providers').first<{ count: number }>())?.count).toBe(0);
  });

  it('删除未配置的服务返回 404，未知服务一律 404', async () => {
    const harness = await authed();
    expect((await harness.call('/api/usage/providers/cloudflare', { method: 'DELETE', body: {} })).status).toBe(404);
    expect((await harness.call('/api/usage/providers/vercel', { method: 'PUT', body: { accountId: 'x', plan: 'free', apiToken: 'y' } })).status).toBe(404);
    expect((await harness.call('/api/usage/providers/vercel', { method: 'DELETE', body: {} })).status).toBe(404);
  });

  it('拒绝未知字段、非法套餐与非法 Account ID', async () => {
    const harness = await authed();
    mockFetch([]);
    expect((await saveCloudflare(harness, { extra: 1 })).status).toBe(400);
    expect((await saveCloudflare(harness, { plan: 'enterprise' })).status).toBe(400);
    expect((await saveCloudflare(harness, { accountId: 'a b' })).status).toBe(400);
    expect((await harness.call('/api/usage/providers/deepseek', { method: 'PUT', body: { apiKey: 'k', extra: true } })).status).toBe(400);
  });

  it('上游响应过大时按失败处理', async () => {
    const harness = await authed();
    mockFetch([new Response('x'.repeat(300 * 1024), { status: 200, headers: { 'content-type': 'application/json' } })]);

    const response = await harness.call('/api/usage/providers/deepseek', {
      method: 'PUT',
      body: { apiKey: 'sk-huge' },
    });
    expect(response.status).toBe(400);
    expect((await harness.errorBody(response)).error.message).toContain('过大');
  });

  it('未配置加密密钥时拒绝保存凭据，但读取接口仍可用', async () => {
    const harness = await authed();
    const withoutKey = { ...env } as Env;
    delete withoutKey.USAGE_ENCRYPTION_KEY;
    const handler = createApiHandler({ now: () => harness.now() });

    const response = await handler(
      new Request(`${ORIGIN}/api/usage/providers/cloudflare`, {
        method: 'PUT',
        headers: {
          host: HOST,
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: harness.cookie() ?? '',
          'x-csrf-token': harness.csrf() ?? '',
        },
        body: JSON.stringify({ accountId: 'acc', plan: 'free', apiToken: 'token' }),
      }),
      withoutKey,
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('server_misconfigured');
    expect(body.error.message).toContain('USAGE_ENCRYPTION_KEY');
  });

  it('监控配置不进入 JSON 备份，也不会被恢复操作清除', async () => {
    const harness = await authed();
    mockFetch([jsonResponse(deepSeekPayload())]);
    await harness.expectOk(
      await harness.call('/api/usage/providers/deepseek', { method: 'PUT', body: { apiKey: 'sk-backup-secret' } }),
    );

    const backup = await harness.expectOk<BackupFile>(await harness.call('/api/backup'));
    const text = JSON.stringify(backup);
    expect(text).not.toContain('deepseek');
    expect(text).not.toContain('sk-backup-secret');

    const content = await harness.getContent();
    await harness.expectOk(
      await harness.call('/api/restore', { body: { revision: content.revision, backup } }),
    );

    const overview = await harness.expectOk<UsageOverview>(await harness.call('/api/usage'));
    expect(providerOf(overview, 'deepseek').configured).toBe(true);
  });
});
