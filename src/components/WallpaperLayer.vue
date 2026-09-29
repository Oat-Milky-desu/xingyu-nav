<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { effectiveSettings, previewState } from '../stores/preview';
import { contentState } from '../stores/content';
import WallpaperCropImage from './WallpaperCropImage.vue';
import { isHttpUrl } from '../shared/url';

const imageUrl = computed(() => {
  if (effectiveSettings.value.wallpaperMode === 'upload') {
    if (previewState.wallpaperUrl) return previewState.wallpaperUrl;
    return `/api/wallpaper?v=${contentState.revision}`;
  }
  const url = effectiveSettings.value.wallpaperUrl.trim();
  return url && isHttpUrl(url) ? url : '';
});
const mobileViewport = ref(false);
let breakpoint: MediaQueryList | null = null;

function updateViewport(): void {
  mobileViewport.value = breakpoint?.matches ?? window.innerWidth <= 640;
}

onMounted(() => {
  if (typeof window.matchMedia === 'function') {
    breakpoint = window.matchMedia('(max-width: 640px)');
    updateViewport();
    breakpoint.addEventListener('change', updateViewport);
  } else {
    updateViewport();
    window.addEventListener('resize', updateViewport);
  }
});

onBeforeUnmount(() => {
  breakpoint?.removeEventListener('change', updateViewport);
  window.removeEventListener('resize', updateViewport);
});

</script>

<template>
  <div class="wallpaper" aria-hidden="true">
    <div class="wallpaper-glow"></div>
    <div v-if="imageUrl" class="wallpaper-image">
      <WallpaperCropImage
        :src="imageUrl"
        :x="mobileViewport ? effectiveSettings.wallpaperMobileX : effectiveSettings.wallpaperDesktopX"
        :y="mobileViewport ? effectiveSettings.wallpaperMobileY : effectiveSettings.wallpaperDesktopY"
        :zoom="mobileViewport ? effectiveSettings.wallpaperMobileZoom : effectiveSettings.wallpaperDesktopZoom"
      />
    </div>
    <div class="wallpaper-overlay"></div>
  </div>
</template>

<style scoped>
.wallpaper {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  background:
    radial-gradient(1100px 720px at 10% 4%, rgba(78, 224, 181, 0.22), transparent 62%),
    radial-gradient(900px 640px at 92% 10%, rgba(64, 140, 255, 0.24), transparent 64%),
    radial-gradient(760px 620px at 70% 92%, rgba(129, 91, 255, 0.16), transparent 66%),
    linear-gradient(158deg, var(--bg-deep) 0%, var(--bg-mid) 52%, var(--bg-deep) 100%);
}

.wallpaper-glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(60% 50% at 50% 0%, rgba(255, 255, 255, 0.06), transparent 70%);
}

.wallpaper-image {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.wallpaper-overlay {
  position: absolute;
  inset: 0;
  background: var(--bg-deep);
  opacity: var(--overlay-opacity, 0.45);
  transition: opacity 0.3s ease;
}
</style>
