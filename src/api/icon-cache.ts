import { apiRequest, getSessionEpoch } from './client';
import type { IconType } from '../shared/types';
import { cachedIconHostname as cachedHostname, type IconCacheResult } from '../shared/icon-cache';

type CacheRequest = {
  key: string;
  linkId: string;
  refresh: boolean;
  sessionEpoch: number;
  resolve: (result: IconCacheResult) => void;
  reject: (error: unknown) => void;
};

const MAX_CONCURRENT_CACHE_REQUESTS = 4;
const requestQueue: CacheRequest[] = [];
const requests = new Map<string, Promise<IconCacheResult>>();
let activeRequests = 0;

/**
 * Resolve a saved link's automatic icon through the authenticated cache API.
 * Requests for the same link and operation share one promise, and the global
 * queue keeps several visible cards from flooding the endpoint at once.
 */
export function resolveSavedIcon(linkId: string, refresh = false): Promise<IconCacheResult> {
  const sessionEpoch = getSessionEpoch();
  const key = `${sessionEpoch}:${linkId}:${refresh ? 'refresh' : 'resolve'}`;
  const existing = requests.get(key);
  if (existing) return existing;

  let resolveRequest!: (result: IconCacheResult) => void;
  let rejectRequest!: (error: unknown) => void;
  const promise = new Promise<IconCacheResult>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  requests.set(key, promise);
  requestQueue.push({ key, linkId, refresh, sessionEpoch, resolve: resolveRequest, reject: rejectRequest });
  pumpQueue();
  return promise;
}

function pumpQueue(): void {
  while (activeRequests < MAX_CONCURRENT_CACHE_REQUESTS && requestQueue.length > 0) {
    const request = requestQueue.shift()!;
    if (request.sessionEpoch !== getSessionEpoch()) {
      request.reject(new Error('登录状态已变化，该图标请求已被忽略'));
      requests.delete(request.key);
      continue;
    }
    activeRequests += 1;
    void apiRequest<IconCacheResult>(`/api/links/${encodeURIComponent(request.linkId)}/icon`, {
      method: 'POST',
      body: request.refresh ? { refresh: true } : {},
    })
      .then(request.resolve, request.reject)
      .finally(() => {
        requests.delete(request.key);
        activeRequests -= 1;
        pumpQueue();
      });
  }
}

/** The saved automatic modes supported by the public icon cache. */
export function supportsSavedIconCache(url: string, iconType: IconType, iconValue: string): boolean {
  return (iconType === 'auto' || (iconType === 'favicon' && !iconValue)) && cachedHostname(url, iconType, iconValue) !== null;
}
