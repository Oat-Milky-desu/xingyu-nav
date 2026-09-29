import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, resetDatabase, seedAdmin, type Harness } from './helpers';
import type { NavLink } from '../../src/shared/types';

const VALID_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (char) => char.charCodeAt(0),
);

type FetchReply = Response | (() => Response | Promise<Response>);

async function authedLink(url = 'https://cache-icons.net/docs'): Promise<{ harness: Harness; link: NavLink }> {
  await seedAdmin();
  const harness = createHarness();
  await harness.expectOk(await harness.login());
  const group = await harness.createGroup('图标缓存测试');
  const link = await harness.createLink(group.id, { url });
  return { harness, link };
}

function mockFetch(replies: FetchReply[]) {
  const urls: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(String(input));
    const next = replies.shift();
    if (!next) return new Response(null, { status: 404 });
    return typeof next === 'function' ? next() : next;
  });
  return { spy, urls };
}

function pngResponse(bytes = VALID_PNG): Response {
  return new Response(bytes.slice().buffer, { headers: { 'content-type': 'image/png' } });
}

async function iconPost(harness: Harness, link: NavLink, refresh = false): Promise<Response> {
  return harness.call(`/api/links/${link.id}/icon`, { method: 'POST', body: { ...(refresh ? { refresh: true } : {}) } });
}

describe('链接 favicon 缓存 API', () => {
  beforeEach(async () => {
    await resetDatabase();
    await env.DB.prepare('DELETE FROM link_icon_cache').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET 和 POST 都要求登录，POST 还要求 CSRF', async () => {
    const anonymous = createHarness();
    expect((await anonymous.call('/api/links/anything/icon')).status).toBe(401);
    expect((await anonymous.call('/api/links/anything/icon', { method: 'POST', body: {} })).status).toBe(401);

    const { harness, link } = await authedLink();
    const noCsrf = await harness.call(`/api/links/${link.id}/icon`, { method: 'POST', body: {}, csrf: null });
    expect(noCsrf.status).toBe(403);
  });

  it('只从固定图标服务填充缓存，读取私有 no-store BLOB，后续 POST 直接复用', async () => {
    const { harness, link } = await authedLink();
    const network = mockFetch([pngResponse()]);

    const first = await harness.json<{ status: string; refreshed?: boolean }>(await iconPost(harness, link));
    expect(first).toEqual({ status: 'ready', refreshed: true });
    expect(network.urls).toEqual(['https://www.google.com/s2/favicons?domain=cache-icons.net&sz=64']);

    const cached = await harness.json(await iconPost(harness, link));
    expect(cached).toEqual({ status: 'ready', refreshed: false });
    expect(network.spy).toHaveBeenCalledTimes(1);

    const image = await harness.call(`/api/links/${link.id}/icon`);
    expect(image.status).toBe(200);
    expect(image.headers.get('cache-control')).toContain('no-store');
    expect(image.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([...VALID_PNG]);

    // A new API instance/session still reads D1 rather than process memory.
    const anotherDevice = createHarness();
    await anotherDevice.expectOk(await anotherDevice.login());
    expect(await anotherDevice.json(await iconPost(anotherDevice, link))).toEqual({ status: 'ready', refreshed: false });
    expect(network.spy).toHaveBeenCalledTimes(1);
  });

  it('失败的显式刷新保留旧图片，重复 POST 遵守刷新冷却', async () => {
    const { harness, link } = await authedLink();
    const network = mockFetch([pngResponse()]);
    expect((await harness.json<{ status: string }>(await iconPost(harness, link))).status).toBe('ready');

    harness.advance(31_000);
    network.urls.length = 0;
    network.spy.mockImplementation(async (input) => {
      network.urls.push(String(input));
      return new Response(null, { status: 404 });
    });
    const failedRefresh = await harness.json<{ status: string; refreshed?: boolean }>(await iconPost(harness, link, true));
    expect(failedRefresh).toEqual({ status: 'ready', refreshed: false });
    expect(network.urls).toHaveLength(2);

    network.spy.mockClear();
    const cooled = await harness.json<{ status: string; retryAfterSeconds?: number }>(await iconPost(harness, link, true));
    expect(cooled.status).toBe('ready');
    expect(cooled.retryAfterSeconds).toBeGreaterThan(0);
    expect(network.spy).not.toHaveBeenCalled();

    const image = await harness.call(`/api/links/${link.id}/icon`);
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([...VALID_PNG]);
  });

  it('不缓存私有主机，并为失败结果持久化一小时负缓存', async () => {
    const { harness, link } = await authedLink('https://printer.local/admin');
    const network = mockFetch([]);
    expect(await harness.json(await iconPost(harness, link))).toEqual({ status: 'unsupported' });
    expect(network.spy).not.toHaveBeenCalled();

    const publicLink = await harness.createLink(link.groupId, { url: 'https://negative-cache.net' });
    network.spy.mockImplementation(async () => new Response(null, { status: 404 }));
    expect(await harness.json(await iconPost(harness, publicLink))).toEqual({ status: 'failed', retryAfterSeconds: 3600 });
    network.spy.mockClear();
    expect(await harness.json(await iconPost(harness, publicLink))).toEqual({ status: 'failed', retryAfterSeconds: 3600 });
    expect(network.spy).not.toHaveBeenCalled();
  });

  it('只允许精确 provider 重定向，并依次回退到 DuckDuckGo', async () => {
    const { harness, link } = await authedLink();
    const network = mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/icon.png' } }),
      pngResponse(),
    ]);

    expect((await harness.json<{ status: string }>(await iconPost(harness, link))).status).toBe('ready');
    expect(network.urls).toEqual([
      'https://www.google.com/s2/favicons?domain=cache-icons.net&sz=64',
      'https://icons.duckduckgo.com/ip3/cache-icons.net.ico',
    ]);

    const gstaticLink = await harness.createLink(link.groupId, { url: 'https://gstatic-cache.net' });
    const gstatic = mockFetch([
      () => new Response(null, {
        status: 302,
        headers: { location: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&url=https%3A%2F%2Fgstatic-cache.net&size=64' },
      }),
      pngResponse(),
    ]);
    expect((await harness.json<{ status: string }>(await iconPost(harness, gstaticLink))).status).toBe('ready');
    expect(gstatic.urls[1]).toContain('https://t2.gstatic.com/faviconV2?');
  });

  it.each([
    ['HTML MIME', 'text/html', Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c])],
    ['SVG MIME', 'image/svg+xml', Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 0x3e])],
    ['mismatched signature', 'image/png', Uint8Array.from([1, 2, 3, 4])],
    ['empty body', 'image/png', new Uint8Array()],
    ['truncated PNG', 'image/png', VALID_PNG.slice(0, 8)],
  ])('拒绝 %s 并尝试下一个固定 provider', async (_label, mimeType, bytes) => {
    const { harness, link } = await authedLink();
    const network = mockFetch([
      () => new Response(bytes.slice().buffer, { headers: { 'content-type': mimeType } }),
      () => new Response(null, { status: 404 }),
    ]);

    expect((await harness.json<{ status: string }>(await iconPost(harness, link))).status).toBe('failed');
    expect(network.spy).toHaveBeenCalledTimes(2);
    expect((await harness.call(`/api/links/${link.id}/icon`)).status).toBe(404);
  });

  it('在流式上限拒绝超大图片，并保存第二个 provider 的有效图片', async () => {
    const { harness, link } = await authedLink();
    const tooLarge = new Uint8Array(65_537);
    tooLarge.set(VALID_PNG.slice(0, 8));
    const network = mockFetch([
      () => new Response(tooLarge.buffer, { headers: { 'content-type': 'image/png' } }),
      pngResponse(),
    ]);

    expect((await harness.json<{ status: string }>(await iconPost(harness, link))).status).toBe('ready');
    expect(network.spy).toHaveBeenCalledTimes(2);
    const image = await harness.call(`/api/links/${link.id}/icon`);
    expect(new Uint8Array(await image.arrayBuffer()).byteLength).toBeLessThanOrEqual(65_536);
  });

  it('并发请求共享 lease，且编辑链接后旧响应不能写入缓存', async () => {
    const { harness, link } = await authedLink();
    let resolveUpstream!: (response: Response) => void;
    const network = mockFetch([
      () => new Promise<Response>((resolve) => {
        resolveUpstream = resolve;
      }),
    ]);

    const firstPromise = iconPost(harness, link);
    await vi.waitFor(() => expect(network.spy).toHaveBeenCalledTimes(1));
    expect(await harness.json(await iconPost(harness, link))).toEqual({ status: 'pending', retryAfterSeconds: 30 });
    expect(network.spy).toHaveBeenCalledTimes(1);

    const content = await harness.getContent();
    await harness.expectOk(await harness.call(`/api/links/${link.id}`, {
      method: 'PATCH',
      body: { revision: content.revision, url: 'https://changed-signature.net/new' },
    }));
    resolveUpstream(pngResponse());
    const staleResult = await harness.json<{ status: string; retryAfterSeconds?: number }>(await firstPromise);
    expect(staleResult).toEqual({ status: 'pending', retryAfterSeconds: 1 });
    expect((await harness.call(`/api/links/${link.id}/icon`)).status).toBe(404);

    const row = await env.DB.prepare('SELECT hostname, status, image FROM link_icon_cache WHERE link_id = ?1')
      .bind(link.id)
      .first<{ hostname: string; status: string; image: ArrayBuffer | null }>();
    expect(row?.hostname).toBe('cache-icons.net');
    expect(row?.status).toBe('pending');
    expect(row?.image).toBeNull();
  });

  it('删除链接时级联清除派生图标', async () => {
    const { harness, link } = await authedLink();
    mockFetch([pngResponse()]);
    expect((await harness.json<{ status: string }>(await iconPost(harness, link))).status).toBe('ready');
    const beforeDelete = await env.DB.prepare('SELECT COUNT(*) AS count FROM link_icon_cache WHERE link_id = ?1')
      .bind(link.id)
      .first<{ count: number }>();
    expect(beforeDelete?.count).toBe(1);

    const content = await harness.getContent();
    await harness.expectOk(await harness.call(`/api/links/${link.id}`, {
      method: 'DELETE',
      body: { revision: content.revision },
    }));
    const afterDelete = await env.DB.prepare('SELECT COUNT(*) AS count FROM link_icon_cache WHERE link_id = ?1')
      .bind(link.id)
      .first<{ count: number }>();
    expect(afterDelete?.count).toBe(0);
  });
});
