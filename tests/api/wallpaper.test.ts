import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, seedAdmin, type Harness } from './helpers';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { BackupFile, ContentPayload } from '../../src/shared/types';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

async function authedHarness(): Promise<Harness> {
  await resetDatabase();
  await seedAdmin();
  const harness = createHarness();
  await harness.expectOk(await harness.login());
  return harness;
}

function wallpaperForm(revision: number, settings: ContentPayload['settings'], image: Uint8Array, mimeType: string): FormData {
  const form = new FormData();
  form.set('revision', String(revision));
  form.set('settings', JSON.stringify(settings));
  form.set('image', new Blob([image.slice().buffer], { type: mimeType }), 'wallpaper');
  return form;
}

async function expectImage(response: Response, expectedMimeType: string, expected: Uint8Array): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(expectedMimeType);
  const actual = new Uint8Array(await response.arrayBuffer());
  expect([...actual]).toEqual([...expected]);
}

describe('上传壁纸 API', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('壁纸读取和上传都要求登录；写入还校验 CSRF 与 multipart 格式', async () => {
    const anonymous = createHarness();
    const get = await anonymous.call('/api/wallpaper');
    expect(get.status).toBe(401);
    expect(get.headers.get('content-type')).toContain('application/json');
    expect(get.headers.get('cache-control')).toContain('no-store');

    const anonymousPut = await anonymous.call('/api/wallpaper', {
      method: 'PUT',
      formData: wallpaperForm(0, DEFAULT_SETTINGS, JPEG, 'image/jpeg'),
    });
    expect(anonymousPut.status).toBe(401);
    expect(anonymousPut.headers.get('content-type')).toContain('application/json');

    await seedAdmin();
    const harness = createHarness();
    await harness.expectOk(await harness.login());
    const content = await harness.getContent();
    const form = wallpaperForm(content.revision, content.settings, JPEG, 'image/jpeg');

    const noCsrf = await harness.call('/api/wallpaper', { method: 'PUT', formData: form, csrf: null });
    expect(noCsrf.status).toBe(403);

    const crossOrigin = await harness.call('/api/wallpaper', {
      method: 'PUT',
      formData: form,
      origin: 'https://attacker.example.net',
    });
    expect(crossOrigin.status).toBe(403);

    const malformed = await harness.call('/api/wallpaper', {
      method: 'PUT',
      rawBody: 'not multipart data',
      contentType: 'multipart/form-data; boundary=broken',
    });
    expect(malformed.status).toBe(400);

    const wrongContentType = await harness.call('/api/wallpaper', {
      method: 'PUT',
      body: { revision: content.revision, settings: content.settings },
    });
    expect(wrongContentType.status).toBe(415);
  });

  it('限制请求和图片大小，并检查声明格式对应的图片签名', async () => {
    const harness = await authedHarness();
    const content = await harness.getContent();
    const wrongMagic = await harness.call('/api/wallpaper', {
      method: 'PUT',
      formData: wallpaperForm(content.revision, content.settings, Uint8Array.from([1, 2, 3, 4]), 'image/png'),
    });
    expect(wrongMagic.status).toBe(400);

    const tooLargeImage = new Uint8Array(1_000_001);
    tooLargeImage.set([0xff, 0xd8, 0xff]);
    const imageLimit = await harness.call('/api/wallpaper', {
      method: 'PUT',
      formData: wallpaperForm(content.revision, content.settings, tooLargeImage, 'image/jpeg'),
    });
    expect(imageLimit.status).toBe(413);

    const requestLimit = await harness.call('/api/wallpaper', {
      method: 'PUT',
      rawBody: 'x'.repeat(1_200_001),
      contentType: 'multipart/form-data; boundary=large',
    });
    expect(requestLimit.status).toBe(413);
  });

  it('上传后返回更新设置并可通过受保护图片接口读取；过期版本不会覆盖图片', async () => {
    const harness = await authedHarness();
    const initial = await harness.getContent();
    const settings = {
      ...initial.settings,
      wallpaperMode: 'upload' as const,
      wallpaperDesktopX: 23,
      wallpaperDesktopY: 41,
      wallpaperDesktopZoom: 1.4,
      wallpaperMobileX: 67,
      wallpaperMobileY: 32,
      wallpaperMobileZoom: 1.8,
    };
    const upload = await harness.call('/api/wallpaper', {
      method: 'PUT',
      formData: wallpaperForm(initial.revision, settings, JPEG, 'image/jpeg'),
    });
    expect(upload.status).toBe(200);
    const result = await harness.expectOk<{ revision: number; settings: ContentPayload['settings'] }>(upload);
    expect(result.revision).toBe(initial.revision + 1);
    expect(result.settings).toEqual(settings);

    const image = await harness.call('/api/wallpaper');
    expect(image.headers.get('cache-control')).toContain('no-store');
    expect(image.headers.get('cache-control')).toContain('private');
    expect(image.headers.get('vary')).toContain('Cookie');
    await expectImage(image, 'image/jpeg', JPEG);

    const secondSession = createHarness();
    await secondSession.expectOk(await secondSession.login());
    await expectImage(await secondSession.call('/api/wallpaper'), 'image/jpeg', JPEG);

    const stale = await harness.call('/api/wallpaper', {
      method: 'PUT',
      formData: wallpaperForm(initial.revision, initial.settings, WEBP, 'image/webp'),
    });
    expect(stale.status).toBe(409);
    expect((await harness.getContent()).revision).toBe(result.revision);
    await expectImage(await harness.call('/api/wallpaper'), 'image/jpeg', JPEG);
  });

  it('备份往返恢复图片；旧格式备份缺少图片时会删除当前上传图片', async () => {
    const harness = await authedHarness();
    let content = await harness.getContent();
    const uploadedSettings = { ...content.settings, wallpaperMode: 'upload' as const };
    await harness.expectOk(
      await harness.call('/api/wallpaper', {
        method: 'PUT',
        formData: wallpaperForm(content.revision, uploadedSettings, JPEG, 'image/jpeg'),
      }),
    );
    const backup = await harness.json<BackupFile>(await harness.call('/api/backup'));
    expect(backup.wallpaperImage).toEqual({ mimeType: 'image/jpeg', dataBase64: btoa(String.fromCharCode(...JPEG)) });

    const invalidImageBackup = {
      ...backup,
      wallpaperImage: { mimeType: 'image/jpeg' as const, dataBase64: btoa('not a jpeg') },
    };
    content = await harness.getContent();
    const rejected = await harness.call('/api/restore', {
      body: { revision: content.revision, backup: invalidImageBackup },
    });
    expect(rejected.status).toBe(400);
    await expectImage(await harness.call('/api/wallpaper'), 'image/jpeg', JPEG);

    content = await harness.getContent();
    await harness.expectOk(
      await harness.call('/api/wallpaper', {
        method: 'PUT',
        formData: wallpaperForm(content.revision, content.settings, WEBP, 'image/webp'),
      }),
    );
    content = await harness.getContent();
    const restored = await harness.call('/api/restore', { body: { revision: content.revision, backup } });
    expect(restored.status).toBe(200);
    await expectImage(await harness.call('/api/wallpaper'), 'image/jpeg', JPEG);

    const oldBackup = { ...backup } as BackupFile & { wallpaperImage?: unknown };
    delete oldBackup.wallpaperImage;
    content = await harness.getContent();
    const remove = await harness.call('/api/restore', { body: { revision: content.revision, backup: oldBackup } });
    expect(remove.status).toBe(200);
    expect((await harness.call('/api/wallpaper')).status).toBe(404);
  });
});
