import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSavedIcon, supportsSavedIconCache } from '../../src/api/icon-cache';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('saved icon cache client', () => {
  it('only enables the cache for supported public automatic icons', () => {
    expect(supportsSavedIconCache('https://www.wikipedia.org/wiki/Main_Page', 'auto', '')).toBe(true);
    expect(supportsSavedIconCache('https://www.wikipedia.org/', 'favicon', '')).toBe(false);
    expect(supportsSavedIconCache('https://www.wikipedia.org/', 'favicon', 'https://cdn.example.org/icon.png')).toBe(false);
    expect(supportsSavedIconCache('https://nas.local/', 'auto', '')).toBe(false);
  });

  it('deduplicates matching operations and keeps resolving requests at four concurrent calls', async () => {
    const pendingResponses: ((response: Response) => void)[] = [];
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise<Response>((resolve) => {
        pendingResponses.push((response) => {
          active -= 1;
          resolve(response);
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const requests = [
      resolveSavedIcon('link-1'),
      resolveSavedIcon('link-1'),
      resolveSavedIcon('link-2'),
      resolveSavedIcon('link-3'),
      resolveSavedIcon('link-4'),
      resolveSavedIcon('link-5'),
    ];

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const complete of pendingResponses.splice(0)) complete(jsonResponse({ status: 'ready' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    for (const complete of pendingResponses.splice(0)) complete(jsonResponse({ status: 'ready' }));
    const results = await Promise.all(requests);

    expect(results.map((result) => result.status)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready', 'ready']);
    expect(maximumActive).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/links/link-1/icon');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('sends an explicit refresh body for a user-requested update', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'ready', refreshed: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveSavedIcon('link-refresh', true)).resolves.toMatchObject({ status: 'ready', refreshed: true });

    expect(fetchMock).toHaveBeenCalledWith('/api/links/link-refresh/icon', expect.objectContaining({
      method: 'POST',
      body: '{"refresh":true}',
    }));
  });
});
