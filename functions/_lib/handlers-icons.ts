import { cachedIconHostname, type IconCacheResult } from '../../src/shared/icon-cache';
import { requireAuth, type Ctx } from './context';
import { baseHeaders, HttpError, jsonResponse, readJson } from './http';

const MAX_ICON_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const LEASE_MS = 30_000;
const NEGATIVE_COOLDOWN_MS = 60 * 60 * 1_000;
const REFRESH_COOLDOWN_MS = 30 * 1_000;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

interface LinkRow {
  id: string;
  url: string;
  icon_type: string;
  icon_value: string;
}

interface IconCacheRow {
  link_id: string;
  hostname: string;
  status: 'pending' | 'ready' | 'failed';
  mime_type: string | null;
  image: ArrayBuffer | Uint8Array | null;
  negative_until_ms: number;
  lease_id: string | null;
  lease_until_ms: number | null;
  last_refresh_at_ms: number | null;
}

interface IconAsset {
  mimeType: string;
  bytes: Uint8Array;
}

export async function handleGetLinkIcon(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const link = await getLink(ctx, ctx.params.id ?? '');
  if (!link) throw new HttpError(404, 'not_found', '链接不存在或尚无缓存图标');
  const hostname = cachedIconHostname(link.url, link.icon_type, link.icon_value);
  if (!hostname) throw new HttpError(404, 'not_found', '尚无缓存图标');

  const row = await getCache(ctx, link.id);
  if (!row || row.hostname !== hostname || row.status !== 'ready' || !row.mime_type || !row.image) {
    throw new HttpError(404, 'not_found', '尚无缓存图标');
  }

  const bytes = toUint8Array(row.image);
  return new Response(bytes, {
    headers: {
      ...baseHeaders(),
      'Content-Type': row.mime_type,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': 'inline',
    },
  });
}

export async function handlePostLinkIcon(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const link = await getLink(ctx, ctx.params.id ?? '');
  if (!link) throw new HttpError(404, 'not_found', '链接不存在');

  const body = await readJson(ctx.request, 1_024);
  if (!isRefreshBody(body)) throw new HttpError(400, 'validation_error', '图标缓存请求格式无效');
  const refresh = body.refresh ?? false;
  const hostname = cachedIconHostname(link.url, link.icon_type, link.icon_value);
  if (!hostname) return resultResponse({ status: 'unsupported' });

  const current = await getCache(ctx, link.id);
  const readyBytes = current?.hostname === hostname && current.status === 'ready' && Boolean(current.image);
  const existingResult = resultWithoutFetch(current, hostname, refresh, ctx.now);
  if (existingResult) return resultResponse(existingResult);

  const leaseId = crypto.randomUUID();
  const claimed = await claimLease(ctx, link, hostname, refresh, leaseId);
  if (!claimed) {
    const latest = await getCache(ctx, link.id);
    const latestResult = resultWithoutFetch(latest, hostname, refresh, ctx.now);
    if (latestResult) return resultResponse(latestResult);
    if (latest?.hostname === hostname && latest.lease_until_ms !== null && latest.lease_until_ms > ctx.now) {
      return resultResponse({ status: 'pending', retryAfterSeconds: secondsUntil(latest.lease_until_ms, ctx.now) });
    }
    // A link edit or deletion can invalidate the saved fields while a request
    // is claiming the lease. Never fetch from a stale link snapshot.
    const saved = await getLink(ctx, link.id);
    if (!saved) throw new HttpError(404, 'not_found', '链接不存在');
    if (cachedIconHostname(saved.url, saved.icon_type, saved.icon_value) === null) {
      return resultResponse({ status: 'unsupported' });
    }
    return resultResponse({ status: 'pending', retryAfterSeconds: 1 });
  }

  const asset = await fetchProviderIcon(hostname);
  if (asset) {
    const written = await saveIcon(ctx, link, hostname, leaseId, asset);
    if (written) return resultResponse({ status: 'ready', refreshed: true });
    return staleLeaseResponse(ctx, link.id, hostname);
  }

  const written = await recordFetchFailure(ctx, link, hostname, leaseId);
  if (!written) return staleLeaseResponse(ctx, link.id, hostname);
  if (readyBytes) return resultResponse({ status: 'ready', refreshed: false });
  return resultResponse({ status: 'failed', retryAfterSeconds: NEGATIVE_COOLDOWN_MS / 1_000 });
}

function isRefreshBody(value: unknown): value is { refresh?: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.every(([key, field]) => key === 'refresh' && typeof field === 'boolean');
}

function resultResponse(result: IconCacheResult): Response {
  return jsonResponse(result);
}

function resultWithoutFetch(
  row: IconCacheRow | null,
  hostname: string,
  refresh: boolean,
  now: number,
): IconCacheResult | null {
  if (!row || row.hostname !== hostname) return null;
  const hasImage = row.status === 'ready' && row.image !== null && row.mime_type !== null;
  const leaseActive = row.lease_until_ms !== null && row.lease_until_ms > now;

  if (!refresh && hasImage) return { status: 'ready', refreshed: false };
  if (leaseActive) return { status: 'pending', retryAfterSeconds: secondsUntil(row.lease_until_ms!, now) };

  if (refresh && row.last_refresh_at_ms !== null) {
    const refreshAt = row.last_refresh_at_ms + REFRESH_COOLDOWN_MS;
    if (refreshAt > now) {
      const retryAfterSeconds = secondsUntil(refreshAt, now);
      if (hasImage) return { status: 'ready', refreshed: false, retryAfterSeconds };
      if (row.status === 'failed') return { status: 'failed', retryAfterSeconds };
      return { status: 'pending', retryAfterSeconds };
    }
  }

  if (!refresh && row.status === 'failed' && row.negative_until_ms > now) {
    return { status: 'failed', retryAfterSeconds: secondsUntil(row.negative_until_ms, now) };
  }
  return null;
}

function secondsUntil(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 1_000));
}

async function getLink(ctx: Ctx, id: string): Promise<LinkRow | null> {
  return ctx.env.DB.prepare('SELECT id, url, icon_type, icon_value FROM links WHERE id = ?1').bind(id).first<LinkRow>();
}

async function getCache(ctx: Ctx, id: string): Promise<IconCacheRow | null> {
  return ctx.env.DB.prepare(
    `SELECT link_id, hostname, status, mime_type, image, negative_until_ms,
            lease_id, lease_until_ms, last_refresh_at_ms
     FROM link_icon_cache WHERE link_id = ?1`,
  )
    .bind(id)
    .first<IconCacheRow>();
}

async function claimLease(
  ctx: Ctx,
  link: LinkRow,
  hostname: string,
  refresh: boolean,
  leaseId: string,
): Promise<boolean> {
  const row = await ctx.env.DB.prepare(
    `INSERT INTO link_icon_cache (
       link_id, hostname, status, mime_type, image, negative_until_ms,
       lease_id, lease_until_ms, last_refresh_at_ms, updated_at
     ) SELECT ?1, ?2, 'pending', NULL, NULL, 0, ?3, ?4, ?5, ?6
       WHERE EXISTS (
         SELECT 1 FROM links
         WHERE id = ?1 AND url = ?9 AND icon_type = ?10 AND icon_value = ?11
       )
     ON CONFLICT(link_id) DO UPDATE SET
       hostname = excluded.hostname,
       status = CASE
         WHEN link_icon_cache.hostname <> excluded.hostname OR link_icon_cache.image IS NULL THEN 'pending'
         ELSE 'ready'
       END,
       mime_type = CASE WHEN link_icon_cache.hostname <> excluded.hostname THEN NULL ELSE link_icon_cache.mime_type END,
       image = CASE WHEN link_icon_cache.hostname <> excluded.hostname THEN NULL ELSE link_icon_cache.image END,
       negative_until_ms = CASE WHEN link_icon_cache.hostname <> excluded.hostname THEN 0 ELSE link_icon_cache.negative_until_ms END,
       lease_id = excluded.lease_id,
       lease_until_ms = excluded.lease_until_ms,
       last_refresh_at_ms = CASE
         WHEN ?7 = 1 THEN ?8
         WHEN link_icon_cache.hostname <> excluded.hostname THEN NULL
         ELSE link_icon_cache.last_refresh_at_ms
       END,
       updated_at = excluded.updated_at
     WHERE EXISTS (
         SELECT 1 FROM links
         WHERE id = excluded.link_id AND url = ?9 AND icon_type = ?10 AND icon_value = ?11
       )
       AND (
         link_icon_cache.hostname <> excluded.hostname
         OR link_icon_cache.lease_id IS NULL
         OR link_icon_cache.lease_until_ms <= ?8
       )
       AND (
         link_icon_cache.hostname <> excluded.hostname OR ?7 = 1 OR link_icon_cache.status <> 'ready'
       )
       AND (
         link_icon_cache.hostname <> excluded.hostname OR ?7 = 1
         OR link_icon_cache.status <> 'failed' OR link_icon_cache.negative_until_ms <= ?8
       )
       AND (
         link_icon_cache.hostname <> excluded.hostname OR ?7 = 0
         OR link_icon_cache.last_refresh_at_ms IS NULL
         OR link_icon_cache.last_refresh_at_ms + ${REFRESH_COOLDOWN_MS} <= ?8
       )
     RETURNING link_id`,
  )
    .bind(
      link.id,
      hostname,
      leaseId,
      ctx.now + LEASE_MS,
      refresh ? ctx.now : null,
      ctx.nowIso,
      refresh ? 1 : 0,
      ctx.now,
      link.url,
      link.icon_type,
      link.icon_value,
    )
    .first<{ link_id: string }>();
  return row?.link_id === link.id;
}

async function saveIcon(ctx: Ctx, link: LinkRow, hostname: string, leaseId: string, asset: IconAsset): Promise<boolean> {
  const result = await ctx.env.DB.prepare(
    `UPDATE link_icon_cache
     SET status = 'ready', mime_type = ?1, image = ?2, negative_until_ms = 0,
         lease_id = NULL, lease_until_ms = NULL, updated_at = ?3
     WHERE link_id = ?4 AND hostname = ?5 AND lease_id = ?6
       AND EXISTS (
         SELECT 1 FROM links WHERE id = ?4 AND url = ?7 AND icon_type = ?8 AND icon_value = ?9
       )`,
  )
    .bind(asset.mimeType, asset.bytes, ctx.nowIso, link.id, hostname, leaseId, link.url, link.icon_type, link.icon_value)
    .run();
  return result.meta.changes > 0;
}

async function recordFetchFailure(ctx: Ctx, link: LinkRow, hostname: string, leaseId: string): Promise<boolean> {
  const result = await ctx.env.DB.prepare(
    `UPDATE link_icon_cache
     SET status = CASE WHEN image IS NULL THEN 'failed' ELSE 'ready' END,
         negative_until_ms = CASE WHEN image IS NULL THEN ?1 ELSE 0 END,
         lease_id = NULL, lease_until_ms = NULL, updated_at = ?2
     WHERE link_id = ?3 AND hostname = ?4 AND lease_id = ?5
       AND EXISTS (
         SELECT 1 FROM links WHERE id = ?3 AND url = ?6 AND icon_type = ?7 AND icon_value = ?8
       )`,
  )
    .bind(ctx.now + NEGATIVE_COOLDOWN_MS, ctx.nowIso, link.id, hostname, leaseId, link.url, link.icon_type, link.icon_value)
    .run();
  return result.meta.changes > 0;
}

async function staleLeaseResponse(ctx: Ctx, linkId: string, hostname: string): Promise<Response> {
  const link = await getLink(ctx, linkId);
  if (!link) throw new HttpError(404, 'not_found', '链接不存在');
  const currentHostname = cachedIconHostname(link.url, link.icon_type, link.icon_value);
  if (!currentHostname) {
    return resultResponse({ status: 'unsupported' });
  }
  if (currentHostname !== hostname) return resultResponse({ status: 'pending', retryAfterSeconds: 1 });
  const row = await getCache(ctx, linkId);
  if (row?.hostname === hostname && row.status === 'ready' && row.image && row.mime_type) {
    return resultResponse({ status: 'ready', refreshed: false });
  }
  const retryAfterSeconds = row?.hostname === hostname && row.lease_until_ms !== null && row.lease_until_ms > ctx.now
    ? secondsUntil(row.lease_until_ms, ctx.now)
    : 1;
  return resultResponse({ status: 'pending', retryAfterSeconds });
}

async function fetchProviderIcon(hostname: string): Promise<IconAsset | null> {
  const providers = [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`,
  ];
  for (const providerUrl of providers) {
    const asset = await fetchFromProvider(providerUrl, hostname);
    if (asset) return asset;
  }
  return null;
}

async function fetchFromProvider(initialUrl: string, targetHostname: string): Promise<IconAsset | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let currentUrl = new URL(initialUrl);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (!isAllowedProviderUrl(currentUrl, targetHostname)) return null;
      let response: Response;
      try {
        response = await fetch(currentUrl.toString(), {
          method: 'GET',
          headers: { Accept: [...ALLOWED_IMAGE_TYPES].join(', ') },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        return null;
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await cancelBody(response);
        if (!location || redirects >= MAX_REDIRECTS) return null;
        try {
          currentUrl = new URL(location, currentUrl);
        } catch {
          return null;
        }
        continue;
      }

      if (response.status !== 200) {
        await cancelBody(response);
        return null;
      }
      const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
      if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
        await cancelBody(response);
        return null;
      }
      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== null) {
        if (!/^\d+$/.test(declaredLength.trim()) || Number(declaredLength) > MAX_ICON_BYTES) {
          await cancelBody(response);
          return null;
        }
      }

      let bytes: Uint8Array;
      try {
        bytes = await readUpstreamBytes(response, MAX_ICON_BYTES);
      } catch {
        return null;
      }
      if (bytes.length === 0 || (declaredLength !== null && Number(declaredLength) !== bytes.length)) return null;
      if (!hasMatchingRasterSignature(mimeType, bytes)) return null;
      return { mimeType, bytes };
    }
  } finally {
    clearTimeout(timeout);
  }
  return null;
}

function isAllowedProviderUrl(url: URL, targetHostname: string): boolean {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  if (url.hostname === 'www.google.com' && url.pathname === '/s2/favicons') {
    return url.searchParams.get('domain') === targetHostname;
  }
  if (/^t[0-3]\.gstatic\.com$/.test(url.hostname) && url.pathname === '/faviconV2') return true;
  if (url.hostname === 'icons.duckduckgo.com' && url.pathname.startsWith('/ip3/')) {
    try {
      return decodeURIComponent(url.pathname.slice('/ip3/'.length)) === `${targetHostname}.ico`;
    } catch {
      return false;
    }
  }
  return false;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response may already have been aborted by the timeout.
  }
}

async function readUpstreamBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
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
        throw new Error('upstream icon exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream can already be canceled after the limit check.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function hasMatchingRasterSignature(mimeType: string, bytes: Uint8Array): boolean {
  const png =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  const gif =
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61;

  if (mimeType === 'image/png') return png && hasPngStructure(bytes);
  if (mimeType === 'image/jpeg') return jpeg && bytes.length >= 4 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (mimeType === 'image/webp') return webp && bytes.length >= 20 && readU32(bytes, 4) + 8 === bytes.length;
  if (mimeType === 'image/gif') return gif && bytes.length >= 14 && (bytes[6]! | (bytes[7]! << 8)) > 0 && (bytes[8]! | (bytes[9]! << 8)) > 0 && bytes.at(-1) === 0x3b;
  return (mimeType === 'image/x-icon' || mimeType === 'image/vnd.microsoft.icon') && isValidIconContainer(bytes);
}

/** Reject truncated PNGs before making them a permanent successful cache entry. */
function hasPngStructure(bytes: Uint8Array): boolean {
  if (bytes.length < 45) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return false;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > 4096 || height > 4096) return false;
  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    const next = offset + 12 + length;
    if (next > bytes.length) return false;
    if (type === 0x49444154 && length > 0) hasImageData = true;
    if (type === 0x49454e44) return length === 0 && next === bytes.length && hasImageData;
    offset = next;
  }
  return false;
}

function isValidIconContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 22 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1 || bytes[3] !== 0) return false;
  const count = bytes[4]! | (bytes[5]! << 8);
  if (count === 0 || count > 256 || 6 + count * 16 > bytes.length) return false;
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const size = readU32(bytes, offset + 8);
    const imageOffset = readU32(bytes, offset + 12);
    if (size === 0 || imageOffset < 6 + count * 16 || imageOffset + size > bytes.length) return false;
    const signatureOffset = imageOffset;
    const hasPng =
      size >= 8 &&
      bytes[signatureOffset] === 0x89 &&
      bytes[signatureOffset + 1] === 0x50 &&
      bytes[signatureOffset + 2] === 0x4e &&
      bytes[signatureOffset + 3] === 0x47 &&
      bytes[signatureOffset + 4] === 0x0d &&
      bytes[signatureOffset + 5] === 0x0a &&
      bytes[signatureOffset + 6] === 0x1a &&
      bytes[signatureOffset + 7] === 0x0a;
    const dibHeaderLength = readU32(bytes, signatureOffset);
    const hasDib = size >= 40 && [40, 52, 56, 108, 124].includes(dibHeaderLength);
    if (!hasPng && !hasDib) return false;
  }
  return true;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
}
