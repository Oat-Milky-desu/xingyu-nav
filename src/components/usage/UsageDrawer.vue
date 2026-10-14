<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { errorText } from '../../api/client';
import {
  USAGE_PROVIDER_LABELS,
  type CloudflareProviderInput,
  type DeepSeekProviderInput,
  type UsageProvider,
} from '../../shared/usage';
import {
  configuredProviders,
  deleteUsageProvider,
  loadUsage,
  refreshUsage,
  saveUsageProvider,
  usageState,
} from '../../stores/usage';
import { confirmAction, toastError, toastSuccess } from '../../stores/ui';
import UsageCard from './UsageCard.vue';
import UsageProviderDialog from './UsageProviderDialog.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (event: 'close'): void }>();

const panelRef = ref<HTMLElement | null>(null);
const closeRef = ref<HTMLButtonElement | null>(null);
let previouslyFocused: HTMLElement | null = null;
let previousOverflow = '';

const dialogOpen = ref(false);
const dialogProvider = ref<UsageProvider>('cloudflare');
const dialogError = ref<string | null>(null);

const unconfiguredProviders = () => usageState.providers.filter((item) => !item.configured);
const dialogState = () => usageState.providers.find((item) => item.provider === dialogProvider.value) ?? null;

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previouslyFocused = (document.activeElement as HTMLElement | null) ?? null;
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      await nextTick();
      closeRef.value?.focus();
      await openFlow();
    } else {
      document.body.style.overflow = previousOverflow;
      dialogOpen.value = false;
      previouslyFocused?.focus?.();
      previouslyFocused = null;
    }
  },
);

onBeforeUnmount(() => {
  document.body.style.overflow = previousOverflow;
});

/** 打开时读取缓存，并只对缺失 / 过期的服务触发一次上游取数 */
async function openFlow(): Promise<void> {
  await loadUsage();
  if (!usageState.credentialsReady) return;
  const needsRefresh = configuredProviders().some((item) => item.data === null || item.stale);
  if (needsRefresh) await refreshUsage();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key !== 'Tab' || !panelRef.value) return;
  const focusables = Array.from(
    panelRef.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openDialog(provider: UsageProvider): void {
  dialogProvider.value = provider;
  dialogError.value = null;
  dialogOpen.value = true;
}

async function refreshOne(provider: UsageProvider): Promise<void> {
  await refreshUsage({ provider, force: true });
}

async function refreshAll(): Promise<void> {
  await refreshUsage({ force: true });
}

async function submitDialog(input: CloudflareProviderInput | DeepSeekProviderInput): Promise<void> {
  dialogError.value = null;
  const provider = dialogProvider.value;
  try {
    await saveUsageProvider(provider, input);
    toastSuccess(`${USAGE_PROVIDER_LABELS[provider]} 配置已保存`);
    dialogOpen.value = false;
    // 跳过保存前校验时还没有任何数据，立刻取一次，避免卡片停在空状态
    const saved = usageState.providers.find((item) => item.provider === provider);
    if (saved?.data === null) await refreshOne(provider);
  } catch (error) {
    dialogError.value = errorText(error);
  }
}

async function removeDialog(): Promise<void> {
  const provider = dialogProvider.value;
  const confirmed = await confirmAction({
    title: '删除监控配置',
    message: `确定要删除「${USAGE_PROVIDER_LABELS[provider]}」的凭据吗？删除后该卡片会被移除，可随时重新添加。`,
    confirmText: '删除',
    danger: true,
  });
  if (!confirmed) return;
  dialogError.value = null;
  try {
    await deleteUsageProvider(provider);
    toastSuccess('监控配置已删除');
    dialogOpen.value = false;
  } catch (error) {
    dialogError.value = errorText(error);
  }
}

function reportRefreshError(): void {
  if (usageState.error) toastError(usageState.error);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-backdrop" @mousedown.self="emit('close')">
      <aside
        ref="panelRef"
        class="usage-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="用量监控"
        @keydown="onKeydown"
      >
        <header class="usage-drawer-head">
          <div class="usage-drawer-title">
            <h2>用量监控</h2>
            <p class="muted usage-drawer-sub">只显示已配置的服务；数据由服务端缓存，默认 5 分钟刷新一次。</p>
          </div>
          <div class="row usage-drawer-actions">
            <button
              type="button"
              class="btn btn-sm"
              :disabled="usageState.refreshing || !usageState.credentialsReady"
              @click="refreshAll"
            >
              {{ usageState.refreshing ? '刷新中…' : '全部刷新' }}
            </button>
            <button ref="closeRef" type="button" class="btn btn-ghost btn-icon" aria-label="关闭用量面板" @click="emit('close')">
              ×
            </button>
          </div>
        </header>

        <div class="usage-drawer-body">
          <p v-if="!usageState.credentialsReady" class="usage-banner" role="alert">
            服务端未配置 <code>USAGE_ENCRYPTION_KEY</code>，暂时无法保存监控凭据。请先配置该密钥并重新部署。
          </p>

          <p v-if="usageState.error" class="usage-banner" role="alert">
            {{ usageState.error }}
            <button type="button" class="btn btn-sm" @click="loadUsage().then(reportRefreshError)">重试</button>
          </p>

          <div v-if="usageState.loading && !usageState.loaded" class="stack" aria-hidden="true">
            <div v-for="index in 2" :key="index" class="skeleton usage-skeleton"></div>
          </div>

          <template v-else>
            <UsageCard
              v-for="state in configuredProviders()"
              :key="state.provider"
              :state="state"
              :busy="usageState.refreshing || usageState.saving || usageState.removing"
              @configure="openDialog(state.provider)"
              @refresh="refreshOne(state.provider)"
            />

            <p v-if="configuredProviders().length === 0" class="muted usage-drawer-empty">
              还没有监控任何服务，从下面添加即可。
            </p>

            <section v-if="unconfiguredProviders().length > 0" class="usage-add">
              <h3 class="usage-add-title">添加服务</h3>
              <div
                v-for="state in unconfiguredProviders()"
                :key="`add-${state.provider}`"
                class="usage-add-row"
              >
                <span>{{ USAGE_PROVIDER_LABELS[state.provider] }}</span>
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="!usageState.credentialsReady || usageState.saving"
                  @click="openDialog(state.provider)"
                >
                  添加
                </button>
              </div>
            </section>
          </template>
        </div>
      </aside>
    </div>
  </Teleport>

  <UsageProviderDialog
    :open="dialogOpen"
    :provider="dialogProvider"
    :state="dialogState()"
    :saving="usageState.saving"
    :error="dialogError"
    @close="dialogOpen = false"
    @submit="submitDialog"
    @remove="removeDialog"
  />
</template>

<style scoped>
.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  justify-content: flex-end;
  background: rgba(3, 8, 16, 0.5);
  backdrop-filter: blur(3px);
}

.usage-drawer {
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  height: 100%;
  background: var(--surface-strong);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  animation: drawer-in 0.2s ease;
}

.usage-drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--border);
}

.usage-drawer-title h2 {
  margin: 0;
  font-size: 1.06rem;
}

.usage-drawer-sub {
  margin: 4px 0 0;
  font-size: 0.8rem;
}

.usage-drawer-actions {
  flex: none;
  flex-wrap: nowrap;
}

.usage-drawer-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px 24px;
  overflow-y: auto;
}

.usage-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 0.84rem;
}

.usage-banner code {
  font-size: 0.8rem;
}

.usage-drawer-empty {
  margin: 4px 0;
  font-size: 0.86rem;
}

.usage-skeleton {
  height: 132px;
}

.usage-add {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.usage-add-title {
  margin: 0;
  font-size: 0.86rem;
  color: var(--text-muted);
  font-weight: 500;
}

.usage-add-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  font-size: 0.88rem;
}

@keyframes drawer-in {
  from {
    transform: translateX(18px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}

@media (max-width: 520px) {
  .usage-drawer {
    width: 100%;
  }
}
</style>
