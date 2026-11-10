<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NCheckbox, NDataTable, NDrawer, NDrawerContent, NInput, NInputNumber, NSelect, NSwitch, NTag, useDialog, type DataTableColumns } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'

type CharacterOperation = 'pause' | 'resume' | 'cancel-goal' | 'pause-goal' | 'resume-goal' | 'delete-memory'
type ActivityOperation = 'work-archive' | 'work-restore' | 'work-delete' | 'subscription-pause' | 'subscription-resume' | 'subscription-remove' | 'shared-approve' | 'shared-delete' | 'reflection-reset'
interface ActivitiesView {
  works: { id: string; title: string; kind: string; status: string; versions: { revision: number; content: string; evidenceRefs: string[]; createdAt: number }[]; updatedAt: number }[]
  subscriptions: { id: string; title: string; kind: string; status: string; url: string; nextPollAt: number; failures: number; items: { id: string; title: string; summary: string; receivedAt: number }[] }[]
  reflection: { lastRunAt: number; nextRunAt: number; lastOutcome: string; runsToday: number } | null
  shared: { id: string; content: string; kind: string; createdAt: number }[]
  sharedPending: { id: string; content: string; kind: string; sourceMemoryId: string; createdAt: number }[]
  capabilities: { name: string; description: string; available: boolean }[]
}
interface CharacterView {
  scope: { botId: string; personaId: string; groupId: string }
  paused: boolean
  decision?: { kind: string; reason: string; at: number }
  memories: { id: string; kind: string; content: string; epistemic: string; evidenceRefs: string[]; createdAt: number; updatedAt: number }[]
  goals: { id: string; title: string; motivation: string; nextStep: string; completionCriteria: string; status: string; nextCheckAt: number; expiresAt: number; attempts: number; maxAttempts: number; lastOutcome?: string }[]
  receipts: { id: string; toolName: string; status: string; summary: string; at: number; goalId?: string }[]
}
interface GroupRow {
  groupId: string
  active: boolean
  running: boolean
  mode: string
  replyMode?: 'atOnly' | 'auto' | 'active'
  unreadCount: number
  budget: { turns: number; maxTurnsPerDay: number; tokens: number; dailyCostCny: number; capOverridden?: boolean; turnsCapOverridden?: boolean; todayCostCny: number }
  lastWakeReason: string | null
  historyLength: number
  pendingEvents: { id: string; content: string; dueAt?: number }[]
  memes: { id: string; content: string; count: number; origin: string }[]
  affinity: { userId: string; score: number }[]
  initialPrompt: string
  character?: CharacterView
  activities?: ActivitiesView
}
interface Overview { enabled: boolean; allGroups: boolean; disabled: string[]; budgetDefaultCny: number; groups: GroupRow[]; groupNames?: Record<string, string> }

const overview = ref<Overview | null>(null)
const dialog = useDialog()
const loading = ref(false)
const error = ref('')
const detailId = ref('')
const detail = ref<GroupRow | null>(null)
const drawerOpen = ref(false)
const initPromptDraft = ref('')
const savingPrompt = ref(false)
const promptMessage = ref('')
const defaultCapDraft = ref<number | null>(null)
const savingDefaultCap = ref(false)
const defaultCapMessage = ref('')
const capDraft = ref<number | null>(null)
const savingCap = ref(false)
const capMessage = ref('')
const turnsDraft = ref<number | null>(null)
const turnsUnlimited = ref(false)
const savingTurns = ref(false)
const turnsMessage = ref('')
const characterBusy = ref(false)
const characterMessage = ref('')
const activityBusy = ref(false)
const activityMessage = ref('')
let detailRequest = 0
let timer: number | null = null

async function load() {
  loading.value = true
  error.value = ''
  try {
    overview.value = await api<Overview>('/api/simulation/overview')
    defaultCapDraft.value = overview.value.budgetDefaultCny
  } catch (e: any) {
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), 30000)
})
onBeforeUnmount(() => { if (timer) window.clearInterval(timer) })

async function toggle(row: GroupRow) {
  try {
    await api('/api/simulation/group', { method: 'POST', body: JSON.stringify({ group: row.groupId, action: row.active ? 'disable' : 'enable' }) })
    await load()
  } catch (e: any) {
    error.value = e?.message || '操作失败'
  }
}
const replyModeOptions = [
  { label: '仅@', value: 'atOnly' },
  { label: '自主', value: 'auto' },
  { label: '活跃', value: 'active' },
]
const replyModeLabels: Record<string, string> = { atOnly: '仅@', auto: '自主', active: '活跃' }
async function setReplyMode(row: GroupRow, value: string) {
  try {
    await api('/api/simulation/group', { method: 'POST', body: JSON.stringify({ group: row.groupId, action: 'reply-mode', mode: value }) })
    await load()
  } catch (e: any) {
    error.value = e?.message || '切换回复模式失败'
    await load()
  }
}
async function resetGroup(groupId: string) {
  dialog.warning({
    title: '重置仿真会话',
    content: `将清空群 ${groupId} 的回合历史、未读水位与今日预算（长期记忆与好感度保留）。此操作不可撤销，确定继续吗？`,
    positiveText: '重置',
    negativeText: '取消',
    onPositiveClick: () => doResetGroup(groupId),
  })
}
async function doResetGroup(groupId: string) {
  try {
    await api('/api/simulation/group', { method: 'POST', body: JSON.stringify({ group: groupId, action: 'reset' }) })
    await openDetail(groupId)
    await load()
  } catch (e: any) {
    error.value = e?.message || '重置失败'
  }
}
async function openDetail(groupId: string) {
  const request = ++detailRequest
  const result = await api<GroupRow>(`/api/simulation/group?group=${groupId}`)
  if (request !== detailRequest) return
  detail.value = result
  detailId.value = groupId
  characterMessage.value = ''
  activityMessage.value = ''
  initPromptDraft.value = detail.value?.initialPrompt || ''
  promptMessage.value = ''
  capDraft.value = detail.value?.budget?.dailyCostCny ?? null
  capMessage.value = ''
  const turnsCap = detail.value?.budget?.maxTurnsPerDay ?? null
  turnsUnlimited.value = turnsCap === -1
  turnsDraft.value = turnsUnlimited.value ? 40 : turnsCap
  turnsMessage.value = ''
  drawerOpen.value = true
}

const goalLabels: Record<string, string> = { active: '进行中', waiting: '等待中', paused: '已暂停', completed: '已完成', abandoned: '已放弃', failed: '已停止' }
const decisionLabels: Record<string, string> = { engage: '参与交流', silent: '保持安静', cannot: '能力不足', unauthorized: '权限不足', unwilling: '不愿意', deferred: '稍后再做' }
const memoryLabels: Record<string, string> = { experience: '经历', opinion: '观点', interest: '兴趣' }
const evidenceLabels: Record<string, string> = { reported: '他人提及', observed: '实际观察', inferred: '暂时判断', desired: '意愿或计划' }
const receiptLabels: Record<string, string> = { pending: '结果待确认', succeeded: '已确认成功', failed: '已确认失败', unknown: '结果未知' }
const goalEnded = (status: string) => ['completed', 'abandoned', 'failed'].includes(status)
function characterTime(at: number) {
  return Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—'
}
async function controlCharacter(operation: CharacterOperation, id?: string) {
  if (!detailId.value || characterBusy.value) return
  const group = detailId.value
  const request = detailRequest
  characterBusy.value = true
  characterMessage.value = ''
  try {
    const result = await api<{ message: string }>('/api/simulation/group', {
      method: 'POST', body: JSON.stringify({ group, action: 'character', operation, ...(id ? { id } : {}) })
    })
    if (detailId.value !== group || request !== detailRequest) return
    await openDetail(group)
    if (detailId.value === group) characterMessage.value = result.message
  } catch (e: any) {
    if (detailId.value === group) characterMessage.value = e?.message || '角色管理操作失败'
  } finally {
    characterBusy.value = false
  }
}
async function refreshCharacter() {
  const group = detailId.value
  try {
    await openDetail(group)
  } catch (e: any) {
    if (detailId.value === group) characterMessage.value = e?.message || '刷新角色状态失败'
  }
}
function removeCharacterMemory(id: string) {
  const group = detailId.value
  dialog.warning({
    title: '删除角色记忆', content: '删除这条记忆后，依赖它的观点和目标也会重新检查。',
    positiveText: '删除', negativeText: '保留',
    onPositiveClick: () => detailId.value === group ? controlCharacter('delete-memory', id) : undefined
  })
}
async function controlActivity(operation: ActivityOperation, id?: string, payload?: { revision: number }) {
  if (!detailId.value || activityBusy.value) return
  const group = detailId.value
  const request = detailRequest
  activityBusy.value = true
  activityMessage.value = ''
  try {
    const result = await api<{ message: string }>('/api/simulation/group', {
      method: 'POST', body: JSON.stringify({ group, action: 'activity', operation, ...(id ? { id } : {}), ...(payload ? { payload } : {}) })
    })
    if (detailId.value !== group || request !== detailRequest) return
    await openDetail(group)
    if (detailId.value === group) activityMessage.value = result.message
  } catch (e: any) {
    if (detailId.value === group && request === detailRequest) activityMessage.value = e?.message || '角色活动操作失败'
  } finally { activityBusy.value = false }
}
function confirmActivity(operation: ActivityOperation, id: string, title: string, content: string) {
  const group = detailId.value
  dialog.warning({ title, content, positiveText: '确认', negativeText: '取消', onPositiveClick: () => detailId.value === group ? controlActivity(operation, id) : undefined })
}
async function savePrompt() {
  savingPrompt.value = true
  try {
    const result = await api<{ message: string }>('/api/simulation/group', { method: 'POST', body: JSON.stringify({ group: detailId.value, action: 'initial-prompt', text: initPromptDraft.value }) })
    promptMessage.value = result.message
  } catch (e: any) {
    promptMessage.value = e?.message || '保存失败'
  } finally {
    savingPrompt.value = false
  }
}

async function saveDefaultCap() {
  savingDefaultCap.value = true
  defaultCapMessage.value = ''
  try {
    const result = await api<{ message: string }>('/api/simulation/budget-default', { method: 'POST', body: JSON.stringify({ cny: defaultCapDraft.value || 0 }) })
    defaultCapMessage.value = result.message
    await load()
  } catch (e: any) {
    defaultCapMessage.value = e?.message || '保存失败'
  } finally {
    savingDefaultCap.value = false
  }
}
async function saveTurns() {
  if (!detailId.value) return
  savingTurns.value = true
  turnsMessage.value = ''
  try {
    const cap = turnsUnlimited.value ? -1 : (turnsDraft.value || 0)
    const result = await api<{ message: string }>('/api/simulation/group', { method: 'POST', body: JSON.stringify({ group: detailId.value, action: 'turns', cap }) })
    await openDetail(detailId.value)
    await load()
    turnsMessage.value = result.message
  } catch (e: any) {
    turnsMessage.value = e?.message || '保存失败'
  } finally {
    savingTurns.value = false
  }
}
async function saveCap() {
  if (!detailId.value) return
  savingCap.value = true
  capMessage.value = ''
  try {
    const result = await api<{ message: string }>('/api/simulation/group', { method: 'POST', body: JSON.stringify({ group: detailId.value, action: 'budget', cap: capDraft.value || 0 }) })
    await openDetail(detailId.value)
    await load()
    capMessage.value = result.message
  } catch (e: any) {
    capMessage.value = e?.message || '保存失败'
  } finally {
    savingCap.value = false
  }
}

const columns: DataTableColumns<GroupRow> = [
  {
    title: '群号',
    key: 'groupId',
    width: 200,
    render: row => {
      const name = overview.value?.groupNames?.[row.groupId]
      return name ? `${name}（${row.groupId}）` : row.groupId
    },
  },
  { title: '模式', key: 'active', width: 90, render: row => row.active ? (row.running ? '仿真·回合中' : '仿真') : '普通' },
  { title: '回复模式', key: 'replyMode', width: 110, render: row => h(NSelect, { value: row.replyMode || 'auto', options: replyModeOptions, size: 'tiny', onUpdateValue: (value: string) => void setReplyMode(row, value) }) },
  { title: '未读', key: 'unreadCount', width: 70 },
  { title: '今日回合', key: 'budget', width: 110, render: row => `${row.budget.turns}/${row.budget.maxTurnsPerDay === -1 ? '∞' : row.budget.maxTurnsPerDay}${row.budget.turnsCapOverridden ? ' *' : ''}` },
  { title: '今日花费', key: 'cost', width: 130, render: row => `¥${Number(row.budget.todayCostCny || 0).toFixed(2)} / ¥${row.budget.dailyCostCny}${row.budget.capOverridden ? ' *' : ''}` },
  { title: '最近唤醒', key: 'lastWakeReason', width: 110, render: row => row.lastWakeReason || '—' },
  { title: '梗/待办', key: 'memes', width: 90, render: row => `${row.memes.length}/${row.pendingEvents.length}` },
  { title: '仿真开关', key: 'toggle', width: 100, render: row => h(NSwitch, { value: row.active, size: 'small', onUpdateValue: () => void toggle(row) }) },
  { title: '', key: 'ops', width: 90, render: row => h(NButton, { size: 'tiny', onClick: () => void openDetail(row.groupId) }, { default: () => '详情' }) },
]
import { h } from 'vue'
const rows = computed(() => overview.value?.groups || [])
const detailTitle = computed(() => {
  const name = overview.value?.groupNames?.[detailId.value]
  return name ? `${name}（${detailId.value}）· 仿真详情` : `群 ${detailId.value} · 仿真详情`
})
</script>

<template>
  <div class="page">
    <PageHeader title="自主仿真" subtitle="AI 自主收发消息的会话：按群开关、预算、记忆与好感度管理" />
    <PageState :loading="loading && !overview" :error="error" @retry="load" />
    <template v-if="overview">
      <NAlert v-if="!overview.enabled" type="warning" style="margin-bottom: 12px">
        simulation.enabled 处于关闭状态：全部群走普通模式，下表仅展示历史状态。
      </NAlert>
      <NAlert v-else-if="overview.allGroups" type="info" style="margin-bottom: 12px">
        默认全部白名单群开启（.仿真 关 / 表内开关可按群退出）。
      </NAlert>
      <div class="budget-bar">
        <span class="budget-label">默认每日消耗上限（元）</span>
        <NInputNumber v-model:value="defaultCapDraft" :min="0" :max="10000" :step="1" size="small" style="width: 130px" />
        <NButton size="small" type="primary" :loading="savingDefaultCap" @click="saveDefaultCap">保存</NButton>
        <small class="budget-hint">所有未单独设置的群用这个值；* 表示该群有按群上限</small>
        <span v-if="defaultCapMessage" class="msg">{{ defaultCapMessage }}</span>
      </div>
      <NDataTable :columns="columns" :data="rows" size="small" />
    </template>
    <NDrawer v-model:show="drawerOpen" width="min(420px, 100vw)">
      <NDrawerContent :title="detailTitle" closable>
        <div v-if="detail" class="detail">
          <div class="kv"><span>回复模式（管理员设定）</span><b>{{ replyModeLabels[detail.replyMode || 'auto'] || '自主' }}</b></div>
          <div class="kv"><span>AI 自设状态（它给自己定的）</span><b>{{ detail.mode === 'active' ? '活跃观察期' : '潜水（低主动）' }}</b></div>
          <div class="kv"><span>回合历史</span><b>{{ detail.historyLength }} 条</b></div>
          <div v-if="detail.character" class="block character-block" aria-label="角色与自主目标">
            <h4>角色与自主目标</h4>
            <div class="character-meta">机器人 {{ detail.character.scope.botId }} · 人设 {{ detail.character.scope.personaId }}</div>
            <div class="row">
              <NTag size="small" :type="detail.character.paused ? 'warning' : 'success'">{{ detail.character.paused ? '自主行动已暂停' : '自主行动可用' }}</NTag>
              <NButton size="tiny" :loading="characterBusy" @click="controlCharacter(detail.character.paused ? 'resume' : 'pause')">{{ detail.character.paused ? '恢复自主行动' : '暂停自主行动' }}</NButton>
              <NButton size="tiny" quaternary :disabled="characterBusy" @click="refreshCharacter">刷新</NButton>
            </div>
            <div v-if="detail.character.decision" class="character-card">
              <b>最近选择：{{ decisionLabels[detail.character.decision.kind] || detail.character.decision.kind }}</b>
              <p>{{ detail.character.decision.reason }}</p>
              <small>{{ characterTime(detail.character.decision.at) }}</small>
            </div>
            <div v-if="characterMessage" class="msg" role="status">{{ characterMessage }}</div>
            <h4 class="character-heading">自主目标</h4>
            <div v-if="!detail.character.goals.length" class="empty">还没有自主目标，有合适的兴趣和线索时会逐步形成。</div>
            <div v-for="goal in detail.character.goals" :key="goal.id" class="character-card">
              <div class="character-title"><b>{{ goal.title }}</b><NTag size="small">{{ goalLabels[goal.status] || goal.status }}</NTag></div>
              <p>{{ goal.motivation }}</p>
              <p>下一步：{{ goal.nextStep }}</p>
              <p>完成标准：{{ goal.completionCriteria }}</p>
              <p v-if="goal.lastOutcome">最近结果：{{ goal.lastOutcome }}</p>
              <small>已尝试 {{ goal.attempts }}/{{ goal.maxAttempts }} 次 · 下次检查 {{ characterTime(goal.nextCheckAt) }} · 截止 {{ characterTime(goal.expiresAt) }}</small>
              <div v-if="!goalEnded(goal.status)" class="row">
                <NButton size="tiny" :disabled="characterBusy" @click="controlCharacter(goal.status === 'paused' ? 'resume-goal' : 'pause-goal', goal.id)">{{ goal.status === 'paused' ? '恢复目标' : '暂停目标' }}</NButton>
                <NButton size="tiny" type="error" quaternary :disabled="characterBusy" @click="controlCharacter('cancel-goal', goal.id)">取消目标</NButton>
              </div>
            </div>
            <h4 class="character-heading">最近经历、观点与兴趣</h4>
            <div v-if="!detail.character.memories.length" class="empty">还没有带来源的角色记忆。</div>
            <div v-for="memory in [...detail.character.memories].reverse().slice(0, 12)" :key="memory.id" class="character-card">
              <div class="character-title"><NTag size="small">{{ memoryLabels[memory.kind] || memory.kind }} · {{ evidenceLabels[memory.epistemic] || memory.epistemic }}</NTag><NButton size="tiny" type="error" quaternary :disabled="characterBusy" @click="removeCharacterMemory(memory.id)">删除记忆</NButton></div>
              <p>{{ memory.content }}</p>
              <small>{{ characterTime(memory.updatedAt) }} · {{ memory.evidenceRefs.length }} 条依据</small>
            </div>
            <h4 class="character-heading">最近行动结果</h4>
            <div v-if="!detail.character.receipts.length" class="empty">还没有行动记录。</div>
            <div v-for="receipt in [...detail.character.receipts].reverse().slice(0, 8)" :key="receipt.id" class="character-card">
              <div class="character-title"><b>{{ receipt.toolName }}</b><NTag size="small" :type="receipt.status === 'succeeded' ? 'success' : receipt.status === 'failed' ? 'error' : 'warning'">{{ receiptLabels[receipt.status] || receipt.status }}</NTag></div>
              <p>{{ receipt.summary }}</p>
              <small>{{ characterTime(receipt.at) }}</small>
            </div>
          </div>
          <div v-if="detail.activities" class="block character-block" aria-label="角色活动与作品">
            <h4>角色活动与作品</h4>
            <div v-if="activityMessage" class="msg" role="status">{{ activityMessage }}</div>
            <h4 class="character-heading">作品空间</h4>
            <div v-if="!detail.activities.works.length" class="empty">还没有作品。角色可以把笔记、研究和故事保存为草稿。</div>
            <div v-for="work in detail.activities.works" :key="work.id" class="character-card">
              <div class="character-title"><b>{{ work.title }}</b><NTag size="small">{{ work.status === 'archived' ? '已归档' : '草稿' }}</NTag></div>
              <small>{{ work.versions.length }} 个保留版本 · 更新于 {{ characterTime(work.updatedAt) }}</small>
              <details v-for="version in [...work.versions].reverse()" :key="version.revision" class="work-version">
                <summary>版本 {{ version.revision }} · {{ characterTime(version.createdAt) }}</summary>
                <pre>{{ version.content }}</pre>
                <small>{{ version.evidenceRefs.length }} 条依据</small>
                <NButton v-if="version.revision !== work.versions.at(-1)?.revision" size="tiny" :disabled="activityBusy" @click="controlActivity('work-restore', work.id, { revision: version.revision })">恢复此版本</NButton>
              </details>
              <div class="row">
                <NButton v-if="work.status === 'draft'" size="tiny" :disabled="activityBusy" @click="controlActivity('work-archive', work.id)">归档作品</NButton>
                <NButton v-else size="tiny" :disabled="activityBusy || !work.versions.length" @click="controlActivity('work-restore', work.id, { revision: work.versions.at(-1)!.revision })">恢复作品</NButton>
                <NButton size="tiny" type="error" quaternary :disabled="activityBusy" @click="confirmActivity('work-delete', work.id, '删除作品', '将删除这份作品及其保留版本，已分享出去的消息不会撤回。')">删除作品</NButton>
              </div>
            </div>
            <h4 class="character-heading">兴趣订阅</h4>
            <div v-if="!detail.activities.subscriptions.length" class="empty">还没有公开信息订阅。</div>
            <div v-for="subscription in detail.activities.subscriptions" :key="subscription.id" class="character-card">
              <div class="character-title"><b>{{ subscription.title }}</b><NTag size="small" :type="subscription.status === 'active' ? 'success' : 'warning'">{{ subscription.status === 'active' ? '订阅中' : '已暂停' }}</NTag></div>
              <p class="subscription-url">{{ subscription.url }}</p>
              <small>下次检查 {{ characterTime(subscription.nextPollAt) }} · 连续失败 {{ subscription.failures }} 次</small>
              <details v-if="subscription.items.length" class="work-version">
                <summary>最近更新（{{ subscription.items.length }}）</summary>
                <div v-for="item in subscription.items" :key="item.id" class="subscription-item"><b>{{ item.title }}</b><p>{{ item.summary }}</p><small>{{ characterTime(item.receivedAt) }}</small></div>
              </details>
              <div class="row">
                <NButton size="tiny" :disabled="activityBusy" @click="controlActivity(subscription.status === 'active' ? 'subscription-pause' : 'subscription-resume', subscription.id)">{{ subscription.status === 'active' ? '暂停订阅' : '恢复订阅' }}</NButton>
                <NButton size="tiny" type="error" quaternary :disabled="activityBusy" @click="confirmActivity('subscription-remove', subscription.id, '移除订阅', '停止检查此来源，并删除本地订阅条目。')">移除订阅</NButton>
              </div>
            </div>
            <h4 class="character-heading">低频反思</h4>
            <template v-if="detail.activities.reflection">
              <p class="activity-outcome">{{ detail.activities.reflection.lastOutcome || '尚无反思结果' }}</p>
              <small>上次 {{ characterTime(detail.activities.reflection.lastRunAt) }} · 下次 {{ characterTime(detail.activities.reflection.nextRunAt) }} · 今日 {{ detail.activities.reflection.runsToday }} 次</small>
              <div class="row"><NButton size="tiny" :disabled="activityBusy" @click="controlActivity('reflection-reset')">重置反思调度</NButton></div>
            </template>
            <div v-else class="empty">尚无独立反思记录。</div>
            <h4 class="character-heading">跨群共享的自我偏好</h4>
            <div v-if="!detail.activities.shared.length" class="empty">尚无已批准的共享偏好。</div>
            <div v-for="shared in detail.activities.shared" :key="shared.id" class="character-card">
              <div class="character-title"><NTag size="small">{{ memoryLabels[shared.kind] || shared.kind }}</NTag><NButton size="tiny" type="error" quaternary :disabled="activityBusy" @click="confirmActivity('shared-delete', shared.id, '停止共享偏好', '此偏好将不再注入其他群的角色上下文。')">停止共享</NButton></div>
              <p>{{ shared.content }}</p>
            </div>
            <div v-if="detail.activities.sharedPending.length" class="character-heading"><b>本群待审核</b><p class="empty">批准后将作为角色自己的偏好用于其他群，请先核对内容是否适合共享。</p></div>
            <div v-for="pending in detail.activities.sharedPending" :key="pending.id" class="character-card">
              <p>{{ pending.content }}</p>
              <NButton size="tiny" :disabled="activityBusy" @click="confirmActivity('shared-approve', pending.id, '批准共享自我偏好', `将向此角色在其他群的上下文共享：${pending.content}`)">批准共享</NButton>
            </div>
            <h4 class="character-heading">可用接口</h4>
            <div v-for="capability in detail.activities.capabilities" :key="capability.name" class="character-card">
              <div class="character-title"><b>{{ capability.name }}</b><NTag size="small" :type="capability.available ? 'success' : 'default'">{{ capability.available ? '可用' : '未接入' }}</NTag></div>
              <p>{{ capability.description }}</p>
            </div>
          </div>
          <div class="block">
            <h4>本群每日消耗上限（元） <small v-if="detail.budget.capOverridden">（按群覆盖）</small><small v-else>（跟随默认）</small></h4>
            <div class="row">
              <NInputNumber v-model:value="capDraft" :min="0" :max="10000" :step="1" size="small" style="width: 130px" placeholder="0=跟随默认" />
              <NButton size="small" type="primary" :loading="savingCap" @click="saveCap">保存</NButton>
              <NButton size="small" quaternary @click="() => { capDraft = 0; void saveCap() }">清除覆盖</NButton>
            </div>
            <div v-if="capMessage" class="msg">{{ capMessage }}</div>
          </div>
          <div class="block">
            <h4>本群每日回合上限 <small v-if="detail.budget.turnsCapOverridden">（按群覆盖）</small><small v-else>（跟随默认）</small></h4>
            <div class="row">
              <NInputNumber v-model:value="turnsDraft" :min="1" :max="10000" :step="1" size="small" style="width: 130px" :disabled="turnsUnlimited" placeholder="回合数" />
              <NCheckbox size="small" :checked="turnsUnlimited" @update:checked="(v: boolean) => (turnsUnlimited = v)">不限（永不耗尽）</NCheckbox>
              <NButton size="small" type="primary" :loading="savingTurns" @click="saveTurns">保存</NButton>
              <NButton size="small" quaternary @click="() => { turnsUnlimited = false; turnsDraft = 0; void saveTurns() }">清除覆盖</NButton>
            </div>
            <div v-if="turnsMessage" class="msg">{{ turnsMessage }}</div>
          </div>
          <div class="block">
            <h4>会话初始提示词 <small>（会话重置后的首次唤醒注入一次）</small></h4>
            <NInput v-model:value="initPromptDraft" type="textarea" :rows="4" maxlength="2000" show-count placeholder="这个群是什么圈子、常见话题、忌讳……" />
            <div class="row">
              <NButton size="small" type="primary" :loading="savingPrompt" @click="savePrompt">保存</NButton>
              <NButton size="small" quaternary type="error" @click="resetGroup(detailId)">重置仿真会话</NButton>
            </div>
            <div v-if="promptMessage" class="msg">{{ promptMessage }}</div>
          </div>
          <div class="block">
            <h4>本群专属梗</h4>
            <div v-if="!detail.memes.length" class="empty">还没有梗（自动从群聊提取）</div>
            <div v-for="m in detail.memes" :key="m.id" class="line">
              <NTag size="small" type="success">×{{ m.count }}</NTag> {{ m.content }}
              <small v-if="m.origin">（{{ m.origin }}）</small>
            </div>
          </div>
          <div class="block">
            <h4>待跟进</h4>
            <div v-if="!detail.pendingEvents.length" class="empty">无</div>
            <div v-for="p in detail.pendingEvents" :key="p.id" class="line">{{ p.content }}</div>
          </div>
          <div class="block">
            <h4>好感度 Top</h4>
            <div v-if="!detail.affinity.length" class="empty">还没有记录</div>
            <div v-for="a in detail.affinity" :key="a.userId" class="line">{{ a.userId }}：{{ a.score }}</div>
          </div>
        </div>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.kv { display: flex; justify-content: space-between; margin-bottom: 6px; }
.budget-bar { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; flex-wrap: wrap; }
.budget-label { font-size: 13px; }
.budget-hint { opacity: 0.6; }
.block { margin-top: 16px; }
.block h4 { margin: 0 0 8px; font-size: 13px; }
.block small { font-weight: 400; opacity: 0.6; }
.row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
.character-block { border-top: 1px solid var(--n-border-color, #8883); padding-top: 16px; }
.character-meta { font-size: 12px; opacity: 0.7; overflow-wrap: anywhere; }
.character-card { border: 1px solid var(--n-border-color, #8883); border-radius: 6px; padding: 10px; margin-top: 8px; font-size: 13px; overflow-wrap: anywhere; }
.character-card p { margin: 6px 0; white-space: pre-wrap; }
.character-title { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.block .character-heading { margin-top: 16px; }
.work-version { margin-top: 8px; }
.work-version summary { cursor: pointer; font-size: 12px; }
.work-version pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: 13px; max-height: 360px; overflow-y: auto; padding: 8px; background: #8881; border-radius: 4px; }
.work-version .n-button { margin-left: 8px; }
.subscription-item { padding: 8px 0; border-top: 1px solid #8882; }
.subscription-url { font-size: 12px; opacity: 0.7; }
.activity-outcome { font-size: 13px; white-space: pre-wrap; }
.msg { font-size: 12px; opacity: 0.75; margin-top: 6px; }
.line { margin-bottom: 4px; font-size: 13px; }
.empty { font-size: 12px; opacity: 0.6; }
</style>
