<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NInputNumber, NTag, useMessage } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'

interface Rhythm { sleepFrom: number; sleepTo: number; setBy?: string }
interface Thread { title: string; status: string; lastEpisode?: number; notes: string[]; kind: string; addedAt: number; lastSyncAt: number }
interface Overview { rhythm: Rhythm; threads: Thread[]; now: { hour: number; sleeping: boolean } }

const overview = ref<Overview | null>(null)
const loading = ref(false)
const error = ref('')
const sleepFrom = ref<number>(1)
const sleepTo = ref<number>(8)
const savingRhythm = ref(false)
const message = useMessage()
let timer: number | null = null

async function load() {
  loading.value = true
  error.value = ''
  try {
    overview.value = await api<Overview>('/api/life/overview')
    sleepFrom.value = overview.value.rhythm.sleepFrom
    sleepTo.value = overview.value.rhythm.sleepTo
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

async function saveRhythm() {
  savingRhythm.value = true
  try {
    const result = await api<{ message: string }>('/api/life/rhythm', {
      method: 'POST',
      body: JSON.stringify({ sleepFrom: sleepFrom.value, sleepTo: sleepTo.value }),
    })
    message.success(result.message)
    await load()
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    savingRhythm.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="作息与生活" subtitle="希洛的生物钟（睡眠窗口）与正在追的番——真实数据驱动，不编造" />
    <PageState :loading="loading && !overview" :error="error" @retry="load" />
    <template v-if="overview">
      <section class="panel rhythm-panel">
        <div class="rhythm-status">
          <NTag :type="overview.now.sleeping ? 'warning' : 'success'" size="large">
            {{ overview.now.sleeping ? '😴 睡眠中' : '✨ 空闲' }}
          </NTag>
          <span class="muted">当前 {{ overview.now.hour }}:00 · 睡眠窗口 {{ overview.rhythm.sleepFrom }}:00 - {{ overview.rhythm.sleepTo }}:00</span>
          <NTag v-if="overview.rhythm.setBy === 'agent'" size="small" type="info">AI 自设</NTag>
          <NTag v-else size="small">默认</NTag>
        </div>
        <div class="rhythm-editor">
          <span>睡眠窗口：</span>
          <NInputNumber v-model:value="sleepFrom" :min="0" :max="23" size="small" style="width: 80px" /> 点
          <span>至</span>
          <NInputNumber v-model:value="sleepTo" :min="1" :max="24" size="small" style="width: 80px" /> 点
          <NButton size="small" type="primary" :loading="savingRhythm" @click="saveRhythm">保存</NButton>
        </div>
        <p class="field-help">睡眠窗口内：不主动说话、不响应闲聊触发（被@还是会回，但带困意）。AI 也可通过 simSetRhythm 工具自行调整。</p>
      </section>

      <section class="panel threads-panel">
        <h3>生活线（在追的番）</h3>
        <NAlert v-if="!overview.threads.length" type="info" :show-icon="false">
          还没有在追的番——AI 会通过 simLifeThread 工具自行开始追（基于真实 B 站搜索定位），系统定期拉取真实更新。
        </NAlert>
        <div v-for="t in overview.threads" :key="t.title" class="thread-card" :class="{ dropped: t.status === 'dropped' }">
          <div class="thread-head">
            <strong>《{{ t.title }}》</strong>
            <NTag :type="t.status === 'active' ? 'success' : 'default'" size="small">
              {{ t.status === 'active' ? `在追${t.lastEpisode ? ` · 看到第 ${t.lastEpisode} 集` : ''}` : '已弃' }}
            </NTag>
          </div>
          <div v-for="(note, i) in t.notes.slice(0, 4)" :key="i" class="thread-note">
            <NTag v-if="note.startsWith('〔官方〕')" size="tiny" type="info">官方</NTag>
            <NTag v-else-if="note.startsWith('〔观众')" size="tiny" type="warning">观众</NTag>
            {{ note.replace(/^〔.*?〕/, '') }}
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.panel { border: 1px solid var(--n-border-color); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
.rhythm-status { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.rhythm-editor { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.threads-panel h3 { margin: 0 0 10px; font-size: 15px; }
.thread-card { border-left: 3px solid var(--n-border-color); padding: 8px 12px; margin-bottom: 10px; }
.thread-card.dropped { opacity: 0.5; }
.thread-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.thread-note { font-size: 12px; margin: 2px 0; display: flex; align-items: center; gap: 4px; }
.muted { font-size: 13px; opacity: 0.7; }
</style>
