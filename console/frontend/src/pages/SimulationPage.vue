<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NDataTable, NDrawer, NDrawerContent, NInput, NSwitch, NTag, type DataTableColumns } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'

interface GroupRow {
  groupId: string
  active: boolean
  running: boolean
  mode: string
  unreadCount: number
  budget: { turns: number; maxTurnsPerDay: number; tokens: number; dailyCostCny: number; todayCostCny: number }
  lastWakeReason: string | null
  historyLength: number
  pendingEvents: { id: string; content: string; dueAt?: number }[]
  memes: { id: string; content: string; count: number; origin: string }[]
  affinity: { userId: string; score: number }[]
  initialPrompt: string
}
interface Overview { enabled: boolean; allGroups: boolean; disabled: string[]; budgetDefaultCny: number; groups: GroupRow[] }

const overview = ref<Overview | null>(null)
const loading = ref(false)
const error = ref('')
const detailId = ref('')
const detail = ref<GroupRow | null>(null)
const drawerOpen = ref(false)
const initPromptDraft = ref('')
const savingPrompt = ref(false)
const promptMessage = ref('')
let timer: number | null = null

async function load() {
  loading.value = true
  error.value = ''
  try {
    overview.value = await api<Overview>('/api/simulation/overview')
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
async function resetGroup(groupId: string) {
  try {
    await api('/api/simulation/group', { method: 'POST', body: JSON.stringify({ group: groupId, action: 'reset' }) })
    await openDetail(groupId)
    await load()
  } catch (e: any) {
    error.value = e?.message || '重置失败'
  }
}
async function openDetail(groupId: string) {
  detail.value = await api<GroupRow>(`/api/simulation/group?group=${groupId}`)
  detailId.value = groupId
  initPromptDraft.value = detail.value?.initialPrompt || ''
  promptMessage.value = ''
  drawerOpen.value = true
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

const columns: DataTableColumns<GroupRow> = [
  { title: '群号', key: 'groupId', width: 130 },
  { title: '模式', key: 'active', width: 90, render: row => row.active ? (row.running ? '仿真·回合中' : '仿真') : '普通' },
  { title: '未读', key: 'unreadCount', width: 70 },
  { title: '今日回合', key: 'budget', width: 100, render: row => `${row.budget.turns}/${row.budget.maxTurnsPerDay}` },
  { title: '今日花费', key: 'cost', width: 110, render: row => `¥${Number(row.budget.todayCostCny || 0).toFixed(2)} / ¥${row.budget.dailyCostCny}` },
  { title: '最近唤醒', key: 'lastWakeReason', width: 110, render: row => row.lastWakeReason || '—' },
  { title: '梗/待办', key: 'memes', width: 90, render: row => `${row.memes.length}/${row.pendingEvents.length}` },
  { title: '仿真开关', key: 'toggle', width: 100, render: row => h(NSwitch, { value: row.active, size: 'small', onUpdateValue: () => void toggle(row) }) },
  { title: '', key: 'ops', width: 90, render: row => h(NButton, { size: 'tiny', onClick: () => void openDetail(row.groupId) }, { default: () => '详情' }) },
]
import { h } from 'vue'
const rows = computed(() => overview.value?.groups || [])
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
      <NDataTable :columns="columns" :data="rows" size="small" />
    </template>
    <NDrawer v-model:show="drawerOpen" :width="420">
      <NDrawerContent :title="`群 ${detailId} · 仿真详情`" closable>
        <div v-if="detail" class="detail">
          <div class="kv"><span>唤醒模式</span><b>{{ detail.mode }}</b></div>
          <div class="kv"><span>回合历史</span><b>{{ detail.historyLength }} 条</b></div>
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
.block { margin-top: 16px; }
.block h4 { margin: 0 0 8px; font-size: 13px; }
.block small { font-weight: 400; opacity: 0.6; }
.row { display: flex; gap: 8px; margin-top: 8px; }
.msg { font-size: 12px; opacity: 0.75; margin-top: 6px; }
.line { margin-bottom: 4px; font-size: 13px; }
.empty { font-size: 12px; opacity: 0.6; }
</style>
