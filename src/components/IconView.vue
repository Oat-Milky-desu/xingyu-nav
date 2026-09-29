<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { resolveSavedIcon, supportsSavedIconCache } from '../api/icon-cache';
import { getSessionEpoch } from '../api/client';
import { builtinIcon } from '../shared/icons';
import { colorFromString, faviconCandidatesFor, initialOf } from '../shared/url';
import type { IconType } from '../shared/types';
import { toastError, toastSuccess, showToast } from '../stores/ui';

const props = defineProps<{
  name: string;
  url: string;
  iconType: IconType;
  iconValue: string;
  linkId?: string;
  size?: 'sm' | 'md' | 'lg';
}>();

const emit = defineEmits<{
  (event: 'refresh-state', busy: boolean): void;
}>();

const failed = ref(false);
const candidateIndex = ref(0);
const requestVersion = ref(0);
const currentImage = ref<HTMLImageElement | null>(null);
const cacheResolveAttempted = ref(false);
const cacheStatus = ref<'idle' | 'pending' | 'ready' | 'failed' | 'unsupported'>('idle');
const imageNonce = ref(0);
const pendingPollCount = ref(0);
const refreshBusy = ref(false);
const loadedCachedImage = ref(false);
const requestSessionEpoch = ref(getSessionEpoch());
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
let requestGeneration = 0;

const MAX_PENDING_IMAGE_POLLS = 20;
const PENDING_IMAGE_POLL_MS = 1000;

watch(
  [() => props.linkId, () => props.iconType, () => props.iconValue, () => props.url],
  () => {
    requestGeneration += 1;
    clearPendingTimer();
    requestVersion.value += 1;
    candidateIndex.value = 0;
    failed.value = false;
    cacheResolveAttempted.value = false;
    cacheStatus.value = 'idle';
    imageNonce.value = 0;
    pendingPollCount.value = 0;
    refreshBusy.value = false;
    loadedCachedImage.value = false;
    requestSessionEpoch.value = getSessionEpoch();
    emit('refresh-state', false);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  disposed = true;
  requestGeneration += 1;
  clearPendingTimer();
});

const builtin = computed(() => (props.iconType === 'builtin' ? builtinIcon(props.iconValue) : undefined));
const faviconCandidates = computed(() => faviconCandidatesFor(props.url));
const canTryFaviconCandidates = computed(() => props.iconType === 'auto' || (props.iconType === 'favicon' && !props.iconValue));
const usesSavedCache = computed(
  () =>
    Boolean(props.linkId) &&
    supportsSavedIconCache(props.url, props.iconType, props.iconValue),
);
const requestKey = computed(() => JSON.stringify([props.linkId, props.iconType, props.iconValue, props.url, requestVersion.value]));

const imageSrc = computed(() => {
  if (failed.value) return '';
  if (props.iconType === 'image') return props.iconValue;
  if (props.iconType === 'favicon' && props.iconValue) return props.iconValue;
  if (usesSavedCache.value && props.linkId) {
    return `/api/links/${encodeURIComponent(props.linkId)}/icon?v=${imageNonce.value}`;
  }
  if (canTryFaviconCandidates.value) return faviconCandidates.value[candidateIndex.value] ?? '';
  return '';
});

const imageKey = computed(() => JSON.stringify([requestKey.value, imageSrc.value]));
const imageErrorHandler = computed(() => {
  const requestedSource = imageSrc.value;
  const requestedKey = requestKey.value;
  const requestedEpoch = requestSessionEpoch.value;
  const generation = requestGeneration;
  return (event: Event) => handleImageError(event, requestedSource, requestedKey, requestedEpoch, generation);
});

const imageLoadHandler = computed(() => {
  const requestedSource = imageSrc.value;
  const requestedKey = requestKey.value;
  const requestedEpoch = requestSessionEpoch.value;
  const generation = requestGeneration;
  return (event: Event) => handleImageLoad(event, requestedSource, requestedKey, requestedEpoch, generation);
});

function handleImageError(
  event: Event,
  requestedSource: string,
  requestedKey: string,
  requestedEpoch: number,
  generation: number,
): void {
  if (event.currentTarget !== currentImage.value) return;
  if (requestedKey !== requestKey.value) return;

  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement) || image.getAttribute('src') !== requestedSource) return;

  if (usesSavedCache.value) {
    if (requestedEpoch !== getSessionEpoch()) return;
    if (!cacheResolveAttempted.value) {
      cacheResolveAttempted.value = true;
      void resolveAutomaticCache(requestKey.value, requestedEpoch, generation);
      return;
    }
    if (cacheStatus.value === 'pending' && pendingPollCount.value < MAX_PENDING_IMAGE_POLLS) {
      schedulePendingImagePoll(requestedKey, requestedEpoch, generation);
      return;
    }
    failed.value = true;
    return;
  }

  if (canTryFaviconCandidates.value && candidateIndex.value + 1 < faviconCandidates.value.length) {
    candidateIndex.value += 1;
    return;
  }

  failed.value = true;
}

function handleImageLoad(
  event: Event,
  requestedSource: string,
  requestedKey: string,
  requestedEpoch: number,
  generation: number,
): void {
  if (event.currentTarget !== currentImage.value) return;
  if (!isCurrentRequest(requestedKey, requestedEpoch, generation)) {
    if (usesSavedCache.value) failed.value = true;
    return;
  }

  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement) || image.getAttribute('src') !== requestedSource) return;
  if (usesSavedCache.value) {
    loadedCachedImage.value = true;
    cacheStatus.value = 'ready';
    pendingPollCount.value = 0;
    clearPendingTimer();
  }
}

async function resolveAutomaticCache(key: string, epoch: number, generation: number): Promise<void> {
  const linkId = props.linkId;
  if (!linkId) return;

  try {
    const result = await resolveSavedIcon(linkId);
    if (!isCurrentRequest(key, epoch, generation)) {
      if (!disposed && generation === requestGeneration && key === requestKey.value && epoch !== getSessionEpoch()) failed.value = true;
      return;
    }

    cacheStatus.value = result.status;
    if (result.status === 'ready') {
      imageNonce.value += 1;
    } else if (result.status === 'pending') {
      schedulePendingImagePoll(key, epoch, generation);
    } else {
      failed.value = true;
    }
  } catch {
    if (!isCurrentRequest(key, epoch, generation)) {
      if (!disposed && generation === requestGeneration && key === requestKey.value && epoch !== getSessionEpoch()) failed.value = true;
      return;
    }
    cacheStatus.value = 'failed';
    failed.value = true;
  }
}

function schedulePendingImagePoll(key: string, epoch: number, generation: number): void {
  if (pendingTimer || pendingPollCount.value >= MAX_PENDING_IMAGE_POLLS) {
    if (pendingPollCount.value >= MAX_PENDING_IMAGE_POLLS) failed.value = true;
    return;
  }

  pendingPollCount.value += 1;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (!isCurrentRequest(key, epoch, generation)) return;
    imageNonce.value += 1;
  }, PENDING_IMAGE_POLL_MS);
}

function clearPendingTimer(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}

function isCurrentRequest(key: string, epoch: number, generation: number): boolean {
  return !disposed && generation === requestGeneration && key === requestKey.value && epoch === getSessionEpoch();
}

async function refreshSavedIcon(): Promise<void> {
  const linkId = props.linkId;
  if (!linkId || !usesSavedCache.value || refreshBusy.value) return;

  const key = requestKey.value;
  const epoch = getSessionEpoch();
  const generation = requestGeneration;
  refreshBusy.value = true;
  emit('refresh-state', true);

  try {
    const result = await resolveSavedIcon(linkId, true);
    if (!isCurrentRequest(key, epoch, generation)) return;

    cacheStatus.value = result.status;
    if (result.status === 'ready') {
      if (result.refreshed || !loadedCachedImage.value) {
        failed.value = false;
        imageNonce.value += 1;
      }
      if (result.refreshed) toastSuccess('图标已刷新');
      else {
        const retryHint = result.retryAfterSeconds ? `，约 ${result.retryAfterSeconds} 秒后可重试` : '';
        showToast(`本次未更新，继续使用已保存图标${retryHint}`, 'info');
      }
    } else if (result.status === 'pending') {
      showToast('图标正在获取，请稍后重试', 'info');
      if (!loadedCachedImage.value) {
        cacheResolveAttempted.value = true;
        cacheStatus.value = 'pending';
        failed.value = false;
        pendingPollCount.value = 0;
        schedulePendingImagePoll(key, epoch, generation);
      }
    } else {
      toastError('图标刷新失败，当前显示保持不变');
    }
  } catch {
    if (isCurrentRequest(key, epoch, generation)) toastError('图标刷新失败，当前显示保持不变');
  } finally {
    if (isCurrentRequest(key, epoch, generation)) {
      refreshBusy.value = false;
      emit('refresh-state', false);
    }
  }
}

defineExpose({ refreshSavedIcon });

const initial = computed(() => initialOf(props.name || props.url));
const gradient = computed(() => colorFromString(props.name || props.url));
</script>

<template>
  <span class="icon-view" :class="`icon-${size ?? 'md'}`" aria-hidden="true">
    <img
      v-if="imageSrc"
      :key="imageKey"
      ref="currentImage"
      :src="imageSrc"
      alt=""
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      @error="imageErrorHandler"
      @load="imageLoadHandler"
    />
    <!-- 图标内容来自 src/shared/icons.ts 的静态常量，且仅能按 ID 取用，不是用户数据 -->
    <!-- eslint-disable vue/no-v-html -->
    <svg
      v-else-if="builtin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      v-html="builtin.body"
    ></svg>
    <!-- eslint-enable vue/no-v-html -->
    <span v-else class="icon-initial" :style="{ background: gradient }">{{ initial }}</span>
  </span>
</template>

<style scoped>
.icon-view {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-size, 42px);
  height: var(--icon-size, 42px);
  flex: 0 0 auto;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  overflow: hidden;
  color: var(--accent);
}

.icon-sm {
  --icon-size: 30px;
  border-radius: 9px;
}

.icon-lg {
  --icon-size: 58px;
  border-radius: 16px;
}

.icon-view img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.icon-view svg {
  width: 62%;
  height: 62%;
}

.icon-initial {
  width: 100%;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #04241b;
}
</style>
