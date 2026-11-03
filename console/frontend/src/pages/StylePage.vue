<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NDataTable, NTabPane, NTabs, NTag, type DataTableColumns } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'

interface RuleRow { key: string; label: string; rule: string; confidence: number }
interface WordRow { word: string; count: number }
interface GroupStyle {
  groupId: string
  expressions: { words: WordRow[]; patterns: string[]; styleExpressions: { situation: string; expressions: string[] }[]; rhythmPatterns: { layout: string; count: number }[] } | null
}
interface StyleOverview {
  enabled: boolean
  autoSummaryEnabled: boolean
  totalSamples: number
  lastSummaryAt?: string
  memoryUpdatedAt?: string
  aiRules: { absorb: RuleRow[]; avoid: RuleRow[] }
  promptPreview: string
  groupNames?: Record<string, string>
  groups: GroupStyle[]
}

const overview = ref<StyleOverview | null>(null)
const loading = ref(false)
const error = ref('')
const acting = ref('')
let timer: number | null = null

async function load() {
  loading.value = true
  error.value = ''
  try {
    overview.value = await api<StyleOverview>('/api/style/overview')
  } catch (e: any) {
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), 120000)
})
onBeforeUnmount(() => { if (timer) window.clearInterval(timer) })

async function removeRule(kind: 'absorb' | 'avoid', key: string) {
  acting.value = key
  try {
    await api('/api/style/remove-rule', { method: 'POST', body: JSON.stringify({ kind, key }) })
    await load()
  } catch (e: any) {
    error.value = e?.message || '删除失败'
  } finally {
    acting.value = ''
  }
}
async function blockWord(groupId: string, word: string) {
  acting.value = word
  try {
    await api('/api/style/block-word', { method: 'POST', body: JSON.stringify({ group: groupId, word }) })
    await load()
  } catch (e: any) {
    error.value = e?.message || '屏蔽失败'
  } finally {
    acting.value = ''
  }
}

function timeAgo(iso?: string) {
  if (!iso) return '从未'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
const groupLabel = (groupId: string) => {
  const name = overview.value?.groupNames?.[groupId]
  return name ? `${name}（${groupId}）` : `群 ${groupId}`
}
const RHYTHM_LABELS: Record<string, string> = {
  single: '完整单条',
  twoBeat: '短反应→补话',
  multiBeat: '连续多条',
  emojiOnly: '纯表情包',
  textEmoji: '文字→表情',
  emojiText: '表情→补话',
  textEmojiText: '短反应→表情→补话',
  mixedTwoBeat: '两段混合',
  mixedMultiBeat: '多段混合',
}

const absorbColumns: DataTableColumns<RuleRow> = [
  { title: '规则', key: 'rule' },
  { title: '置信度', key: 'confidence', width: 90, render: row => row.confidence ? `${Math.round(row.confidence * 100)}%` : '—' },
  { title: '', key: 'ops', width: 80, render: row => h(NButton, { size: 'tiny', type: 'error', quaternary: true, loading: acting.value === row.key, onClick: () => void removeRule('absorb', row.key) }, { default: () => '删除' }) },
]
const avoidColumns: DataTableColumns<RuleRow> = [
  { title: '规则', key: 'rule' },
  { title: '置信度', key: 'confidence', width: 90, render: row => row.confidence ? `${Math.round(row.confidence * 100)}%` : '—' },
  { title: '', key: 'ops', width: 80, render: row => h(NButton, { size: 'tiny', type: 'error', quaternary: true, loading: acting.value === row.key, onClick: () => void removeRule('avoid', row.key) }, { default: () => '删除' }) },
]
function wordColumns(groupId: string): DataTableColumns<WordRow> {
  return [
    { title: '常用词', key: 'word' },
    { title: '次数', key: 'count', width: 90 },
    { title: '', key: 'ops', width: 90, render: row => h(NButton, { size: 'tiny', quaternary: true, type: 'warning', loading: acting.value === row.word, onClick: () => void blockWord(groupId, row.word) }, { default: () => '屏蔽' }) },
  ]
}
import { h } from 'vue'
</script>

<template>
  <div class="page">
    <PageHeader title="风格学习" subtitle="表达学习系统学到了什么：全局策略规则（可修剪）与各群常用词（可屏蔽）" />
    <PageState :loading="loading && !overview" :error="error" @retry="load" />
    <template v-if="overview">
      <NAlert v-if="!overview.enabled" type="warning" style="margin-bottom: 12px">
        globalStyleLearning 处于关闭状态，学习未运行。
      </NAlert>
      <div class="cards">
        <div class="card"><div class="card-label">累计观察样本</div><div class="card-value">{{ overview.totalSamples.toLocaleString() }}</div></div>
        <div class="card"><div class="card-label">最近 AI 总结</div><div class="card-value small" :title="overview.lastSummaryAt || ''">{{ timeAgo(overview.lastSummaryAt) }}</div></div>
        <div class="card"><div class="card-label">最近观察落盘</div><div class="card-value small" :title="overview.memoryUpdatedAt || ''">{{ timeAgo(overview.memoryUpdatedAt) }}</div></div>
        <div class="card"><div class="card-label">可吸收 / 避开规则</div><div class="card-value">{{ overview.aiRules.absorb.length }} / {{ overview.aiRules.avoid.length }}</div></div>
      </div>
      <NTabs type="line" style="margin-top: 8px">
        <NTabPane name="global" tab="全局表达策略">
          <h4>可吸收（学习到值得用的说话方式）</h4>
          <NAlert v-if="!overview.aiRules.absorb.length" type="default" :show-icon="false" style="margin-bottom: 8px">
            还没有总结出可吸收规则——观察在积累，达到总结阈值后会自动生成（看上方「最近 AI 总结」确认节奏）。
          </NAlert>
          <NDataTable v-else :columns="absorbColumns" :data="overview.aiRules.absorb" size="small" :bordered="false" />
          <h4>避开（学习到要避免的）</h4>
          <NDataTable v-if="overview.aiRules.avoid.length" :columns="avoidColumns" :data="overview.aiRules.avoid" size="small" :bordered="false" />
          <div v-else class="line">暂无</div>
          <details style="margin-top: 12px">
            <summary>当前注入提示词预览</summary>
            <pre class="preview">{{ overview.promptPreview }}</pre>
          </details>
        </NTabPane>
        <NTabPane v-for="g in overview.groups.filter(g => g.expressions)" :key="g.groupId" :name="g.groupId" :tab="groupLabel(g.groupId)">
          <h4>常用词（点屏蔽后不再学习/注入该词）</h4>
          <NDataTable :columns="wordColumns(g.groupId)" :data="g.expressions!.words" size="small" :bordered="false" />
          <template v-if="g.expressions!.styleExpressions?.length">
            <h4>场景表达</h4>
            <div v-for="s in g.expressions!.styleExpressions" :key="s.situation" class="line">{{ s.situation }}时常说：{{ s.expressions.join('、') }}</div>
          </template>
          <template v-if="g.expressions!.patterns?.length">
            <h4>常见句式</h4>
            <div class="line">{{ g.expressions!.patterns.join('、') }}</div>
          </template>
          <template v-if="g.expressions!.rhythmPatterns?.length">
            <h4>分条节奏（群友整轮回复的形态分布）</h4>
            <div class="line">
              <NTag v-for="r in g.expressions!.rhythmPatterns" :key="r.layout" size="small" style="margin-right: 6px">{{ RHYTHM_LABELS[r.layout] || r.layout }} ×{{ r.count }}</NTag>
            </div>
          </template>
        </NTabPane>
      </NTabs>
    </template>
  </div>
</template>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--n-border-color); border-radius: 8px; padding: 12px 16px; }
.card-label { font-size: 12px; opacity: 0.7; margin-bottom: 4px; }
.card-value { font-size: 22px; font-weight: 600; }
.card-value.small { font-size: 14px; }
h4 { margin: 14px 0 8px; font-size: 13px; }
.line { font-size: 13px; margin-bottom: 4px; }
.preview { font-size: 12px; background: var(--n-color-embedded, rgba(128,128,128,.08)); padding: 10px; border-radius: 6px; white-space: pre-wrap; }
</style>
