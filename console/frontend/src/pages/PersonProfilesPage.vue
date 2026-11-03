<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NDataTable, NDrawer, NDrawerContent, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'

interface Profile {
  userId: string
  name?: string
  interests: string[]
  taboos: string[]
  traits?: string[]
  facts?: string[]
  globalAffinity?: number
  updatedAt?: string
}

const profiles = ref<Profile[] | null>(null)
const loading = ref(false)
const error = ref('')
const query = ref('')
const detail = ref<Profile | null>(null)
const drawerOpen = ref(false)
const acting = ref(false)
const message = useMessage()
const dialog = useDialog()
let timer: number | null = null

async function load() {
  loading.value = true
  error.value = ''
  try {
    const payload = await api<{ profiles: Profile[] }>('/api/person-profiles')
    profiles.value = payload.profiles || []
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

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = profiles.value || []
  if (!q) return list
  return list.filter(p => `${p.userId} ${p.name || ''} ${(p.interests || []).join()} ${(p.facts || []).join()} ${(p.traits || []).join()}`.toLowerCase().includes(q))
})

function openDetail(row: Profile) {
  detail.value = row
  drawerOpen.value = true
}

async function deleteField(field: string, value?: string) {
  if (!detail.value) return
  acting.value = true
  try {
    await api('/api/person-profiles/delete-field', { method: 'POST', body: JSON.stringify({ userId: detail.value.userId, field, value }) })
    message.success(value ? `已删除「${value}」` : '已清除')
    await load()
    const refreshed = (profiles.value || []).find(p => p.userId === detail.value?.userId)
    detail.value = refreshed || null
  } catch (e: any) {
    message.error(e?.message || '删除失败')
  } finally {
    acting.value = false
  }
}

function deletePerson(row: Profile) {
  dialog.warning({
    title: '删除跨群记忆',
    content: `将删除 ${row.name || row.userId} 的全部人物档案与全局好感底分（各群内的群内记忆不受影响）。确定继续吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      acting.value = true
      try {
        await api('/api/person-profiles/delete', { method: 'POST', body: JSON.stringify({ userId: row.userId }) })
        message.success(`已删除 ${row.userId} 的跨群记忆`)
        drawerOpen.value = false
        await load()
      } catch (e: any) {
        message.error(e?.message || '删除失败')
      } finally {
        acting.value = false
      }
    }
  })
}

const FIELD_LABELS: Record<string, string> = { interests: '长期爱好', taboos: '雷点忌讳', traits: '性格印象', facts: '稳定事实' }

const columns: DataTableColumns<Profile> = [
  { title: 'QQ', key: 'userId', width: 120 },
  { title: '称呼', key: 'name', width: 100, render: row => row.name || '—' },
  { title: '性格印象', key: 'traits', render: row => (row.traits?.length ? row.traits.join('、') : '—') },
  { title: '爱好 / 事实', key: 'interests', minWidth: 220, ellipsis: { tooltip: true }, render: row => [...(row.interests || []), ...(row.facts || [])].join('；') || '—' },
  { title: '全局好感', key: 'globalAffinity', width: 90, render: row => row.globalAffinity !== undefined ? String(row.globalAffinity) : '—' },
  { title: '', key: 'detail', width: 80, render: row => detailButton(row) },
]
import { h } from 'vue'
function detailButton(row: Profile) {
  return h(NButton, { size: 'tiny', onClick: () => openDetail(row) }, { default: () => '详情' })
}
</script>

<template>
  <div class="page">
    <PageHeader title="人物记忆" subtitle="跨群共享的身份级档案（称呼/爱好/雷点/印象）与全局好感底分——它对每个人的长期认识，可查看可删除" />
    <PageState :loading="loading && !profiles" :error="error" @retry="load" />
    <template v-if="profiles">
      <NAlert v-if="!profiles.length" type="info" style="margin-bottom: 12px">
        还没有积累任何人物档案——提取在群空档时自动进行（每群 6 小时一轮），聊几天后这里会有内容。
      </NAlert>
      <NAlert v-else type="default" :show-icon="false" style="margin-bottom: 12px">
        这里只有「跨群都成立」的身份级事实；各群内部的相处细节与好感温度存在各群自己的记忆里（仿真页可查），不会跨群。
      </NAlert>
      <NDataTable :columns="columns" :data="filtered" size="small" />
    </template>
    <NDrawer v-model:show="drawerOpen" :width="440">
      <NDrawerContent :title="`${detail?.name || ''}（${detail?.userId}）的跨群记忆`" closable>
        <div v-if="detail" class="detail">
          <div v-if="detail.globalAffinity !== undefined" class="kv">
            <span>全局好感底分（关系的"本钱"）</span><b>{{ detail.globalAffinity }}</b>
          </div>
          <div v-if="detail.name" class="block">
            <h4>称呼偏好 <NButton size="tiny" quaternary type="error" :loading="acting" @click="deleteField('name')">清除</NButton></h4>
            <div class="line">{{ detail.name }}</div>
          </div>
          <div v-for="field in ['traits', 'interests', 'facts', 'taboos']" :key="field" class="block">
            <h4>{{ FIELD_LABELS[field] }}</h4>
            <div v-if="(detail as any)[field]?.length">
              <div v-for="item in (detail as any)[field]" :key="item" class="line row-line">
                <span>{{ item }}</span>
                <NButton size="tiny" quaternary type="error" :loading="acting" @click="deleteField(field, item)">删</NButton>
              </div>
            </div>
            <div v-else class="line muted-line">暂无</div>
          </div>
          <div class="block">
            <NButton size="small" type="error" secondary :loading="acting" @click="deletePerson(detail)">删除此人的全部跨群记忆</NButton>
          </div>
        </div>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.kv { display: flex; justify-content: space-between; margin-bottom: 10px; }
.block { margin-bottom: 14px; }
.block h4 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 13px; }
.line { font-size: 13px; margin-bottom: 4px; }
.row-line { display: flex; justify-content: space-between; align-items: center; }
.muted-line { opacity: 0.6; }
</style>
