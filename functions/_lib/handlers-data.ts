import { BACKUP_FORMAT, BACKUP_VERSION, backupField } from '../../src/shared/backup';
import { dedupeKey, randomId } from '../../src/shared/url';
import { MAX_GROUPS, MAX_LINKS } from '../../src/shared/limits';
import type { BackupFile, BackupGroup, BackupLink, ImportResult, ImportSkipped } from '../../src/shared/types';
import { bool, list, object, optional, parseObject, str } from '../../src/shared/validate';
import {
  assertRevisionCurrent,
  executeMutation,
  getBackupSnapshot,
  nextGroupPosition,
  validationGuard,
} from './db';
import { chunkJsonItems, insertGroupsFromJson, insertLinksFromJson } from './bulk';
import { IMPORT_BODY_LIMIT, RESTORE_BODY_LIMIT, requireAuth, type Ctx } from './context';
import { HttpError, jsonResponse, readJson } from './http';
import { assertLinkIcon, linkShape, revisionField } from './handlers-content';
import { assertImageMagic, MAX_WALLPAPER_IMAGE_BYTES } from './handlers-wallpaper';

const MAX_IMPORT_GROUPS = MAX_GROUPS;
const MAX_IMPORT_LINKS = MAX_LINKS;

export async function handleExportBackup(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const { content, wallpaperImage } = await getBackupSnapshot(ctx.env.DB);
  const groups = content.groups.map(({ links: _links, ...group }) => group);
  const links = content.groups.flatMap((group) => group.links);
  return jsonResponse({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: ctx.nowIso,
    settings: content.settings,
    groups,
    links,
    ...(wallpaperImage
      ? { wallpaperImage: { mimeType: wallpaperImage.mime_type, dataBase64: encodeBase64(wallpaperImage.image) } }
      : {}),
  });
}

export async function handleRestoreBackup(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const db = ctx.env.DB;
  const body = await readJson(ctx.request, RESTORE_BODY_LIMIT);
  const input = parseObject({ revision: revisionField, backup: backupField }, body);
  const backup = input.backup;
  const wallpaperImage = decodeBackupWallpaperImage(backup.wallpaperImage);

  // 删除 + 重建 + 设置写入全部处于同一个受版本守卫保护的事务中；
  // 使用 json_each 分块批量写入，查询数量与条目数无关（D1 Free 计划限制 50 条/调用）。
  const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM links'), db.prepare('DELETE FROM groups')];
  if (wallpaperImage) {
    statements.push(
      db
        .prepare(
          `INSERT INTO wallpaper_image (id, mime_type, image, updated_at) VALUES (1, ?1, ?2, ?3)
           ON CONFLICT(id) DO UPDATE SET mime_type = excluded.mime_type, image = excluded.image, updated_at = excluded.updated_at`,
        )
        .bind(wallpaperImage.mimeType, wallpaperImage.image, ctx.nowIso),
    );
  } else {
    statements.push(db.prepare('DELETE FROM wallpaper_image WHERE id = 1'));
  }
  for (const chunk of chunkJsonItems(backup.groups)) {
    statements.push(insertGroupsFromJson(db, chunk.json));
  }
  for (const chunk of chunkJsonItems(backup.links)) {
    statements.push(insertLinksFromJson(db, chunk.json));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO settings (id, settings_json, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(backup.settings), ctx.nowIso),
  );

  const revision = await executeMutation(db, input.revision, statements, ctx.nowIso);
  return jsonResponse({ revision, groups: backup.groups.length, links: backup.links.length });
}

interface DecodedWallpaperImage {
  mimeType: string;
  image: Uint8Array;
}

function decodeBackupWallpaperImage(value: BackupFile['wallpaperImage']): DecodedWallpaperImage | null {
  if (value === undefined) return null;
  if (!value || typeof value.mimeType !== 'string' || typeof value.dataBase64 !== 'string') {
    throw new HttpError(400, 'validation_error', '备份中的壁纸数据无效');
  }
  const maxEncodedLength = Math.ceil(MAX_WALLPAPER_IMAGE_BYTES / 3) * 4;
  if (value.dataBase64.length > maxEncodedLength) throw new HttpError(413, 'payload_too_large', '备份中的壁纸图片不能超过 1,000,000 字节');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.dataBase64)) {
    throw new HttpError(400, 'validation_error', '备份中的壁纸编码无效');
  }

  let binary: string;
  try {
    binary = atob(value.dataBase64);
  } catch {
    throw new HttpError(400, 'validation_error', '备份中的壁纸编码无效');
  }
  if (btoa(binary) !== value.dataBase64) throw new HttpError(400, 'validation_error', '备份中的壁纸编码无效');
  if (binary.length === 0) throw new HttpError(400, 'validation_error', '备份中的壁纸图片不能为空');
  if (binary.length > MAX_WALLPAPER_IMAGE_BYTES) throw new HttpError(413, 'payload_too_large', '备份中的壁纸图片不能超过 1,000,000 字节');

  const image = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) image[index] = binary.charCodeAt(index);
  assertImageMagic(value.mimeType, image);
  return { mimeType: value.mimeType, image };
}

function encodeBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value as ArrayBuffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

const importLinkShape = {
  name: linkShape.name,
  url: linkShape.url,
  description: optional(linkShape.description),
  iconType: optional(linkShape.iconType),
  iconValue: optional(linkShape.iconValue),
  target: optional(linkShape.target),
};

const importShape = {
  revision: revisionField,
  groups: list(
    object({ name: str({ min: 1, max: 60, label: '分组名称' }), links: list(object(importLinkShape), { max: MAX_IMPORT_LINKS }) }),
    { max: MAX_IMPORT_GROUPS, label: '导入分组' },
  ),
  skipDuplicateUrls: optional(bool('跳过重复链接')),
};

interface PreparedLink {
  id: string;
  groupId: string;
  name: string;
  url: string;
  description: string;
  iconType: string;
  iconValue: string;
  target: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

interface PreparedGroup {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function handleImport(ctx: Ctx): Promise<Response> {
  requireAuth(ctx);
  const db = ctx.env.DB;
  const body = await readJson(ctx.request, IMPORT_BODY_LIMIT);
  const input = parseObject(importShape, body);
  const skipDuplicates = input.skipDuplicateUrls !== false;

  const totalLinks = input.groups.reduce((sum, group) => sum + group.links.length, 0);
  if (totalLinks > MAX_IMPORT_LINKS) {
    throw new HttpError(400, 'validation_error', `单次最多导入 ${MAX_IMPORT_LINKS} 个书签`);
  }

  const [existingUrlResult, linkCountResult, groupCountResult] = await db.batch([
    db.prepare('SELECT url FROM links'),
    db.prepare('SELECT COUNT(*) AS count FROM links'),
    db.prepare('SELECT COUNT(*) AS count FROM groups'),
  ]);
  const seen = new Set(((existingUrlResult?.results ?? []) as { url: string }[]).map((row) => dedupeKey(row.url)));
  const existingLinks = (linkCountResult?.results?.[0] as { count: number } | undefined)?.count ?? 0;
  const existingGroups = (groupCountResult?.results?.[0] as { count: number } | undefined)?.count ?? 0;

  const skipped: ImportSkipped[] = [];
  const preparedGroups: PreparedGroup[] = [];
  const preparedLinks: PreparedLink[] = [];
  let groupPosition = await nextGroupPosition(db);

  for (const group of input.groups) {
    const accepted: { name: string; url: string; description: string; iconType: string; iconValue: string; target: string }[] = [];
    for (const link of group.links) {
      const iconType = link.iconType ?? 'auto';
      const iconValue = link.iconValue ?? '';
      try {
        assertLinkIcon(iconType, iconValue);
      } catch {
        skipped.push({ url: link.url, name: link.name, reason: 'invalid' });
        continue;
      }
      const key = dedupeKey(link.url);
      if (skipDuplicates && seen.has(key)) {
        skipped.push({ url: link.url, name: link.name, reason: 'duplicate' });
        continue;
      }
      seen.add(key);
      accepted.push({
        name: link.name,
        url: link.url,
        description: link.description ?? '',
        iconType,
        iconValue,
        target: link.target ?? '_blank',
      });
    }
    if (accepted.length === 0) continue;
    const groupId = randomId('g_');
    preparedGroups.push({
      id: groupId,
      name: group.name,
      position: groupPosition,
      collapsed: false,
      createdAt: ctx.nowIso,
      updatedAt: ctx.nowIso,
    });
    accepted.forEach((link, index) => {
      preparedLinks.push({
        id: randomId('l_'),
        groupId,
        name: link.name,
        url: link.url,
        description: link.description,
        iconType: link.iconType,
        iconValue: link.iconValue,
        target: link.target,
        position: index,
        createdAt: ctx.nowIso,
        updatedAt: ctx.nowIso,
      });
    });
    groupPosition += 1;
  }

  // 与写入使用相同的上限：既有数量 + 本次导入数量不能超过总容量
  if (existingGroups + preparedGroups.length > MAX_GROUPS) {
    throw new HttpError(400, 'validation_error', `导入后分组数量将超过上限（${MAX_GROUPS}），请先清理现有分组`);
  }
  if (existingLinks + preparedLinks.length > MAX_LINKS) {
    throw new HttpError(400, 'validation_error', `导入后链接数量将超过上限（${MAX_LINKS}），请先清理现有链接`);
  }

  if (preparedGroups.length === 0) {
    // 空导入不写入内容，但陈旧版本号仍必须被拒绝
    await assertRevisionCurrent(db, input.revision);
    const result: ImportResult = { revision: input.revision, createdGroups: 0, createdLinks: 0, skipped };
    return jsonResponse(result);
  }

  const statements: D1PreparedStatement[] = [
    // 事务内再次断言容量（防止并发导入共同越过上限）
    validationGuard(db, '(SELECT COUNT(*) FROM groups) + ?1 > ?2', [preparedGroups.length, MAX_GROUPS]),
    validationGuard(db, '(SELECT COUNT(*) FROM links) + ?1 > ?2', [preparedLinks.length, MAX_LINKS]),
  ];
  for (const chunk of chunkJsonItems(preparedGroups)) {
    statements.push(insertGroupsFromJson(db, chunk.json));
  }
  for (const chunk of chunkJsonItems(preparedLinks)) {
    statements.push(insertLinksFromJson(db, chunk.json));
  }

  const revision = await executeMutation(db, input.revision, statements, ctx.nowIso, {
    validationMessage: '导入后内容数量将超过上限，请先清理现有内容',
  });
  const result: ImportResult = { revision, createdGroups: preparedGroups.length, createdLinks: preparedLinks.length, skipped };
  return jsonResponse(result);
}

export type { BackupGroup, BackupLink };
