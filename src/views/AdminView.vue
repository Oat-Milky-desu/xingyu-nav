<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { errorText } from '../api/client';
import AdminAppearanceSection from '../components/admin/AdminAppearanceSection.vue';
import AdminBackupSection from '../components/admin/AdminBackupSection.vue';
import AdminImportSection from '../components/admin/AdminImportSection.vue';
import AdminSecuritySection from '../components/admin/AdminSecuritySection.vue';
import AdminSiteSection from '../components/admin/AdminSiteSection.vue';
import type { AppSettings } from '../shared/types';
import { contentState, loadContent, saveSettings, saveWallpaper } from '../stores/content';
import { clearPreview, setPreview, setWallpaperPreview } from '../stores/preview';
import { logoutRequest, sessionState } from '../stores/session';
import { requestConfirm, toastError, toastSuccess } from '../stores/ui';
import { optimizeWallpaper } from '../utils/wallpaper';

type TabId = 'site' | 'appearance' | 'security' | 'backup' | 'import';

const TABS: { id: TabId; label: string }[] = [
  { id: 'site', label: '站点信息' },
  { id: 'appearance', label: '外观样式' },
  { id: 'security', label: '账户安全' },
  { id: 'backup', label: '备份与恢复' },
  { id: 'import', label: '书签导入' },
];

const router = useRouter();
const activeTab = ref<TabId>('site');
const draft = ref<AppSettings>({ ...contentState.settings });
const baseline = ref<AppSettings>({ ...contentState.settings });
const pendingWallpaper = ref<File | null>(null);
const pendingWallpaperUrl = ref<string | null>(null);
const wallpaperProcessing = ref(false);
const appearanceKey = ref(0);
let wallpaperProcessingId = 0;
/** 草稿对应的已保存版本号：保存时用它做乐观并发检查，避免覆盖其它设备的新修改 */
const baselineRevision = ref(0);
const saving = ref(false);
const saveError = ref('');
const externalNotice = ref('');

const dirty = computed(
  () =>
    JSON.stringify(draft.value) !== JSON.stringify(baseline.value) ||
    pendingWallpaper.value !== null ||
    wallpaperProcessing.value,
);
const uploadNeedsImage = computed(
  () => draft.value.wallpaperMode === 'upload' && baseline.value.wallpaperMode !== 'upload' && !pendingWallpaper.value,
);

function setPendingWallpaper(file: File): void {
  clearPendingWallpaper();
  pendingWallpaper.value = file;
  pendingWallpaperUrl.value = URL.createObjectURL(file);
  setWallpaperPreview(pendingWallpaperUrl.value);
}

function clearPendingWallpaper(): void {
  if (pendingWallpaperUrl.value) URL.revokeObjectURL(pendingWallpaperUrl.value);
  pendingWallpaperUrl.value = null;
  pendingWallpaper.value = null;
  setWallpaperPreview(null);
}

async function processWallpaper(file: File): Promise<void> {
  const processingId = ++wallpaperProcessingId;
  wallpaperProcessing.value = true;
  saveError.value = '';
  try {
    const optimized = await optimizeWallpaper(file);
    if (processingId !== wallpaperProcessingId) return;
    setPendingWallpaper(optimized);
    updateDraft({ wallpaperMode: 'upload' });
  } catch (error) {
    if (processingId === wallpaperProcessingId) saveError.value = errorText(error);
  } finally {
    if (processingId === wallpaperProcessingId) wallpaperProcessing.value = false;
  }
}

function syncFromState(): void {
  wallpaperProcessingId += 1;
  clearPendingWallpaper();
  wallpaperProcessing.value = false;
  appearanceKey.value += 1;
  baseline.value = { ...contentState.settings };
  draft.value = { ...contentState.settings };
  baselineRevision.value = contentState.revision;
  externalNotice.value = '';
  clearPreview();
}

watch(
  draft,
  (value) => {
    // 草稿只写入独立的预览状态，contentState.settings 始终保持“已保存值”
    if (
      JSON.stringify(value) !== JSON.stringify(baseline.value) ||
      pendingWallpaper.value !== null ||
      wallpaperProcessing.value
    ) {
      setPreview(value);
    } else {
      clearPreview();
    }
  },
  { deep: true },
);

watch(
  () => contentState.revision,
  (revision) => {
    if (revision === baselineRevision.value) return;
    if (!dirty.value) {
      // 没有本地修改时跟随服务端最新设置
      syncFromState();
      return;
    }
    externalNotice.value = '检测到其它设备更新了站点数据。你的未保存修改仍然保留，保存时会进行版本检查。';
  },
);

watch(activeTab, (tab) => {
  // 从备份 / 导入页面返回时，若没有未保存草稿则吸收最新设置
  if ((tab === 'site' || tab === 'appearance') && !dirty.value) {
    syncFromState();
  }
});

onMounted(async () => {
  if (!contentState.loaded) {
    await loadContent();
  }
  syncFromState();
  window.addEventListener('beforeunload', onBeforeUnload);
});

onBeforeUnmount(() => {
  wallpaperProcessingId += 1;
  wallpaperProcessing.value = false;
  window.removeEventListener('beforeunload', onBeforeUnload);
  clearPendingWallpaper();
  clearPreview();
});

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = '';
}

function updateDraft(patch: Partial<AppSettings>): void {
  draft.value = { ...draft.value, ...patch };
}

async function save(): Promise<boolean> {
  if (wallpaperProcessing.value) {
    saveError.value = '请等待图片处理完成后再保存。';
    return false;
  }
  if (uploadNeedsImage.value) {
    saveError.value = '请先选择要上传的壁纸图片。';
    return false;
  }
  saving.value = true;
  saveError.value = '';
  try {
    const settings = { ...draft.value };
    if (pendingWallpaper.value && settings.wallpaperMode === 'upload') {
      await saveWallpaper(pendingWallpaper.value, settings, baselineRevision.value);
    } else {
      await saveSettings(settings, baselineRevision.value);
    }
    syncFromState();
    toastSuccess('设置已保存');
    return true;
  } catch (error) {
    saveError.value = errorText(error);
    return false;
  } finally {
    saving.value = false;
  }
}

function discard(): void {
  // 其它设备更新后 baseline 可能已落后于服务器；放弃修改应当回到 contentState
  // 中的最新已保存设置与版本号，而不是过期基线，避免下次保存误报冲突。
  syncFromState();
  saveError.value = '';
}

/** 保存冲突后显式选择“加载其它设备的最新设置” */
async function reloadLatest(): Promise<void> {
  const confirmed = await requestConfirm({
    title: '加载最新设置',
    message: '将放弃你的未保存修改，并加载服务器上的最新设置。',
    confirmText: '放弃修改并加载',
    danger: true,
  });
  if (confirmed !== 'primary') return;
  await loadContent({ silent: true });
  syncFromState();
  toastSuccess('已加载最新设置');
}

function goHome(): void {
  void router.push({ name: 'home' });
}

async function handleLogout(): Promise<void> {
  const confirmed = await requestConfirm({
    title: '退出登录',
    message: '退出后需要重新登录才能继续管理站点。',
    confirmText: '退出',
  });
  if (confirmed !== 'primary') return;
  try {
    await logoutRequest();
    await router.replace({ name: 'login' });
  } catch (error) {
    toastError(`退出登录失败：${errorText(error)}`);
  }
}

onBeforeRouteLeave(async () => {
  // 会话已失效 / 已登出时直接离开，不再弹出“未保存”询问
  if (!dirty.value || !sessionState.authenticated) {
    clearPendingWallpaper();
    clearPreview();
    return true;
  }
  const choice = await requestConfirm({
    title: '有未保存的修改',
    message: '外观 / 站点设置尚未保存。你可以先保存再离开，也可以放弃这些修改。',
    confirmText: '保存并离开',
    secondaryText: '放弃修改并离开',
    cancelText: '留在本页',
  });
  if (choice === 'cancel') return false;
  if (choice === 'secondary') {
    discard();
    return true;
  }
  const saved = await save();
  if (saved) return true;
  toastError('保存失败，已留在当前页面');
  return false;
});
</script>

<template>
  <div class="page admin">
    <header class="admin-head glass">
      <div class="row">
        <button type="button" class="btn btn-sm" @click="goHome">← 返回导航</button>
        <div>
          <h1>站点设置</h1>
          <p class="muted admin-sub">所有修改都会保存到云端数据库，并在其它设备上同步。</p>
        </div>
      </div>
      <div class="row">
        <span class="badge">{{ sessionState.username }}</span>
        <button type="button" class="btn btn-sm btn-ghost" @click="handleLogout">退出登录</button>
      </div>
    </header>

    <div class="admin-layout">
      <nav class="admin-tabs glass" aria-label="设置分区">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          class="admin-tab"
          :class="{ active: activeTab === tab.id }"
          :aria-current="activeTab === tab.id ? 'page' : undefined"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>

      <main id="main-content" class="admin-panel glass">
        <AdminSiteSection v-if="activeTab === 'site'" :settings="draft" @update="updateDraft" />
        <AdminAppearanceSection
          v-else-if="activeTab === 'appearance'"
          :key="appearanceKey"
          :settings="draft"
          :wallpaper-preview-url="pendingWallpaperUrl"
          :wallpaper-processing="wallpaperProcessing"
          @update="updateDraft"
          @wallpaper-selected="processWallpaper"
        />
        <AdminSecuritySection v-else-if="activeTab === 'security'" />
        <AdminBackupSection v-else-if="activeTab === 'backup'" />
        <AdminImportSection v-else />
      </main>
    </div>

    <div
      v-if="dirty && (activeTab === 'site' || activeTab === 'appearance')"
      class="save-bar glass"
      role="region"
      aria-label="未保存的修改"
    >
      <span v-if="wallpaperProcessing">正在处理壁纸图片…</span>
      <span v-else-if="uploadNeedsImage">先选择壁纸图片才能保存</span>
      <span v-else>预览中，尚未保存</span>
      <div class="row">
        <button v-if="externalNotice" type="button" class="btn btn-sm" :disabled="saving" @click="reloadLatest">
          加载最新
        </button>
        <button type="button" class="btn btn-sm" :disabled="saving" @click="discard">放弃修改</button>
        <button type="button" class="btn btn-sm btn-primary" :disabled="saving || wallpaperProcessing || uploadNeedsImage" @click="save">
          {{ saving ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </div>

    <p v-if="externalNotice" class="form-notice" role="status">{{ externalNotice }}</p>
    <p v-if="saveError" class="form-error admin-error" role="alert">
      {{ saveError }}
      <button v-if="externalNotice" type="button" class="btn btn-sm error-action" @click="reloadLatest">加载最新设置</button>
    </p>
  </div>
</template>

<style scoped>
.admin-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 18px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.admin-head h1 {
  margin: 0;
  font-size: 1.12rem;
}

.admin-sub {
  margin: 2px 0 0;
  font-size: 0.82rem;
}

.admin-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 18px;
  align-items: start;
}

.admin-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  position: sticky;
  top: 16px;
}

.admin-tab {
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  text-align: left;
  cursor: pointer;
}

.admin-tab:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.05);
}

.admin-tab.active {
  color: var(--text);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.admin-panel {
  padding: 20px;
  min-height: 320px;
}

.save-bar {
  position: sticky;
  bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 18px;
  padding: 12px 18px;
  background: var(--surface-strong);
}

.admin-error {
  margin-top: 12px;
}

.form-notice {
  margin: 12px 0 0;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--text);
  font-size: 0.86rem;
}

.error-action {
  margin-left: 8px;
}

@media (max-width: 860px) {
  .admin-layout {
    grid-template-columns: 1fr;
  }

  .admin-tabs {
    flex-direction: row;
    overflow-x: auto;
    position: static;
  }

  .admin-tab {
    white-space: nowrap;
  }
}
</style>
