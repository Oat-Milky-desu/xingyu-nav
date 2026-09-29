import { describe, expect, it } from 'vitest';
import { wallpaperCropGeometry, wallpaperDimensionError, wallpaperFileError } from '../../src/utils/wallpaper';

describe('壁纸上传限制', () => {
  it('只接受非空且不超过 20 MB 的 JPEG、PNG 和 WebP 原图', () => {
    expect(wallpaperFileError({ type: 'image/jpeg', size: 100 })).toBeNull();
    expect(wallpaperFileError({ type: 'image/png', size: 100 })).toBeNull();
    expect(wallpaperFileError({ type: 'image/webp', size: 100 })).toBeNull();
    expect(wallpaperFileError({ type: 'image/gif', size: 100 })).toMatch(/JPEG、PNG 或 WebP/);
    expect(wallpaperFileError({ type: 'image/jpeg', size: 0 })).toMatch(/为空/);
    expect(wallpaperFileError({ type: 'image/jpeg', size: 20_000_001 })).toMatch(/20 MB/);
  });

  it('拒绝无效和极大的图片尺寸', () => {
    expect(wallpaperDimensionError(1920, 1080)).toBeNull();
    expect(wallpaperDimensionError(0, 1080)).toMatch(/尺寸/);
    expect(wallpaperDimensionError(12_001, 100)).toMatch(/尺寸过大/);
    expect(wallpaperDimensionError(9000, 7000)).toMatch(/尺寸过大/);
  });

  it('同宽高比图片在放大后仍按水平与垂直焦点移动', () => {
    const left = wallpaperCropGeometry(160, 90, 1600, 900, 0, 0, 2);
    const center = wallpaperCropGeometry(160, 90, 1600, 900, 50, 50, 2);
    const right = wallpaperCropGeometry(160, 90, 1600, 900, 100, 100, 2);

    expect(left).toEqual({ width: 320, height: 180, left: 0, top: 0 });
    expect(center).toEqual({ width: 320, height: 180, left: -80, top: -45 });
    expect(right).toEqual({ width: 320, height: 180, left: -160, top: -90 });
  });

  it('初始缩放时也能在 cover 裁切出的溢出区域移动焦点', () => {
    const top = wallpaperCropGeometry(160, 90, 900, 1600, 50, 0, 1);
    const bottom = wallpaperCropGeometry(160, 90, 900, 1600, 50, 100, 1);

    expect(top?.width).toBe(160);
    expect(top?.left).toBe(0);
    expect(top?.top).toBe(0);
    expect(bottom?.top).toBeLessThan(top?.top ?? 0);
  });
});
