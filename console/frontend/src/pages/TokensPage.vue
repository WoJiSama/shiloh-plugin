<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NDataTable, NSelect, NTag, type DataTableColumns } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'

interface StageRow { tokens: number; cost: number; calls: number }
interface ModelRow extends StageRow { estimated: boolean }
interface Summary {
  today: { tokens: number; cost: number; calls: number; byStage: Record<string, StageRow>; byModel: Record<string, ModelRow>; byScopeTop: { scope: string; tokens: number; cost: number }[] }
  priceTable: { currency: string; models: string[]; peakEnabled: boolean }
}
interface Bucket { start: number; tokens: number; cost: number; calls: number }

const summary = ref<Summary | null>(null)
const seriesHours = ref(24)
const buckets = ref<Bucket[]>([])
const loading = ref(false)
const error = ref('')
let timer: number | null = null

async function load() {
  loading.value = true
  error.value = ''
  try {
    summary.value = await api<Summary>('/api/tokens/summary')
    const series = await api<{ buckets: Bucket[] }>(`/api/tokens/series?hours=${seriesHours.value}`)
    buckets.value = series.buckets
  } catch (e: any) {
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), 60000)
})
onBeforeUnmount(() => { if (timer) window.clearInterval(timer) })

const stageColumns: DataTableColumns<[string, StageRow]> = [
  { title: '阶段', key: '0', render: row => row[0] },
  { title: '调用', key: '1.calls', render: row => String(row[1].calls) },
  { title: 'tokens', key: '1.tokens', render: row => row[1].tokens.toLocaleString() },
  { title: '花费(元)', key: '1.cost', render: row => row[1].cost.toFixed(4) },
]
const modelColumns: DataTableColumns<[string, ModelRow]> = [
  { title: '模型', key: '0', render: row => row[0] + (row[1].estimated ? '（估算价）' : '') },
  { title: '调用', key: '1.calls', render: row => String(row[1].calls) },
  { title: 'tokens', key: '1.tokens', render: row => row[1].tokens.toLocaleString() },
  { title: '花费(元)', key: '1.cost', render: row => row[1].cost.toFixed(4) },
]
const scopeColumns: DataTableColumns<{ scope: string; tokens: number; cost: number }> = [
  { title: '群/范围', key: 'scope', render: row => row.scope === 'global' ? '全局（未归组）' : row.scope },
  { title: 'tokens', key: 'tokens', render: row => row.tokens.toLocaleString() },
  { title: '花费(元)', key: 'cost', render: row => row.cost.toFixed(4) },
]
const stageRows = computed(() => Object.entries(summary.value?.today.byStage || {}).sort((a, b) => b[1].cost - a[1].cost))
const modelRows = computed(() => Object.entries(summary.value?.today.byModel || {}).sort((a, b) => b[1].cost - a[1].cost))
const scopeRows = computed(() => summary.value?.today.byScopeTop || [])
const maxCost = computed(() => Math.max(0.0001, ...buckets.value.map(b => b.cost)))
const hourOptions = [
  { label: '24 小时', value: 24 },
  { label: '3 天', value: 72 },
  { label: '7 天', value: 168 },
  { label: '30 天', value: 720 },
]
function timeLabel(start: number) {
  const d = new Date(start + 8 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div class="page">
    <PageHeader title="令牌与花费" subtitle="全部模型调用的 token 与金额核算（按天落盘，保留 90 天）" />
    <PageState :loading="loading && !summary" :error="error" @retry="load" />
    <template v-if="summary">
      <div class="cards">
        <div class="card">
          <div class="card-label">今日 tokens</div>
          <div class="card-value">{{ summary.today.tokens.toLocaleString() }}</div>
        </div>
        <div class="card">
          <div class="card-label">今日花费</div>
          <div class="card-value">¥{{ summary.today.cost.toFixed(4) }}</div>
        </div>
        <div class="card">
          <div class="card-label">今日调用</div>
          <div class="card-value">{{ summary.today.calls }}</div>
        </div>
        <div class="card">
          <div class="card-label">价目口径</div>
          <div class="card-value small">{{ summary.priceTable.models.length }} 个模型{{ summary.priceTable.peakEnabled ? '（峰谷已开）' : '' }}</div>
        </div>
      </div>
      <NAlert v-if="!summary.priceTable.models.length" type="warning" style="margin-bottom: 12px">
        价目表为空：未知模型按 fallback 估算（表格中会标注），可在 message.yaml 的 pricing.models 里补录。
      </NAlert>
      <div class="section">
        <div class="section-head">
          <span>消耗走势</span>
          <NSelect v-model:value="seriesHours" :options="hourOptions" size="small" style="width: 120px" @update:value="load" />
        </div>
        <div class="bars">
          <div v-for="b in buckets" :key="b.start" class="bar-col" :title="`${timeLabel(b.start)} · ${b.tokens} tokens · ¥${b.cost.toFixed(4)}`">
            <div class="bar" :style="{ height: `${Math.max(2, (b.cost / maxCost) * 100)}%` }" />
            <div class="bar-label">{{ timeLabel(b.start) }}</div>
          </div>
        </div>
      </div>
      <div class="section"><span>按群/范围（今日）</span><NDataTable :columns="scopeColumns" :data="scopeRows" size="small" :bordered="false" /></div>
      <div class="section"><span>按模型（今日）</span><NDataTable :columns="modelColumns" :data="modelRows" size="small" :bordered="false" /></div>
      <div class="section"><span>按阶段（今日）</span><NDataTable :columns="stageColumns" :data="stageRows" size="small" :bordered="false" /></div>
    </template>
  </div>
</template>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
.card { border: 1px solid var(--n-border-color); border-radius: 8px; padding: 12px 16px; }
.card-label { font-size: 12px; opacity: 0.7; margin-bottom: 4px; }
.card-value { font-size: 22px; font-weight: 600; }
.card-value.small { font-size: 14px; }
.section { margin-bottom: 16px; }
.section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-weight: 600; }
.section > span { display: block; font-weight: 600; margin-bottom: 8px; }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 120px; border-bottom: 1px solid var(--n-border-color); padding-bottom: 0; }
.bar-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; min-width: 0; }
.bar { width: 70%; background: var(--primary-color, #18a058); border-radius: 2px 2px 0 0; opacity: 0.8; }
.bar-label { font-size: 9px; opacity: 0.6; margin-top: 2px; white-space: nowrap; overflow: hidden; }
</style>
