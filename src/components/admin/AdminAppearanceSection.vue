<script setup lang="ts">
import { computed, ref } from 'vue';
import { CARD_SIZES, THEMES } from '../../shared/search-engines';
import type { AppSettings } from '../../shared/types';
import { isHttpUrl } from '../../shared/url';
import WallpaperCropImage from '../WallpaperCropImage.vue';
import { contentState } from '../../stores/content';
import { wallpaperFileError } from '../../utils/wallpaper';

const props = defineProps<{
  settings: AppSettings;
  wallpaperPreviewUrl: string | null;
  wallpaperProcessing: boolean;
}>();

const emit = defineEmits<{
  (event: 'update', patch: Partial<AppSettings>): void;
  (event: 'wallpaper-selected', file: File): void;
}>();

type CropDevice = 'Desktop' | 'Mobile';
type CropAxis = 'X' | 'Y' | 'Zoom';
type CropKey =
  | 'wallpaperDesktopX'
  | 'wallpaperDesktopY'
  | 'wallpaperDesktopZoom'
  | 'wallpaperMobileX'
  | 'wallpaperMobileY'
  | 'wallpaperMobileZoom';

const cropDevices: { id: CropDevice; title: string; description: string }[] = [
  { id: 'Desktop', title: '电脑端', description: '宽屏预览' },
  { id: 'Mobile', title: '手机端', description: '竖屏预览' },
];
const imageError = ref('');

const previewSource = computed(() => {
  if (props.settings.wallpaperMode === 'upload') {
    if (props.wallpaperPreviewUrl) return props.wallpaperPreviewUrl;
    return `/api/wallpaper?v=${contentState.revision}`;
  }
  const url = props.settings.wallpaperUrl.trim();
  return url && isHttpUrl(url) ? url : '';
});

function text(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

function number(event: Event): number {
  return Number((event.target as HTMLInputElement).value);
}

function cropKey(device: CropDevice, axis: CropAxis): CropKey {
  return `wallpaper${device}${axis}` as CropKey;
}

function updateCrop(device: CropDevice, axis: CropAxis, event: Event): void {
  const key = cropKey(device, axis);
  emit('update', { [key]: number(event) } as Pick<AppSettings, CropKey>);
}

function cropValue(device: CropDevice, axis: CropAxis): number {
  return props.settings[cropKey(device, axis)];
}

function chooseWallpaper(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  const fileError = wallpaperFileError(file);
  if (fileError) {
    imageError.value = fileError;
    return;
  }

  imageError.value = '';
  emit('wallpaper-selected', file);
}
</script>

<template>
  <div class="stack">
    <div class="field">
      <span>主题</span>
      <div class="row" role="radiogroup" aria-label="主题">
        <label v-for="theme in THEMES" :key="theme.value" class="option-chip">
          <input
            type="radio"
            name="theme"
            :value="theme.value"
            :checked="settings.theme === theme.value"
            @change="emit('update', { theme: theme.value })"
          />
          <span>{{ theme.label }}</span>
        </label>
      </div>
    </div>

    <fieldset class="field wallpaper-settings">
      <legend>壁纸</legend>
      <div class="row wallpaper-modes" role="radiogroup" aria-label="壁纸来源">
        <label class="option-chip">
          <input
            type="radio"
            name="wallpaper-mode"
            value="url"
            :checked="settings.wallpaperMode === 'url'"
            @change="emit('update', { wallpaperMode: 'url' })"
          />
          <span>网络图片</span>
        </label>
        <label class="option-chip">
          <input
            type="radio"
            name="wallpaper-mode"
            value="upload"
            :checked="settings.wallpaperMode === 'upload'"
            @change="emit('update', { wallpaperMode: 'upload' })"
          />
          <span>上传图片</span>
        </label>
      </div>

      <label v-if="settings.wallpaperMode === 'url'" class="field">
        <span>壁纸地址（可选）</span>
        <input
          class="input"
          type="url"
          inputmode="url"
          maxlength="2048"
          :value="settings.wallpaperUrl"
          placeholder="https://example.com/wallpaper.jpg（留空使用内置渐变背景）"
          @input="emit('update', { wallpaperUrl: text($event) })"
        />
        <span class="field-hint">支持 http(s) 图片地址，也可以使用下方预览调整电脑和手机的裁切位置。</span>
      </label>

      <div v-else class="field">
        <label for="wallpaper-file">选择壁纸图片</label>
        <input
          id="wallpaper-file"
          class="input file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          :disabled="wallpaperProcessing"
          @change="chooseWallpaper"
        />
        <span class="field-hint">支持 JPEG、PNG、WebP；原图最大 20 MB，上传前会在浏览器中压缩到 1 MB 以内。</span>
        <span v-if="wallpaperProcessing" class="field-hint" role="status">正在读取并压缩图片…</span>
        <span v-if="imageError" class="form-error" role="alert">{{ imageError }}</span>
      </div>

      <div class="crop-grid" aria-label="壁纸裁切预览">
        <fieldset v-for="device in cropDevices" :key="device.id" class="crop-card">
          <legend>
            <span>{{ device.title }}</span>
            <small>{{ device.description }}</small>
          </legend>
          <div class="crop-frame" :class="device.id === 'Mobile' ? 'mobile-frame' : 'desktop-frame'">
            <WallpaperCropImage
              v-if="previewSource"
              :src="previewSource"
              :x="cropValue(device.id, 'X')"
              :y="cropValue(device.id, 'Y')"
              :zoom="cropValue(device.id, 'Zoom')"
            />
            <span v-else class="empty-preview">添加壁纸后显示裁切预览</span>
          </div>
          <label class="crop-control">
            <span>水平位置 <output>{{ cropValue(device.id, 'X') }}%</output></span>
            <input
              :aria-label="`${device.title}壁纸水平位置`"
              type="range"
              min="0"
              max="100"
              step="1"
              :value="cropValue(device.id, 'X')"
              @input="updateCrop(device.id, 'X', $event)"
            />
          </label>
          <label class="crop-control">
            <span>垂直位置 <output>{{ cropValue(device.id, 'Y') }}%</output></span>
            <input
              :aria-label="`${device.title}壁纸垂直位置`"
              type="range"
              min="0"
              max="100"
              step="1"
              :value="cropValue(device.id, 'Y')"
              @input="updateCrop(device.id, 'Y', $event)"
            />
          </label>
          <label class="crop-control">
            <span>缩放 <output>{{ cropValue(device.id, 'Zoom').toFixed(2) }}×</output></span>
            <input
              :aria-label="`${device.title}壁纸缩放`"
              type="range"
              min="1"
              max="3"
              step="0.05"
              :value="cropValue(device.id, 'Zoom')"
              @input="updateCrop(device.id, 'Zoom', $event)"
            />
          </label>
        </fieldset>
      </div>
    </fieldset>

    <label class="field">
      <span>壁纸遮罩不透明度：{{ Math.round(settings.overlayOpacity * 100) }}%</span>
      <input
        type="range"
        min="0"
        max="0.9"
        step="0.05"
        :value="settings.overlayOpacity"
        @input="emit('update', { overlayOpacity: number($event) })"
      />
      <span class="field-hint">数值越大，壁纸越暗、文字越清晰。</span>
    </label>

    <label class="field">
      <span>卡片不透明度：{{ Math.round(settings.cardOpacity * 100) }}%</span>
      <input
        type="range"
        min="0.05"
        max="1"
        step="0.05"
        :value="settings.cardOpacity"
        @input="emit('update', { cardOpacity: number($event) })"
      />
    </label>

    <label class="field">
      <span>毛玻璃模糊：{{ settings.glassBlur }}px</span>
      <input
        type="range"
        min="0"
        max="30"
        step="1"
        :value="settings.glassBlur"
        @input="emit('update', { glassBlur: number($event) })"
      />
    </label>

    <label class="field">
      <span>卡片尺寸</span>
      <select class="select" :value="settings.cardSize" @change="emit('update', { cardSize: ($event.target as HTMLSelectElement).value as AppSettings['cardSize'] })">
        <option v-for="size in CARD_SIZES" :key="size.value" :value="size.value">
          {{ size.label }}{{ size.hint ? ` — ${size.hint}` : '' }}
        </option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.option-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  font-size: 0.88rem;
}

.option-chip:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.wallpaper-settings,
.crop-card {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.wallpaper-settings > legend {
  margin-bottom: 10px;
  font-weight: 600;
}

.wallpaper-modes {
  margin-bottom: 14px;
}

.file-input {
  padding: 9px;
}

.crop-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 8px;
}

.crop-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.025);
}

.crop-card > legend {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 0;
  font-weight: 600;
}

.crop-card > legend small {
  color: var(--text-muted);
  font-size: 0.78rem;
  font-weight: 400;
}

.crop-frame {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background:
    radial-gradient(70% 80% at 20% 10%, rgba(78, 224, 181, 0.17), transparent 70%),
    linear-gradient(145deg, var(--bg-mid), var(--bg-deep));
}

.desktop-frame {
  aspect-ratio: 16 / 9;
}

.mobile-frame {
  width: min(100%, 190px);
  aspect-ratio: 9 / 15;
  align-self: center;
}

.empty-preview {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 10px;
  color: var(--text-muted);
  font-size: 0.82rem;
  text-align: center;
}

.crop-control {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.82rem;
}

.crop-control span {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.crop-control output {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 700px) {
  .crop-grid {
    grid-template-columns: 1fr;
  }
}
</style>
