<script setup lang="ts">
import { computed, h, onBeforeUnmount, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NTab,
  NTabs,
  NTag,
  useDialog,
  useMessage,
  type DataTableColumns
} from 'naive-ui'
import { api } from '../lib/api'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import SchemaPage from './SchemaPage.vue'

type SoupStatus = 'active' | 'pending' | 'retired'
type AuditDomain = 'structure' | 'playability' | 'logic' | 'simulation'
interface SoupAudit {
  domain: AuditDomain
  pass: boolean
  reason: string
  holes?: string[]
  at: number
  model?: string
  contentHash?: string
  repairable?: boolean
}
interface SoupPuzzle {
  id: string
  title: string
  difficulty: string
  tags: string[]
  status: SoupStatus
  surface: string
  solution: string
  keyPoints: string[]
  hints: string[]
  ratingCount: number
  ratingAverage: number | null
  plays: number
  createdAt: number
  audits: SoupAudit[]
  manualScore: number | null
  manualScoreReason?: string
  contentHash: string
  eligible: boolean
  playable?: boolean
  familyId?: string
  parentPuzzleId?: string
  version?: number
  statusHistory?: { from: SoupStatus; to: SoupStatus; reason: string; actor: string; at: number }[]
  feedback?: { score: number; comment: string; at: number; category?: string }[]
}
interface SoupCandidate {
  id: string
  familyId: string
  sourcePuzzleId?: string
  status: string
  stage: string
  failureKind?: string
  lastError?: string
  repairReason?: string
  currentVersion: number
  updatedAt: number
  versions: {
    version: number
    puzzle: SoupPuzzle
    audits: SoupAudit[]
    issues: string[]
    contentHash: string
  }[]
}
interface SoupOverview {
  puzzles: SoupPuzzle[]
  sessions: { groupId: string; phase: string; puzzleId: string; players: number }[]
  generating: {
    id: string
    kind: string
    running: boolean
    total: number
    added: number
    failed: number
    skipped: number
    log: string[]
  }
  freshPoolTarget: number
  inventory: {
    fresh: number
    available: number
    pending: number
    retired: number
    needsAudit: number
  }
  diagnostics: {
    completed: number
    solved: number
    ratings: number
    averageQuestions: number
    averageHints: number
    feedbackCategories: Record<string, number>
    endedBy: Record<string, number>
  }
}
const message = useMessage()
const dialog = useDialog()
const loading = ref(true)
const error = ref('')
const overview = ref<SoupOverview | null>(null)
const candidates = ref<SoupCandidate[]>([])
const activeTab = ref('turtleSoup')
const generatingCount = ref(3)
const statusFilter = ref('all')
const selectedId = ref('')
const selected = computed(
  () => overview.value?.puzzles.find((item) => item.id === selectedId.value) || null
)
const parentPuzzle = computed(() =>
  overview.value?.puzzles.find((item) => item.id === selected.value?.parentPuzzleId)
)
const showCandidates = ref(true)
const expandedVersions = ref(new Set<string>())
function toggleVersions(id: string) {
  const next = new Set(expandedVersions.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedVersions.value = next
}

const auditingId = ref('')
const busy = computed(() => overview.value?.generating.running || false)
const candidateError = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null
let disposed = false
let loadSequence = 0
const statusLabel: Record<string, string> = { pending: '待审', active: '投放中', retired: '已出池' }
const statusType = { pending: 'warning', active: 'success', retired: 'default' } as const
const auditDomainLabel: Record<AuditDomain, string> = {
  structure: '结构审核',
  playability: '可玩性审题',
  logic: '逻辑审计',
  simulation: '问答推演'
}
const domains: AuditDomain[] = ['structure', 'playability', 'logic', 'simulation']
const phaseLabel: Record<string, string> = {
  joining: '报名中',
  choosing: '选汤中',
  playing: '问答中',
  reveal: '评分窗口'
}
const stageLabel: Record<string, string> = {
  generation: '出题',
  structure: '结构审核',
  playability: '可玩性审题',
  logic: '逻辑审计',
  simulation: '问答推演',
  repair: '修复',
  save: '入库'
}
const feedbackCategoryLabel: Record<string, string> = {
  logic: '逻辑',
  clues: '线索',
  hints: '提示',
  host: '主持',
  difficulty: '难度',
  taste: '个人口味',
  technical: '技术失败',
  other: '其他'
}
const candidateStatusLabel: Record<string, string> = {
  draft: '草稿',
  reviewing: '审核中',
  repairing: '修复中',
  pending: '已入待审池',
  failed: '待处理',
  recovered: '已恢复'
}
const statusOptions = [
  { value: 'all', label: '全部' },
  ...Object.entries(statusLabel).map(([value, label]) => ({ value, label }))
]
const puzzles = computed(() =>
  (overview.value?.puzzles || []).filter(
    (item) => statusFilter.value === 'all' || item.status === statusFilter.value
  )
)
// 按版本(contentHash)分组的完整审计历史:当前版在最前,修复前版本按时间倒序
const auditHistory = computed(() => {
  if (!selected.value?.audits?.length) return []
  const currentHash = selected.value?.contentHash
  const groups = new Map<string, { label: string; isCurrent: boolean; audits: typeof selected.value.audits }>()
  const sorted = [...selected.value.audits].sort((a, b) => a.at - b.at)
  for (const audit of sorted) {
    const hash = audit.contentHash || 'unknown'
    if (!groups.has(hash)) {
      const isCurrent = hash === currentHash
      const versionNum = (audit as any).version || 0
      groups.set(hash, {
        label: isCurrent ? `当前版${versionNum ? ` (第${versionNum}版)` : ''}` : `修复前版本${versionNum ? ` (第${versionNum}版)` : ''}`,
        isCurrent,
        audits: []
      })
    }
    groups.get(hash)!.audits.push(audit)
  }
  // 当前版排最前,其余按最后一审时间倒序
  return [...groups.entries()]
    .map(([hash, group]) => ({ hash, ...group }))
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
      const aTime = a.audits.at(-1)?.at || 0
      const bTime = b.audits.at(-1)?.at || 0
      return bTime - aTime
    })
})
const unresolved = computed(() =>
  candidates.value.filter((item) => !['pending', 'recovered'].includes(item.status))
)

async function loadOverview() {
  const sequence = ++loadSequence
  try {
    const value = await api<SoupOverview>('/api/games/turtle-soup/overview')
    if (disposed || sequence !== loadSequence) return
    overview.value = value
    error.value = ''
    if ((value.generating.running || value.sessions.length) && !pollTimer)
      pollTimer = setInterval(loadOverview, 5000)
    else if (!value.generating.running && !value.sessions.length) stopPolling()
    try {
      const result = await api<{ candidates: SoupCandidate[] }>('/api/games/turtle-soup/candidates')
      if (!disposed && sequence === loadSequence) {
        candidates.value = result.candidates
        candidateError.value = ''
      }
    } catch (cause: any) {
      candidateError.value = cause.message || '候选记录加载失败'
    }
  } catch (cause: any) {
    if (sequence === loadSequence) error.value = cause.message || '题库加载失败'
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
onBeforeUnmount(() => {
  disposed = true
  stopPolling()
})
void loadOverview()

const columns: DataTableColumns<SoupPuzzle> = [
  {
    title: '标题',
    key: 'title',
    minWidth: 160,
    render: (row) =>
      h('div', { class: 'soup-title' }, [
        h('strong', row.title),
        h(
          'span',
          { class: 'soup-meta' },
          `${row.difficulty} · 第 ${row.version || 1} 版${row.parentPuzzleId ? ' · 修复版' : ''}`
        )
      ])
  },
  {
    title: '状态',
    key: 'status',
    width: 110,
    render: (row) =>
      h(
        NTag,
        {
          size: 'small',
          bordered: false,
          type: row.status === 'active' && !row.eligible ? 'warning' : statusType[row.status]
        },
        {
          default: () =>
            row.status === 'active' && !row.eligible
              ? row.playable
                ? '投放中·待补审'
                : '审核暂停'
              : statusLabel[row.status]
        }
      )
  },
  {
    title: '评价',
    key: 'rating',
    width: 145,
    render: (row) =>
      [
        row.manualScore ? `${row.manualScore}★ 管理员` : '',
        row.ratingCount ? `${row.ratingAverage}★ / ${row.ratingCount}票` : ''
      ]
        .filter(Boolean)
        .join(' · ') || '暂无评价'
  },
  { title: '开局', key: 'plays', width: 65 },
  {
    title: '操作',
    key: 'actions',
    width: 185,
    render: (row) =>
      h('div', { class: 'soup-actions', onClick: (event: Event) => event.stopPropagation() }, [
        row.status === 'pending'
          ? h(
              NButton,
              {
                size: 'tiny',
                type: 'primary',
                secondary: true,
                disabled: !row.eligible,
                onClick: () => openAction('status', row, 'active')
              },
              { default: () => '过审' }
            )
          : null,
        row.status === 'active'
          ? h(
              NButton,
              {
                size: 'tiny',
                secondary: true,
                onClick: () => openAction('status', row, 'retired')
              },
              { default: () => '出池' }
            )
          : null,
        row.status === 'retired'
          ? h(
              NButton,
              {
                size: 'tiny',
                secondary: true,
                onClick: () => openAction('status', row, 'pending')
              },
              { default: () => '提交复审' }
            )
          : null,
        h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            disabled: busy.value,
            onClick: () => openAction('repair', row)
          },
          { default: () => '修复' }
        ),
        h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            onClick: () =>
              dialog.warning({
                title: `删除【${row.title}】？`,
                content: '仅可删除未游玩、未被选中且没有修复子版本的汤。删除后无法恢复。',
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
const rowProps = (row: SoupPuzzle) => ({
  style: 'cursor:pointer',
  onClick: () => {
    selectedId.value = row.id
  }
})
const action = ref<{
  kind: 'status' | 'repair' | 'score'
  id: string
  title: string
  status?: SoupStatus
  contentHash: string
} | null>(null)
const actionReason = ref('')
const actionScore = ref<number | null>(5)
const actionSaving = ref(false)
const actionError = ref('')
const actionTitle = computed(() =>
  action.value?.kind === 'repair'
    ? '修复并生成新版本'
    : action.value?.kind === 'score'
      ? '管理员评价'
      : `将题目设为${statusLabel[action.value?.status || 'pending']}`
)
function openAction(kind: 'status' | 'repair' | 'score', row: SoupPuzzle, status?: SoupStatus) {
  action.value = { kind, id: row.id, title: row.title, status, contentHash: row.contentHash }
  actionReason.value = kind === 'score' || kind === 'repair' ? row.manualScoreReason || '' : ''
  actionScore.value = row.manualScore || 5
  actionError.value = ''
}
async function submitAction() {
  if (!action.value) return
  const current = action.value
  const reason = actionReason.value.trim()
  if ((current.kind !== 'score' || (actionScore.value ?? 0) <= 3) && !reason) {
    actionError.value = '请填写原因或需要修复的问题'
    return
  }
  actionSaving.value = true
  actionError.value = ''
  try {
    const url = `/api/games/turtle-soup/puzzles/${encodeURIComponent(current.id)}`
    if (current.kind === 'status')
      await api(`${url}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: current.status, reason, contentHash: current.contentHash })
      })
    else if (current.kind === 'score')
      await api(`${url}/score`, {
        method: 'PUT',
        body: JSON.stringify({ score: actionScore.value, reason })
      })
    else await api(`${url}/repair`, { method: 'POST', body: JSON.stringify({ reason }) })
    message.success(
      current.kind === 'repair' ? '修复任务已启动，通过审核的新版本将进入待审池' : '已保存'
    )
    action.value = null
    await loadOverview()
  } catch (cause: any) {
    actionError.value = cause.message || '保存失败'
  } finally {
    actionSaving.value = false
  }
}
async function clearScore(row: SoupPuzzle) {
  try {
    await api(`/api/games/turtle-soup/puzzles/${encodeURIComponent(row.id)}/score`, {
      method: 'DELETE'
    })
    await loadOverview()
  } catch (cause: any) {
    message.error(cause.message || '清除失败')
  }
}
async function reaudit(row: SoupPuzzle) {
  auditingId.value = row.id
  try {
    const result = await api<{ eligible: boolean }>(
      `/api/games/turtle-soup/puzzles/${encodeURIComponent(row.id)}/audit`,
      { method: 'POST', body: '{}' }
    )
    if (result.eligible) message.success('当前内容已通过全部审核，可人工确认投放')
    else message.warning('审核未全部通过，已暂停投放；可查看问题后修复')
    await loadOverview()
  } catch (cause: any) {
    message.error(cause.message || '审核未完成')
  } finally {
    auditingId.value = ''
  }
}
async function removePuzzle(row: SoupPuzzle) {
  try {
    await api(`/api/games/turtle-soup/puzzles/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
    if (selectedId.value === row.id) selectedId.value = ''
    await loadOverview()
  } catch (cause: any) {
    message.error(cause.message || '删除失败')
  }
}
async function startGeneration() {
  try {
    await api('/api/games/turtle-soup/generate', {
      method: 'POST',
      body: JSON.stringify({ count: generatingCount.value })
    })
    message.success('生成任务已启动')
    await loadOverview()
  } catch (cause: any) {
    message.error(cause.message || '启动失败')
  }
}
async function recoverCandidate(item: SoupCandidate) {
  try {
    await api(`/api/games/turtle-soup/candidates/${encodeURIComponent(item.id)}/recover`, {
      method: 'POST',
      body: '{}'
    })
    message.success('已开始处理候选，结果将在待审池或失败原因中更新')
    await loadOverview()
  } catch (cause: any) {
    message.error(cause.message || '重试失败')
  }
}
const candidatePuzzle = (item: SoupCandidate) => item.versions.at(-1)?.puzzle
const candidateCanRecover = (item: SoupCandidate) =>
  !['pending', 'recovered'].includes(item.status) &&
  !item.versions.at(-1)?.audits.some((audit) => !audit.pass && audit.repairable === false)
const formatTime = (at: number) => new Date(at).toLocaleString()
</script>

<template>
  <div class="page-stack games-page">
    <PageHeader
      title="游戏"
      eyebrow="机器人能力"
      description="管理海龟汤的生成、质量审核、回收修复与游戏参数。"
    />
    <NTabs :value="activeTab" type="line" @update:value="activeTab = $event">
      <NTab name="turtleSoup">海龟汤</NTab><NTab name="umaRace">赛马娘</NTab
      ><NTab name="deltaForce">三角洲</NTab>
    </NTabs>
    <template v-if="activeTab === 'turtleSoup'">
      <PageState
        :loading="loading && !overview"
        :error="!overview ? error : ''"
        @retry="loadOverview"
      >
        <template v-if="overview">
          <p v-if="error" class="operation-error" role="alert">
            {{ error }} <NButton size="tiny" @click="loadOverview">重试</NButton>
          </p>
          <section class="panel soup-summary">
            <div class="stats">
              <div>
                <span>可玩鲜汤 / {{ overview.freshPoolTarget }}</span
                ><strong>{{ overview.inventory.fresh }}</strong>
              </div>
              <div>
                <span>可投放总数</span><strong>{{ overview.inventory.available }}</strong>
              </div>
              <div>
                <span>待审积压</span><strong class="warn">{{ overview.inventory.pending }}</strong>
              </div>
              <div>
                <span>待处理候选</span><strong class="warn">{{ unresolved.length }}</strong>
              </div>
              <div>
                <span>进行中</span
                ><strong>{{ overview.sessions.filter((s) => s.phase !== 'reveal').length }}</strong>
              </div>
            </div>
            <div class="summary-side">
              <div v-if="overview.inventory.pending" class="pending-hint">
                待审汤尚不能投放，请审核当前版本后确认。
              </div>
              <div v-if="overview.inventory.needsAudit" class="pending-hint">
                {{ overview.inventory.needsAudit }} 道题尚未完成当前内容审核，可打开详情补审。
              </div>
              <div class="live-list">
                <NTag
                  v-for="item in overview.sessions"
                  :key="item.groupId"
                  size="small"
                  :bordered="false"
                  >群 {{ item.groupId }} · {{ phaseLabel[item.phase] }} · {{ item.players }}人</NTag
                >
              </div>
            </div>
          </section>
          <section class="panel soup-generate">
            <div class="generate-row">
              <div>
                <span class="summary-label">生成新汤</span>
                <p>
                  结构、可玩性、逻辑与问答推演均通过后进入待审池。推演是模型审题证据，仍需管理员终审；失败候选保留问题和版本，可继续修复。
                </p>
              </div>
              <div class="generate-actions">
                <NInputNumber
                  v-model:value="generatingCount"
                  :min="1"
                  :max="10"
                  size="small"
                  style="width: 90px"
                /><NButton
                  size="small"
                  type="primary"
                  secondary
                  :disabled="busy"
                  @click="startGeneration"
                  >{{
                    busy
                      ? `处理中 ${overview.generating.added + overview.generating.failed + overview.generating.skipped}/${overview.generating.total}`
                      : '开始生成'
                  }}</NButton
                >
              </div>
            </div>
            <div v-if="overview.generating.id" class="generate-log">
              <div>
                任务 {{ overview.generating.id.slice(0, 8) }} · 成功
                {{ overview.generating.added }} · 失败 {{ overview.generating.failed }} · 未执行
                {{ overview.generating.skipped }}
              </div>
              <div v-for="(line, index) in overview.generating.log.slice(-8)" :key="index">
                {{ line }}
              </div>
            </div>
          </section>
          <section class="panel soup-table-panel">
            <div class="table-toolbar">
              <NSelect
                v-model:value="statusFilter"
                :options="statusOptions"
                size="small"
                style="width: 130px"
              /><NButton size="small" quaternary @click="loadOverview">刷新</NButton>
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
            <p class="table-hint">
              点击题目查看当前审核、评价、修复前后对照和投放记录。旧版本保留游玩统计。
            </p>
          </section>
          <section class="panel rejected-panel">
            <button type="button" class="rejected-summary" @click="showCandidates = !showCandidates">
              {{ showCandidates ? '▼' : '▶' }} 候选回收区 · {{ unresolved.length }} 道待处理 / 共 {{ candidates.length }} 条
            </button>
            <div v-if="showCandidates">
              <p v-if="candidateError" class="operation-error" role="alert">{{ candidateError }}</p>
              <p v-else-if="!candidates.length" class="table-hint">
                暂无失败或修复记录。技术失败可以重试，内容问题会带着原因修复后重新审核。
              </p>
              <div v-for="item in candidates" :key="item.id" class="rejected-item">
                <div class="rejected-head">
                  <strong
                    >{{ candidatePuzzle(item)?.title || '未形成完整题目' }} · 第
                    {{ item.currentVersion }} 版</strong
                  ><NTag size="small" :bordered="false">{{
                    candidateStatusLabel[item.status] || item.status
                  }}</NTag>
                </div>
                <p class="candidate-meta">
                  {{ stageLabel[item.stage] || item.stage }} ·
                  {{ item.failureKind === 'technical' ? '调用或解析失败' : '内容质量处理' }} ·
                  {{ formatTime(item.updatedAt) }}
                </p>
                <p v-if="item.lastError || item.repairReason" class="hole">
                  {{ item.lastError || item.repairReason }}
                </p>
                <div v-if="item.versions.length" class="candidate-versions">
                  <p class="rejected-summary">内容及修复历史（{{ item.versions.length }} 版）</p>
                  <div
                    v-for="version in item.versions"
                    :key="version.version"
                    class="candidate-version"
                  >
                    <strong>第 {{ version.version }} 版</strong>
                    <p>汤面：{{ version.puzzle.surface }}</p>
                    <p>汤底：{{ version.puzzle.solution }}</p>
                    <p v-for="(issue, i) in version.issues" :key="i" class="hole">{{ issue }}</p>
                  </div>
                </div>
                <NButton
                  v-if="candidateCanRecover(item)"
                  size="small"
                  secondary
                  :disabled="busy"
                  @click="recoverCandidate(item)"
                  >{{ item.failureKind === 'technical' ? '继续重试' : '修复并重新审核' }}</NButton
                >
              </div>
            </div>
          </section>
          <section class="panel diagnostics">
            <span class="summary-label">游玩反馈</span>
            <p>
              已完成 {{ overview.diagnostics.completed }} 局 · 破汤
              {{ overview.diagnostics.solved }} 局 · 平均
              {{ overview.diagnostics.averageQuestions }} 次提问 /
              {{ overview.diagnostics.averageHints }} 条提示 ·
              {{ overview.diagnostics.ratings }} 条评分
            </p>
            <div class="live-list">
              <NTag
                v-for="(count, category) in overview.diagnostics.feedbackCategories"
                :key="category"
                size="small"
                :bordered="false"
                >{{ feedbackCategoryLabel[category] }} {{ count }}</NTag
              >
            </div>
            <p class="table-hint">
              无人继续 {{ overview.diagnostics.endedBy.idle_timeout || 0 }} 局 · 全员投降
              {{ overview.diagnostics.endedBy.all_surrendered || 0 }} 局 · 中途换汤
              {{ overview.diagnostics.endedBy.switched || 0 }}
              局。评价用于区分内容问题与主持、提示或难度问题。
            </p>
          </section>
          <SchemaPage kind="turtleSoup" embedded />
        </template>
      </PageState>
    </template>
    <SchemaPage v-else-if="activeTab === 'umaRace'" kind="umaRace" embedded /><SchemaPage
      v-else-if="activeTab === 'deltaForce'"
      kind="deltaForce"
      embedded
    />
    <NModal
      v-if="selected"
      :show="true"
      @update:show="
        (value) => {
          if (!value) selectedId = ''
        }
      "
    >
      <NCard
        :title="`${selected.title} · 第 ${selected.version || 1} 版 · ${statusLabel[selected.status]}`"
        class="soup-detail-card"
        closable
        @close="selectedId = ''"
      >
        <div class="soup-detail-rich">
          <div class="comparison" :class="{ paired: parentPuzzle }">
            <div v-if="parentPuzzle">
              <h4>修复前 · {{ parentPuzzle.title }}</h4>
              <p>汤面：{{ parentPuzzle.surface }}</p>
              <p>汤底：{{ parentPuzzle.solution }}</p>
            </div>
            <div>
              <h4>{{ parentPuzzle ? '当前版本' : '题目内容' }}</h4>
              <p>汤面：{{ selected.surface }}</p>
              <p>汤底：{{ selected.solution }}</p>
              <p>关键点：{{ selected.keyPoints.join(' / ') }}</p>
              <p>提示：{{ selected.hints.join(' / ') }}</p>
            </div>
          </div>
          <div class="detail-sec-title">审核历史（按版本，修复前的也能看到）</div>
          <div v-for="group in auditHistory" :key="group.hash" class="audit-version-group" :class="{ 'audit-current': group.isCurrent }">
            <div class="audit-version-label">
              {{ group.isCurrent ? '✓ ' : '↩ ' }}{{ group.label }}
              <span v-if="!group.isCurrent" class="audit-version-hint">（此版本的审核结论）</span>
            </div>
            <div v-for="audit in group.audits" :key="`${audit.domain}-${audit.at}`" class="audit-row">
              <div class="audit-head">
                <NTag size="small" :bordered="false" :type="audit.pass ? 'success' : 'error'">{{
                  audit.pass ? '通过' : '未过'
                }}</NTag>
                <strong>{{ auditDomainLabel[audit.domain] || audit.domain }}</strong>
                <span class="audit-meta">{{ formatTime(audit.at) }}</span>
              </div>
              <p class="audit-reason">{{ audit.reason }}</p>
              <p v-for="(hole, i) in audit.holes || []" :key="i" class="audit-hole">{{ hole }}</p>
            </div>
          </div>
          <p v-if="!auditHistory.length" class="table-hint">尚无审核记录。点击"重新审核"可按当前标准补齐。</p>
          <div class="audit-actions">
            <NButton
              size="small"
              secondary
              :loading="auditingId === selected.id"
              :disabled="!!auditingId"
              @click="reaudit(selected)"
              >重新审核</NButton
            ><NButton
              size="small"
              secondary
              :disabled="busy"
              @click="openAction('repair', selected)"
              >修复为新版本</NButton
            ><NButton
              v-if="selected.status === 'pending'"
              size="small"
              type="primary"
              :disabled="!selected.eligible"
              @click="openAction('status', selected, 'active')"
              >确认投放</NButton
            >
          </div>
          <div class="detail-sec-title">管理员评价与玩家反馈</div>
          <p>
            {{
              selected.manualScore
                ? `管理员 ${selected.manualScore} 分：${selected.manualScoreReason || '未填写说明'}`
                : '暂无管理员评价'
            }}
          </p>
          <div class="audit-actions">
            <NButton size="small" @click="openAction('score', selected)">评价并说明原因</NButton
            ><NButton
              v-if="selected.manualScore"
              size="small"
              quaternary
              @click="clearScore(selected)"
              >清除标记</NButton
            >
          </div>
          <p v-for="(item, i) in selected.feedback || []" :key="i">
            {{ item.score }}★ · {{ feedbackCategoryLabel[item.category || 'other'] }} ·
            {{ item.comment }}
          </p>
          <details v-if="selected.statusHistory?.length">
            <summary class="rejected-summary">投放与审核记录</summary>
            <p v-for="(item, i) in selected.statusHistory" :key="i">
              {{ formatTime(item.at) }} · {{ statusLabel[item.from] }} →
              {{ statusLabel[item.to] }} · {{ item.actor }}：{{ item.reason }}
            </p>
          </details>
        </div>
      </NCard>
    </NModal>
    <NModal
      v-if="action"
      :show="true"
      @update:show="
        (value) => {
          if (!value && !actionSaving) action = null
        }
      "
    >
      <NCard
        :title="actionTitle"
        class="soup-action-card"
        closable
        @close="!actionSaving && (action = null)"
      >
        <p>【{{ action.title }}】</p>
        <p v-if="action.kind === 'repair'" class="table-hint">
          保留原题和原有评分，修复后生成新版本；通过全部审核后仍需人工确认投放。
        </p>
        <NInputNumber
          v-if="action.kind === 'score'"
          v-model:value="actionScore"
          :min="1"
          :max="5"
          :precision="0"
        />
        <NInput
          v-model:value="actionReason"
          type="textarea"
          :maxlength="1000"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :placeholder="
            action.kind === 'repair'
              ? '指出需要修复的逻辑、提示、难度或主持问题'
              : '说明本次操作原因（3 分及以下的评价必填）'
          "
        />
        <p v-if="actionError" class="operation-error" role="alert">{{ actionError }}</p>
        <template #footer
          ><div class="audit-actions">
            <NButton :disabled="actionSaving" @click="action = null">取消</NButton
            ><NButton type="primary" :loading="actionSaving" @click="submitAction">{{
              action.kind === 'repair' ? '开始修复' : '保存'
            }}</NButton>
          </div></template
        >
      </NCard>
    </NModal>
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
  flex-wrap: wrap;
  gap: 24px;
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
:deep(.soup-title) {
  display: grid;
  gap: 2px;
}
:deep(.soup-meta) {
  font-size: 11px;
  color: var(--c-muted);
}
:deep(.soup-actions) {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.table-hint {
  padding: 8px 6px 2px;
  font-size: 12px;
  color: var(--c-muted);
}
.detail-block {
  display: grid;
  gap: 8px;
}
.detail-line {
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 10px;
  font-size: 13px;
  line-height: 1.7;
}
.detail-label {
  color: var(--c-muted);
  flex-shrink: 0;
}
.detail-sec-title {
  font-size: 12px;
  color: var(--c-muted);
  margin: 10px 0 6px;
}
.audit-version-group { border-left: 3px solid var(--c-border); padding-left: 12px; margin-bottom: 12px; }
.audit-version-group.audit-current { border-left-color: var(--c-accent); }
.audit-version-label { font-size: 12px; font-weight: 550; color: var(--c-text); margin-bottom: 6px; }
.audit-version-hint { font-weight: 400; color: var(--c-muted); font-size: 11px; }
.audit-row {
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 6px;
}
.audit-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.audit-meta {
  font-size: 11px;
  color: var(--c-muted);
  margin-left: auto;
}
.audit-reason {
  font-size: 12px;
  margin-top: 4px;
  color: var(--c-text);
}
.audit-hole {
  font-size: 12px;
  color: var(--c-danger);
  margin-top: 2px;
}
.audit-empty {
  font-size: 12px;
  color: var(--c-muted);
}
.manual-score-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--c-border);
}
:global(.star-row) {
  display: flex;
  align-items: center;
  gap: 2px;
}
:global(.star-btn) {
  appearance: none;
  border: none;
  background: transparent;
  font-size: 18px;
  color: var(--c-border);
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  transition: color 0.15s;
}
:global(.star-btn:hover) {
  color: var(--c-accent);
}
:global(.star-btn.active) {
  color: #f5a623;
}
:global(.star-value) {
  font-size: 12px;
  color: #f5a623;
  margin-left: 6px;
}
:global(.star-hint) {
  font-size: 11px;
  color: var(--c-muted);
  margin-left: 6px;
}
.audit-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
:global(.soup-detail-rich) {
  max-height: 65vh;
  overflow: auto;
}
:global(.soup-detail) {
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  max-height: 60vh;
  overflow: auto;
  margin: 0;
}
.rejected-panel {
  padding: 12px 22px;
}
.rejected-summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--c-muted);
  padding: 4px 0;
}
.rejected-item {
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 8px;
}
.rejected-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.rejected-at {
  font-size: 11px;
  color: var(--c-muted);
}
.rejected-body {
  display: grid;
  gap: 6px;
}
.rejected-line {
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}
.rejected-line > span {
  color: var(--c-muted);
  flex-shrink: 0;
}
.rejected-holes {
  margin-top: 4px;
}
.hole {
  font-size: 12px;
  color: var(--c-danger);
  line-height: 1.5;
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
.soup-detail-card {
  width: min(960px, 94vw);
}
.soup-action-card {
  width: min(560px, 94vw);
}
.soup-action-card :deep(.n-input) {
  margin-top: 12px;
}
.comparison {
  display: grid;
  gap: 16px;
}
.comparison.paired {
  grid-template-columns: 1fr 1fr;
}
.comparison > div {
  padding: 12px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
}
.comparison h4 {
  margin: 0 0 8px;
}
.comparison p,
.candidate-version p {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.7;
}
.operation-error {
  color: var(--c-danger);
  font-size: 13px;
}
.candidate-meta {
  color: var(--c-muted);
  font-size: 12px;
}
.candidate-version {
  padding: 10px;
  margin: 8px 0;
  background: var(--c-soft);
  border-radius: 8px;
}
.diagnostics {
  padding: 16px 22px;
  font-size: 13px;
}
.rejected-item .n-button {
  margin-top: 8px;
}
@media (max-width: 736px) {
  .comparison.paired {
    grid-template-columns: 1fr;
  }
}
</style>
