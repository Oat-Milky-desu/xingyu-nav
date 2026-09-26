import { parseSettings } from '../../src/shared/settings';
import { parseObject } from '../../src/shared/validate';
import { baseHeaders, HttpError, jsonResponse } from './http';
import { executeMutation, getWallpaperImage } from './db';
import { requireAuth, type Ctx } from './context';
import { revisionField } from './handlers-content';

export const MAX_WALLPAPER_IMAGE_BYTES = 1_000_000;
export const MAX_WALLPAPER_REQUEST_BYTES = 1_200_000;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function handleGetWallpaper(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const row = await getWallpaperImage(ctx.env.DB);
  if (!row) throw new HttpError(404, 'not_found', '尚未上传壁纸');

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

export async function handlePutWallpaper(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const body = await readBoundedBody(ctx.request, MAX_WALLPAPER_REQUEST_BYTES);
  const contentType = ctx.request.headers.get('content-type') ?? '';

  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new HttpError(400, 'validation_error', '壁纸上传表单格式无效');
  }

  assertFormShape(form);
  const revisionText = form.get('revision');
  const settingsText = form.get('settings');
  const imageFile = form.get('image');
  if (typeof revisionText !== 'string' || typeof settingsText !== 'string' || typeof imageFile === 'string' || imageFile === null) {
    throw new HttpError(400, 'validation_error', '壁纸上传字段无效');
  }

  if (!/^(0|[1-9]\d*)$/.test(revisionText)) {
    throw new HttpError(400, 'validation_error', '版本号格式无效');
  }
  const revisionValue = Number(revisionText);
  const { revision } = parseObject({ revision: revisionField }, { revision: revisionValue });

  let settingsValue: unknown;
  try {
    settingsValue = JSON.parse(settingsText) as unknown;
  } catch {
    throw new HttpError(400, 'validation_error', '壁纸设置不是合法的 JSON');
  }
  const settings = parseSettings(settingsValue);

  if (imageFile.size === 0) throw new HttpError(400, 'validation_error', '壁纸图片不能为空');
  if (imageFile.size > MAX_WALLPAPER_IMAGE_BYTES) throw new HttpError(413, 'payload_too_large', '壁纸图片不能超过 1,000,000 字节');
  const mimeType = imageFile.type.toLowerCase();
  if (!IMAGE_TYPES.has(mimeType)) throw new HttpError(400, 'validation_error', '壁纸仅支持 JPEG、PNG 或 WebP 图片');
  const image = new Uint8Array(await imageFile.arrayBuffer());
  assertImageMagic(mimeType, image);

  const db = ctx.env.DB;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO wallpaper_image (id, mime_type, image, updated_at) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET mime_type = excluded.mime_type, image = excluded.image, updated_at = excluded.updated_at`,
      )
      .bind(mimeType, image, ctx.nowIso),
    db
      .prepare(
        `INSERT INTO settings (id, settings_json, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(settings), ctx.nowIso),
  ];
  const nextRevision = await executeMutation(db, revision, statements, ctx.nowIso);
  return jsonResponse({ revision: nextRevision, settings });
}

function assertFormShape(form: FormData): void {
  const allowed = new Set(['revision', 'settings', 'image']);
  let fieldCount = 0;
  for (const key of form.keys()) {
    fieldCount += 1;
    if (!allowed.has(key)) throw new HttpError(400, 'validation_error', '壁纸上传包含未知字段');
  }
  if (fieldCount !== allowed.size || [...allowed].some((key) => form.getAll(key).length !== 1)) {
    throw new HttpError(400, 'validation_error', '壁纸上传字段缺失或重复');
  }
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new HttpError(400, 'validation_error', '请求体长度无效');
    if (Number(contentLength) > maxBytes) throw new HttpError(413, 'payload_too_large', '请求体过大');
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
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
        throw new HttpError(413, 'payload_too_large', '请求体过大');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 读取器在超限分支已取消。
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function assertImageMagic(mimeType: string, image: Uint8Array): void {
  const isJpeg = mimeType === 'image/jpeg' && image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const isPng =
    mimeType === 'image/png' &&
    image.length >= 8 &&
    image[0] === 0x89 &&
    image[1] === 0x50 &&
    image[2] === 0x4e &&
    image[3] === 0x47 &&
    image[4] === 0x0d &&
    image[5] === 0x0a &&
    image[6] === 0x1a &&
    image[7] === 0x0a;
  const isWebp =
    mimeType === 'image/webp' &&
    image.length >= 12 &&
    image[0] === 0x52 &&
    image[1] === 0x49 &&
    image[2] === 0x46 &&
    image[3] === 0x46 &&
    image[8] === 0x57 &&
    image[9] === 0x45 &&
    image[10] === 0x42 &&
    image[11] === 0x50;
  if (!isJpeg && !isPng && !isWebp) {
    throw new HttpError(400, 'validation_error', '壁纸图片内容与声明的格式不匹配');
  }
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value as ArrayBuffer);
}
