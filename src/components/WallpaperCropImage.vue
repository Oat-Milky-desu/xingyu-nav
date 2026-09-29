<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import { wallpaperCropGeometry } from '../utils/wallpaper';

const props = withDefaults(
  defineProps<{
    src: string;
    x: number;
    y: number;
    zoom: number;
    alt?: string;
  }>(),
  { alt: '' },
);

const frame = ref<HTMLElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
const geometry = ref<ReturnType<typeof wallpaperCropGeometry>>(null);
let resizeObserver: ResizeObserver | null = null;

const imageStyle = computed<CSSProperties>(() => {
  const current = geometry.value;
  if (!current) return {};
  return {
    left: `${current.left}px`,
    top: `${current.top}px`,
    width: `${current.width}px`,
    height: `${current.height}px`,
  };
});

function updateGeometry(): void {
  const frameElement = frame.value;
  const imageElement = image.value;
  if (!frameElement || !imageElement?.naturalWidth || !imageElement.naturalHeight) {
    geometry.value = null;
    return;
  }
  const bounds = frameElement.getBoundingClientRect();
  geometry.value = wallpaperCropGeometry(
    bounds.width,
    bounds.height,
    imageElement.naturalWidth,
    imageElement.naturalHeight,
    props.x,
    props.y,
    props.zoom,
  );
}

watch(
  () => props.src,
  () => {
    geometry.value = null;
    void nextTick(updateGeometry);
  },
  { flush: 'post' },
);

watch(
  () => [props.x, props.y, props.zoom],
  updateGeometry,
  { flush: 'post' },
);

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(updateGeometry);
    if (frame.value) resizeObserver.observe(frame.value);
  } else {
    window.addEventListener('resize', updateGeometry);
  }
  updateGeometry();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', updateGeometry);
});
</script>

<template>
  <div ref="frame" class="wallpaper-crop-image">
    <img ref="image" :src="src" :alt="alt" :style="imageStyle" @load="updateGeometry" />
  </div>
</template>

<style scoped>
.wallpaper-crop-image {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.wallpaper-crop-image img {
  position: absolute;
  display: block;
  max-width: none;
  object-fit: fill;
}
</style>
