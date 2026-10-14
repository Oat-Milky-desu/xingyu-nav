<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  USAGE_PROVIDER_LABELS,
  type CloudflarePlan,
  type CloudflareProviderInput,
  type DeepSeekProviderInput,
  type UsageProvider,
  type UsageProviderState,
} from '../../shared/usage';
import BaseModal from '../BaseModal.vue';

const props = defineProps<{
  open: boolean;
  provider: UsageProvider;
  /** 当前服务状态；已配置时用于回填非敏感配置 */
  state: UsageProviderState | null;
  saving: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'submit', input: CloudflareProviderInput | DeepSeekProviderInput): void;
  (event: 'remove'): void;
}>();

const accountId = ref('');
const plan = ref<CloudflarePlan>('free');
const scriptName = ref('');
const apiToken = ref('');
const apiKey = ref('');
const verify = ref(true);
const localError = ref('');

const isCloudflare = () => props.provider === 'cloudflare';
const configured = () => props.state?.configured === true;
const title = () => `设置 ${USAGE_PROVIDER_LABELS[props.provider]}`;

watch(
  () => [props.open, props.provider] as const,
  ([open]) => {
    if (!open) return;
    apiToken.value = '';
    apiKey.value = '';
    verify.value = true;
    localError.value = '';
    const config = props.state?.provider === 'cloudflare' ? props.state.config : null;
    accountId.value = config?.accountId ?? '';
    plan.value = config?.plan ?? 'free';
    scriptName.value = config?.scriptName ?? '';
  },
  { immediate: true },
);

function onSubmit(): void {
  localError.value = '';
  if (isCloudflare()) {
    const account = accountId.value.trim();
    if (!account) {
      localError.value = '请填写 Cloudflare Account ID';
      return;
    }
    const token = apiToken.value.trim();
    if (!token && !configured()) {
      localError.value = '请填写 Cloudflare API Token';
      return;
    }
    emit('submit', {
      accountId: account,
      plan: plan.value,
      scriptName: scriptName.value.trim(),
      ...(token ? { apiToken: token } : {}),
      verify: verify.value,
    });
    return;
  }
  const key = apiKey.value.trim();
  if (!key && !configured()) {
    localError.value = '请填写 DeepSeek API Key';
    return;
  }
  emit('submit', { ...(key ? { apiKey: key } : {}), verify: verify.value });
}
</script>

<template>
  <BaseModal :open="open" :title="title()" description="凭据仅保存在你的服务端，并以加密形式存储；保存后不会回显。" @close="emit('close')">
    <form id="usage-provider-form" class="stack" @submit.prevent="onSubmit">
      <template v-if="isCloudflare()">
        <label class="field">
          <span>Account ID *</span>
          <input v-model="accountId" class="input" type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="例如 023e105f4ecef8ad9ca31a8372d0c353" />
          <span class="field-hint">Cloudflare Dashboard → 账户首页右侧可复制 Account ID。</span>
        </label>
        <label class="field">
          <span>套餐</span>
          <select v-model="plan" class="select">
            <option value="free">免费（每日 100,000 次请求）</option>
            <option value="paid">付费（无请求数上限）</option>
          </select>
          <span class="field-hint">用于展示每日额度进度；接口本身无法判断套餐。</span>
        </label>
        <label class="field">
          <span>Worker 名称（可选）</span>
          <input v-model="scriptName" class="input" type="text" maxlength="128" autocomplete="off" spellcheck="false" placeholder="留空表示统计整个账号" />
          <span class="field-hint">只填单个 Worker 时，请求数不代表整个账号的额度消耗。</span>
        </label>
        <label class="field">
          <span>API Token {{ configured() ? '（留空表示沿用已保存的凭据）' : '*' }}</span>
          <input v-model="apiToken" class="input" type="password" maxlength="512" autocomplete="new-password" spellcheck="false" :placeholder="configured() ? '••••••••（保持不变）' : '需要 Account Analytics: Read 权限'" />
        </label>
      </template>

      <template v-else>
        <label class="field">
          <span>API Key {{ configured() ? '（留空表示沿用已保存的凭据）' : '*' }}</span>
          <input v-model="apiKey" class="input" type="password" maxlength="512" autocomplete="new-password" spellcheck="false" :placeholder="configured() ? '••••••••（保持不变）' : 'DeepSeek 平台 → API Keys 创建'" />
          <span class="field-hint">仅使用余额查询接口（/user/balance），不会发起任何对话请求。</span>
        </label>
      </template>

      <label class="checkbox-row">
        <input v-model="verify" type="checkbox" />
        <span>保存前先校验凭据（推荐）</span>
      </label>

      <p v-if="localError" class="form-error" role="alert">{{ localError }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>

    <template #footer>
      <button v-if="configured()" type="button" class="btn btn-danger" :disabled="saving" @click="emit('remove')">删除配置</button>
      <button type="button" class="btn" @click="emit('close')">取消</button>
      <button type="submit" form="usage-provider-form" class="btn btn-primary" :disabled="saving" data-autofocus>
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </BaseModal>
</template>
