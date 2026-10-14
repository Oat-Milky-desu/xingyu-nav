<script setup lang="ts">
import { computed } from 'vue';
import {
  USAGE_PROVIDER_LABELS,
  cloudflareErrorRate,
  cloudflareQuotaRatio,
  cloudflareQuotaTone,
  formatUsageAmount,
  formatUsageNumber,
  formatUsagePercent,
  type UsageProviderState,
} from '../../shared/usage';

const props = defineProps<{
  state: UsageProviderState;
  /** 面板正在刷新或保存时禁用卡片上的操作 */
  busy: boolean;
}>();

const emit = defineEmits<{
  (event: 'configure'): void;
  (event: 'refresh'): void;
}>();

interface Metric {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger';
}

const label = computed(() => USAGE_PROVIDER_LABELS[props.state.provider]);

const metrics = computed<Metric[]>(() => {
  const state = props.state;
  if (state.provider === 'cloudflare') {
    const data = state.data;
    if (!data) return [];
    return [
      { label: '今日请求', value: formatUsageNumber(data.requestsToday) },
      {
        label: '今日错误',
        value: formatUsageNumber(data.errorsToday),
        hint: `错误率 ${formatUsagePercent(cloudflareErrorRate(data))}`,
        tone: data.errorsToday > 0 ? 'warning' : 'default',
      },
      {
        label: '本月请求',
        value: formatUsageNumber(data.requestsMonth),
        hint: `本月错误 ${formatUsageNumber(data.errorsMonth)}`,
      },
    ];
  }
  const data = state.data;
  if (!data) return [];
  return [
    {
      label: '可用余额',
      value: `${formatUsageAmount(data.totalBalance)} ${data.currency}`,
      hint: data.isAvailable ? '余额充足，可继续调用' : '余额不足，调用可能失败',
      tone: data.isAvailable ? 'default' : 'danger',
    },
    { label: '充值余额', value: `${formatUsageAmount(data.toppedUpBalance)} ${data.currency}` },
    { label: '赠送余额', value: `${formatUsageAmount(data.grantedBalance)} ${data.currency}` },
  ];
});

const quotaRatio = computed(() => {
  const state = props.state;
  return state.provider === 'cloudflare' && state.data ? cloudflareQuotaRatio(state.data) : null;
});

const quotaTone = computed(() => (quotaRatio.value === null ? 'default' : cloudflareQuotaTone(quotaRatio.value)));

const scopeHint = computed(() => {
  const state = props.state;
  if (state.provider !== 'cloudflare' || !state.config) return '';
  const config = state.config;
  return config.scriptName ? `统计 Worker「${config.scriptName}」` : '统计整个账号（不区分具体 Worker）';
});

const truncated = computed(() => props.state.provider === 'cloudflare' && props.state.data?.truncated === true);

const updatedText = computed(() => formatTimestamp(props.state.dataFetchedAt));

function formatTimestamp(iso: string | null): string {
  if (!iso) return '尚未获取数据';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <section class="usage-card card-surface" :aria-label="`${label} 用量`">
    <header class="usage-card-head">
      <div class="usage-card-title">
        <h3>{{ label }}</h3>
        <span v-if="!state.configured" class="badge">未配置</span>
        <span v-else-if="state.failed" class="badge badge-error">取数失败</span>
        <span v-else-if="state.data !== null && state.stale" class="badge badge-warn">数据可能过期</span>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-icon usage-gear"
        :aria-label="`设置 ${label}`"
        :title="`设置 ${label}`"
        :disabled="busy"
        @click="emit('configure')"
      >
        ⚙
      </button>
    </header>

    <p v-if="!state.configured" class="muted usage-empty">
      尚未配置，添加凭据后即可查看用量。
    </p>

    <template v-else>
      <p v-if="state.errorMessage" class="usage-error" role="alert">{{ state.errorMessage }}</p>

      <dl v-if="metrics.length > 0" class="usage-metrics">
        <div v-for="metric in metrics" :key="metric.label" class="usage-metric">
          <dt>{{ metric.label }}</dt>
          <dd :class="`tone-${metric.tone ?? 'default'}`">{{ metric.value }}</dd>
          <p v-if="metric.hint" class="usage-metric-hint muted">{{ metric.hint }}</p>
        </div>
      </dl>
      <p v-else-if="!state.errorMessage" class="muted usage-empty">
        {{ busy ? '正在获取用量数据…' : '暂无数据，点击下方「刷新」获取。' }}
      </p>

      <div v-if="quotaRatio !== null" class="usage-quota">
        <div class="usage-quota-head">
          <span>免费套餐当日额度</span>
          <span :class="`tone-${quotaTone}`">{{ formatUsagePercent(quotaRatio) }}</span>
        </div>
        <div class="usage-quota-track" role="progressbar" :aria-valuenow="Math.round(quotaRatio * 100)" aria-valuemin="0" aria-valuemax="100">
          <span class="usage-quota-fill" :class="`tone-${quotaTone}`" :style="{ width: `${Math.round(quotaRatio * 100)}%` }"></span>
        </div>
      </div>

      <p v-if="scopeHint" class="usage-note muted">{{ scopeHint }}</p>
      <p v-if="truncated" class="usage-note usage-note-warn">上游返回行数达到查询上限，统计值可能不完整。</p>

      <footer class="usage-card-foot">
        <span class="muted usage-updated">更新于 {{ updatedText }}</span>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="emit('refresh')">刷新</button>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.usage-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}

.usage-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.usage-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.usage-card-title h3 {
  margin: 0;
  font-size: 1rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge-error {
  color: var(--danger);
  border-color: rgba(255, 128, 128, 0.4);
}

.badge-warn {
  color: var(--warning);
  border-color: rgba(255, 196, 107, 0.4);
}

.usage-gear {
  flex: none;
}

.usage-empty {
  margin: 0;
  font-size: 0.86rem;
}

.usage-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 0.82rem;
}

.usage-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin: 0;
}

.usage-metric dt {
  font-size: 0.76rem;
  color: var(--text-muted);
}

.usage-metric dd {
  margin: 2px 0 0;
  font-size: 1.2rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.usage-metric-hint {
  margin: 2px 0 0;
  font-size: 0.74rem;
}

.tone-default {
  color: var(--text);
}

.tone-warning {
  color: var(--warning);
}

.tone-danger {
  color: var(--danger);
}

.usage-quota {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.usage-quota-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.usage-quota-track {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}

.usage-quota-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}

.usage-quota-fill.tone-warning {
  background: var(--warning);
}

.usage-quota-fill.tone-danger {
  background: var(--danger);
}

.usage-note {
  margin: 0;
  font-size: 0.76rem;
}

.usage-note-warn {
  color: var(--warning);
}

.usage-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
}

.usage-updated {
  font-size: 0.76rem;
}
</style>
