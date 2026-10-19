<script setup lang="ts">
import { computed, h, onBeforeUnmount, ref } from 'vue'
import { NButton, NDataTable, NInputNumber, NSelect, NTab, NTabs, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { api } from '../lib/api'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import SchemaPage from './SchemaPage.vue'

interface SoupAudit { domain: 'structure' | 'playability' | 'logic'; pass: boolean; reason: string; holes?: string[]; at: number; model?: string }
interface SoupPuzzle {
  id: string
  title: string
  difficulty: string
  tags: string[]
  status: 'active' | 'pending' | 'retired'
  surface: string
  solution: string
  keyPoints: string[]
  hints: string[]
  ratingCount: number
  ratingAverage: number | null
  plays: number
  createdAt: number
  audits?: SoupAudit[]
}
interface SoupSession { groupId: string; phase: string; puzzleId: string; players: number; lastActivityAt: number }
interface SoupOverview {
  puzzles: SoupPuzzle[]
  sessions: SoupSession[]
  generating: { running: boolean; total: number; added: number; failed: number; log: string[] }
  freshPoolTarget: number
}

const message = useMessage()
const dialog = useDialog()
const loading = ref(true)
const error = ref('')
const overview = ref<SoupOverview | null>(null)
const activeTab = ref('turtleSoup')
const generatingCount = ref(3)
const statusFilter = ref('all')
let pollTimer: ReturnType<typeof setInterval> | null = null

const statusOptions = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待审' },
  { value: 'active', label: '投放中' },
  { value: 'retired', label: '已出池' }
]

async function loadOverview() {
  try {
    overview.value = await api<SoupOverview>('/api/games/turtle-soup/overview')
    error.value = ''
    if (overview.value.generating.running) ensurePolling()
    else stopPolling()
  } catch (cause: any) {
    error.value = cause.message || '题库加载失败'
  } finally {
    loading.value = false
  }
}
function ensurePolling() {
  if (pollTimer) return
  pollTimer = setInterval(loadOverview, 5000)
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
loadOverview()
onBeforeUnmount(stopPolling)

const puzzles = computed(() => {
  const list = overview.value?.puzzles || []
  return statusFilter.value === 'all' ? list : list.filter(item => item.status === statusFilter.value)
})
const stats = computed(() => {
  const list = overview.value?.puzzles || []
  return {
    total: list.length,
    pending: list.filter(item => item.status === 'pending').length,
    fresh: list.filter(item => item.status === 'active' && item.plays === 0).length,
    live: overview.value?.sessions.length || 0,
    target: overview.value?.freshPoolTarget || 0
  }
})

const statusLabel: Record<string, string> = { pending: '待审', active: '投放中', retired: '已出池' }
const statusType: Record<string, 'warning' | 'success' | 'default'> = { pending: 'warning', active: 'success', retired: 'default' }

const columns: DataTableColumns<SoupPuzzle> = [
  {
    title: '标题',
    key: 'title',
    minWidth: 160,
    render: row =>
      h('div', { class: 'soup-title' }, [
        h('strong', null, row.title),
        h('span', { class: 'soup-meta' }, `${row.difficulty}${row.tags.length ? ' · ' + row.tags.slice(0, 2).join('/') : ''}`)
      ])
  },
  {
    title: '状态',
    key: 'status',
    width: 92,
    render: row => h(NTag, { size: 'small', bordered: false, type: statusType[row.status] }, { default: () => statusLabel[row.status] })
  },
  {
    title: '评分',
    key: 'rating',
    width: 110,
    render: row => (row.ratingCount > 0 ? `${row.ratingAverage}星/${row.ratingCount}人` : '—')
  },
  { title: '开局', key: 'plays', width: 70 },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: row =>
      h('div', { class: 'soup-actions' }, [
        row.status === 'pending'
          ? h(NButton, { size: 'tiny', type: 'primary', secondary: true, onClick: () => setStatus(row, 'active') }, { default: () => '过审' })
          : null,
        row.status === 'active'
          ? h(NButton, { size: 'tiny', secondary: true, onClick: () => setStatus(row, 'retired') }, { default: () => '出池' })
          : null,
        row.status === 'retired'
          ? h(NButton, { size: 'tiny', quaternary: true, onClick: () => setStatus(row, 'active') }, { default: () => '恢复' })
          : null,
        h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            onClick: () =>
              dialog.warning({
                title: `删除【${row.title}】？`,
                content: '从题库彻底移除（游玩记录将失去题目详情，不可恢复）。',
                positiveText: '删除',
                negativeText: '取消',
                onPositiveClick: () => removePuzzle(row)
              })
          },
          { default: () => '删除' }
        )
      ])
  }
]

const auditDomainLabel: Record<string, string> = { structure: '结构审核', playability: '可玩性审题', logic: '逻辑审计' }

const rowProps = (row: SoupPuzzle) => ({
  style: 'cursor: pointer',
  onClick: () => {
    const latestAudits = (['structure', 'playability', 'logic'] as const).map(domain => {
      const hits = (row.audits || []).filter(audit => audit.domain === domain)
      return { domain, audit: hits.length ? hits[hits.length - 1]! : null }
    })
    const text = (label: string, value: string) => h('div', { class: 'detail-line' }, [h('span', { class: 'detail-label' }, label), h('div', null, value)])
    dialog.info({
      title: `${row.title} · ${statusLabel[row.status]}`,
      content: () =>
        h('div', { class: 'soup-detail-rich' }, [
          h('div', { class: 'detail-block' }, [text('汤面', row.surface), text('汤底', row.solution), text('关键点', row.keyPoints.join(' / ')), text('提示', row.hints.join(' | '))]),
          h('div', { class: 'detail-sec-title' }, '审核结果（各领域最新一次）'),
          ...latestAudits.map(({ domain, audit }) =>
            audit
              ? h('div', { class: 'audit-row' }, [
                  h('div', { class: 'audit-head' }, [
                    h(NTag, { size: 'small', bordered: false, type: audit.pass ? 'success' : 'error' }, { default: () => (audit.pass ? '通过' : '未过') }),
                    h('strong', null, auditDomainLabel[audit.domain]),
                    h('span', { class: 'audit-meta' }, new Date(audit.at).toLocaleString())
                  ]),
                  h('div', { class: 'audit-reason' }, audit.reason || '—'),
                  ...(audit.holes || []).map(hole => h('div', { class: 'audit-hole' }, `• ${hole}`))
                ])
              : h('div', { class: 'audit-row audit-empty' }, `${auditDomainLabel[domain]}：未记录(老题可点下方重新审计补齐)`)
          ),
          h('div', { class: 'audit-actions' }, [
            h(NButton, { size: 'small', secondary: true, loading: auditingId.value === row.id, disabled: auditingId.value === row.id, onClick: () => reaudit(row) }, { default: () => '重新审计' })
          ])
        ])
    })
  }
})

const auditingId = ref('')
async function reaudit(row: SoupPuzzle) {
  auditingId.value = row.id
  try {
    const result = await api<{ audits: SoupAudit[] }>(`/api/games/turtle-soup/puzzles/${row.id}/audit`, { method: 'POST', body: JSON.stringify({}) })
    const failed = result.audits.filter(audit => !audit.pass)
    message.warning(failed.length ? `重新审计:${failed.length} 个领域未过(${failed.map(audit => auditDomainLabel[audit.domain]).join('、')})` : '重新审计:三个领域全部通过')
    await loadOverview()
  } catch (cause: any) {
    message.error(cause.message || '重新审计失败')
  } finally {
    auditingId.value = ''
  }
}

async function setStatus(row: SoupPuzzle, status: SoupPuzzle['status']) {
  try {
    await api(`/api/games/turtle-soup/puzzles/${row.id}/status`, { method: 'PUT', body: JSON.stringify({ status }) })
    message.success(`【${row.title}】已${status === 'active' ? (row.status === 'pending' ? '过审，进入投放池' : '恢复投放') : '移出投放池'}`)
    await loadOverview()
  } catch (cause: any) {
    message.error(cause.message || '操作失败')
  }
}

async function removePuzzle(row: SoupPuzzle) {
  try {
    await api(`/api/games/turtle-soup/puzzles/${row.id}`, { method: 'DELETE' })
    message.success(`【${row.title}】已删除`)
    await loadOverview()
  } catch (cause: any) {
    message.error(cause.message || '删除失败')
  }
}

async function startGeneration() {
  try {
    await api('/api/games/turtle-soup/generate', { method: 'POST', body: JSON.stringify({ count: generatingCount.value }) })
    message.success('生成任务已启动（三道审核：结构/审题/逻辑审计）')
    ensurePolling()
    await loadOverview()
  } catch (cause: any) {
    message.error(cause.message || '启动失败')
  }
}

const phaseLabel: Record<string, string> = {
  joining: '报名中',
  choosing: '选汤中',
  playing: '问答中',
  reveal: '评分窗口'
}
</script>

<template>
  <div class="page-stack games-page">
    <PageHeader title="游戏" eyebrow="机器人能力" description="海龟汤题库审核与生成、各游戏的参数，在一个页面管理。">
    </PageHeader>
    <NTabs :value="activeTab" type="line" @update:value="activeTab = $event">
      <NTab name="turtleSoup">海龟汤</NTab>
      <NTab name="umaRace">赛马娘</NTab>
      <NTab name="deltaForce">三角洲</NTab>
    </NTabs>

    <template v-if="activeTab === 'turtleSoup'">
      <PageState :loading="loading && !overview" :error="!overview ? error : ''" @retry="loadOverview">
        <template v-if="overview">
          <section class="panel soup-summary">
            <div class="stats">
              <div><span>题库总数</span><strong>{{ stats.total }}</strong></div>
              <div><span>待审</span><strong class="warn">{{ stats.pending }}</strong></div>
              <div><span>鲜汤 {{ stats.target ? `/ ${stats.target}` : '' }}</span><strong>{{ stats.fresh }}</strong></div>
              <div><span>进行中</span><strong>{{ stats.live }}</strong></div>
            </div>
            <div class="summary-side">
              <div v-if="stats.pending" class="pending-hint">有 {{ stats.pending }} 道待审——过审后才会进入投放池</div>
              <div v-if="overview.sessions.length" class="live-list">
                <NTag v-for="session in overview.sessions" :key="session.groupId" size="small" :bordered="false">
                  群 {{ session.groupId }} · {{ phaseLabel[session.phase] || session.phase }} · {{ session.players }}人
                </NTag>
              </div>
            </div>
          </section>

          <section class="panel soup-generate">
            <div class="generate-row">
              <div>
                <span class="summary-label">生成新汤</span>
                <p>出题 → 结构审核 → 可玩性审题 → 独立逻辑审计，全过才入库（待审状态）。</p>
              </div>
              <div class="generate-actions">
                <NInputNumber v-model:value="generatingCount" :min="1" :max="10" size="small" style="width: 90px" />
                <NButton size="small" type="primary" secondary :disabled="overview.generating.running" @click="startGeneration">
                  {{ overview.generating.running ? `生成中 ${overview.generating.added + overview.generating.failed}/${overview.generating.total}` : '开始生成' }}
                </NButton>
              </div>
            </div>
            <div v-if="overview.generating.running || overview.generating.log.length" class="generate-log">
              <div v-for="(line, index) in overview.generating.log.slice(-8)" :key="index">{{ line }}</div>
            </div>
          </section>

          <section class="panel soup-table-panel">
            <div class="table-toolbar">
              <NSelect v-model:value="statusFilter" :options="statusOptions" size="small" style="width: 120px" />
              <NButton size="small" quaternary @click="loadOverview">刷新</NButton>
            </div>
            <NDataTable
              :columns="columns"
              :data="puzzles"
              :row-props="rowProps"
              :row-key="(row: SoupPuzzle) => row.id"
              :bordered="false"
              :single-line="false"
              :pagination="puzzles.length > 15 ? { pageSize: 15 } : false"
            />
            <p class="table-hint">点击行查看完整汤面与汤底。</p>
          </section>

          <SchemaPage kind="turtleSoup" embedded />
        </template>
      </PageState>
    </template>

    <SchemaPage v-else-if="activeTab === 'umaRace'" kind="umaRace" embedded />
    <SchemaPage v-else-if="activeTab === 'deltaForce'" kind="deltaForce" embedded />
  </div>
</template>

<style scoped>
.games-page {
  max-width: 1180px;
}
.soup-summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  padding: 18px 22px;
}
.stats {
  display: flex;
  gap: 36px;
}
.stats > div {
  display: grid;
  gap: 4px;
}
.stats span {
  font-size: 12px;
  color: var(--c-muted);
}
.stats strong {
  font-size: 22px;
  font-weight: 550;
}
.stats strong.warn {
  color: #d48806;
}
.summary-side {
  display: grid;
  gap: 8px;
  justify-items: end;
}
.pending-hint {
  font-size: 12px;
  color: #d48806;
}
.live-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.soup-generate {
  padding: 16px 22px;
}
.generate-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
}
.generate-row p {
  color: var(--c-muted);
  font-size: 12px;
  margin-top: 4px;
  max-width: 60ch;
}
.summary-label {
  display: block;
  font-size: 13px;
  font-weight: 550;
}
.generate-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.generate-log {
  margin-top: 10px;
  padding: 8px 12px;
  background: var(--c-soft);
  border-radius: 8px;
  font-size: 12px;
  color: var(--c-muted);
  line-height: 1.7;
  max-height: 150px;
  overflow: auto;
}
.soup-table-panel {
  padding: 16px 16px 12px;
}
.table-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 6px 12px;
}
.soup-title {
  display: grid;
  gap: 2px;
}
.soup-meta {
  font-size: 11px;
  color: var(--c-muted);
}
.soup-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.table-hint {
  padding: 8px 6px 2px;
  font-size: 12px;
  color: var(--c-muted);
}
.detail-block { display: grid; gap: 8px; }
.detail-line { display: grid; grid-template-columns: 52px 1fr; gap: 10px; font-size: 13px; line-height: 1.7; }
.detail-label { color: var(--c-muted); flex-shrink: 0; }
.detail-sec-title { font-size: 12px; color: var(--c-muted); margin: 10px 0 6px; }
.audit-row { border: 1px solid var(--c-border); border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; }
.audit-head { display: flex; align-items: center; gap: 8px; }
.audit-meta { font-size: 11px; color: var(--c-muted); margin-left: auto; }
.audit-reason { font-size: 12px; margin-top: 4px; color: var(--c-text); }
.audit-hole { font-size: 12px; color: var(--c-danger); margin-top: 2px; }
.audit-empty { font-size: 12px; color: var(--c-muted); }
.audit-actions { margin-top: 8px; display: flex; justify-content: flex-end; }
:global(.soup-detail-rich) { max-height: 65vh; overflow: auto; }
:global(.soup-detail) {
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  max-height: 60vh;
  overflow: auto;
  margin: 0;
}
@media (max-width: 736px) {
  .soup-summary {
    flex-wrap: wrap;
  }
  .stats {
    gap: 22px;
  }
  .summary-side {
    justify-items: start;
  }
  .live-list {
    justify-content: flex-start;
  }
  .generate-row {
    flex-wrap: wrap;
  }
}
</style>
