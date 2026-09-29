const MAX_INPUT_BYTES = 20 * 1_000_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_SOURCE_EDGE = 12_000;
const MAX_SOURCE_PIXELS = 60_000_000;
const MAX_OUTPUT_EDGE = 2_560;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface WallpaperCropGeometry {
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Size the image to cover the frame first, then apply zoom and pan within the
 * resulting overflow. This keeps X/Y useful even when the source and frame
 * have the same aspect ratio.
 */
export function wallpaperCropGeometry(
  frameWidth: number,
  frameHeight: number,
  imageWidth: number,
  imageHeight: number,
  x: number,
  y: number,
  zoom: number,
): WallpaperCropGeometry | null {
  if (
    ![frameWidth, frameHeight, imageWidth, imageHeight, x, y, zoom].every(Number.isFinite) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    zoom < 1
  ) {
    return null;
  }

  const coverScale = Math.max(frameWidth / imageWidth, frameHeight / imageHeight);
  const width = imageWidth * coverScale * zoom;
  const height = imageHeight * coverScale * zoom;
  const positionX = Math.max(0, Math.min(100, x)) / 100;
  const positionY = Math.max(0, Math.min(100, y)) / 100;
  const left = (frameWidth - width) * positionX;
  const top = (frameHeight - height) * positionY;
  return {
    width,
    height,
    left: left === 0 ? 0 : left,
    top: top === 0 ? 0 : top,
  };
}

export function wallpaperFileError(file: Pick<File, 'size' | 'type'>): string | null {
  if (!ACCEPTED_TYPES.has(file.type)) return '请选择 JPEG、PNG 或 WebP 图片。';
  if (file.size <= 0) return '所选图片为空。';
  if (file.size > MAX_INPUT_BYTES) return '图片不能超过 20 MB。';
  return null;
}

export function wallpaperDimensionError(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return '无法读取图片尺寸。';
  if (width > MAX_SOURCE_EDGE || height > MAX_SOURCE_EDGE || width * height > MAX_SOURCE_PIXELS) {
    return '图片尺寸过大，请先缩小后再上传（最长边不能超过 12000 像素）。';
  }
  return null;
}

/** Decode and re-encode an image locally so the upload stays within the Worker limit. */
export async function optimizeWallpaper(file: File): Promise<File> {
  const fileError = wallpaperFileError(file);
  if (fileError) throw new Error(fileError);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('无法读取图片，请确认文件没有损坏。');
  }

  try {
    const { width, height } = bitmap;
    const dimensionError = wallpaperDimensionError(width, height);
    if (dimensionError) throw new Error(dimensionError);

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法处理这张图片。');

    let scale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(width, height));
    let outputType: 'image/webp' | 'image/jpeg' | null = null;
    const qualities = [0.84, 0.74, 0.64, 0.54, 0.44, 0.34, 0.25];

    for (let round = 0; round < 12; round += 1) {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      if (!outputType) {
        const webp = await encodeCanvas(canvas, 'image/webp', qualities[0]!);
        if (webp.type === 'image/webp') {
          outputType = 'image/webp';
          if (webp.size <= MAX_OUTPUT_BYTES) return makeFile(webp, outputType);
        } else {
          const jpeg = await encodeCanvas(canvas, 'image/jpeg', qualities[0]!);
          if (jpeg.type !== 'image/jpeg') throw new Error('浏览器无法生成兼容的壁纸图片。');
          outputType = 'image/jpeg';
          if (jpeg.size <= MAX_OUTPUT_BYTES) return makeFile(jpeg, outputType);
        }
      }

      for (const quality of qualities.slice(1)) {
        const blob = await encodeCanvas(canvas, outputType, quality);
        if (blob.type === outputType && blob.size <= MAX_OUTPUT_BYTES) return makeFile(blob, outputType);
      }
      scale *= 0.82;
    }

    throw new Error('图片无法压缩到 1 MB 以内，请选择尺寸较小或细节较少的图片。');
  } finally {
    bitmap.close();
  }
}

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('图片压缩失败，请重试。'));
    }, type, quality);
  });
}

function makeFile(blob: Blob, type: 'image/webp' | 'image/jpeg'): File {
  const extension = type === 'image/webp' ? 'webp' : 'jpg';
  return new File([blob], `wallpaper.${extension}`, { type, lastModified: Date.now() });
}
