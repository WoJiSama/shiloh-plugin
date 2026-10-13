<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NAlert, NButton, NSelect, NTag, NEmpty, NDrawer, NDrawerContent } from 'naive-ui'
import { RefreshCw, ArrowUpRight } from 'lucide-vue-next'
import SchemaPage from './SchemaPage.vue'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'
import IdentityLabel from '../components/IdentityLabel.vue'
const tab = ref('settings'),
  loading = ref(false),
  error = ref(''),
  data = ref<any>(null),
  kind = ref('all'),
  status = ref('all'),
  detail = ref<any>(null)
const kinds = [
  { label: '全部类型', value: 'all' },
  { label: '消息事件', value: 'event' },
  { label: '媒体交付', value: 'delivery' }
]
const names: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  retry_wait: '等待重试',
  completed: '已完成',
  sent: '已发送',
  failed: '失败'
}
const statuses = [
  { label: '全部状态', value: 'all' },
  ...Object.entries(names).map(([value, label]) => ({ value, label }))
]
let abort: AbortController | null = null,
  seq = 0
async function load() {
  const current = ++seq
  abort?.abort()
  abort = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const result = await api(
      `/api/pipeline/jobs?kind=${kind.value}&status=${status.value}&limit=100`,
      { signal: abort.signal }
    )
    if (current === seq) data.value = result
  } catch (e) {
    if (current === seq && (e as Error).name !== 'AbortError') error.value = (e as Error).message
  } finally {
    if (current === seq) loading.value = false
  }
}
function select(value: string) {
  tab.value = value
  if (value === 'jobs' && !data.value) load()
}
function time(value: number) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}
onBeforeUnmount(() => {
  seq++
  abort?.abort()
})
</script>
<template>
  <div class="page-stack">
    <PageHeader
      title="消息与搬运"
      eyebrow="消息与运行"
      description="配置消息处理和平台授权，追踪持久任务的交付结果。"
      ><template #actions
        ><NButton v-if="tab === 'jobs'" :loading="loading" @click="load"
          ><template #icon><RefreshCw :size="16" /></template>刷新记录</NButton
        ></template
      ></PageHeader
    >
    <div class="task-tabs" role="tablist" aria-label="消息与搬运">
      <button role="tab" :aria-selected="tab === 'settings'" @click="select('settings')">
        策略与授权</button
      ><button role="tab" :aria-selected="tab === 'jobs'" @click="select('jobs')">任务记录</button>
    </div>
    <div v-show="tab === 'settings'"><SchemaPage kind="pipeline" embedded /></div>
    <section v-if="tab === 'jobs'" class="page-stack">
      <div class="toolbar">
        <NSelect
          v-model:value="kind"
          :options="kinds"
          style="width: 160px"
          aria-label="任务类型"
          @update:value="load"
        /><NSelect
          v-model:value="status"
          :options="statuses"
          style="width: 160px"
          aria-label="任务状态"
          @update:value="load"
        /><span v-if="data" class="muted">本次查询 {{ data.returned }} 条 · 最多展示 100 条</span>
      </div>
      <NAlert type="info" :show-icon="false"
        >任务状态为最后持久化结果，不代表 worker 当前存活；仅包含未过期记录，不是历史累计。<span
          v-if="data?.scanTruncated"
          >本次扫描达到上限，结果可能不完整。</span
        ></NAlert
      ><PageState :loading="loading" :error="error" @retry="load"
        ><div class="panel">
          <NEmpty v-if="!data?.jobs?.length" description="当前筛选没有留存任务" />
          <div v-else class="jobs-list">
            <button
              v-for="job in data.jobs"
              :key="job.kind + job.id"
              class="job-row"
              @click="detail = job"
            >
              <div>
                <span class="job-title"
                  >{{ job.kind === 'delivery' ? '媒体交付' : '消息事件'
                  }}<NTag
                    size="small"
                    :type="
                      job.state === 'failed'
                        ? 'error'
                        : job.state === 'sent' || job.state === 'completed'
                          ? 'success'
                          : 'default'
                    "
                    >{{ names[job.state] || job.state }}</NTag
                  ></span
                ><span class="muted"
                  >{{ job.platform || '消息' }} · 机器人
                  <IdentityLabel kind="bot" :id="job.botId || ''" /> · 群
                  <IdentityLabel kind="group" :id="job.groupId || ''" /></span
                ><span v-if="job.lastError" class="job-error">{{ job.lastError }}</span>
              </div>
              <div class="job-time">
                <small>{{ time(job.updatedAt) }}</small
                ><small>{{ job.attempts }} 次尝试</small>
              </div>
              <ArrowUpRight :size="16" />
            </button>
          </div>
        </div>
        <p v-if="data" class="field-help">
          配置中的保留时间：事件 {{ data.retention.eventMinutes }} 分钟，交付
          {{ data.retention.deliveryHours }} 小时；当前运行实例可能使用此前配置。
        </p></PageState
      >
    </section>
    <NDrawer
      :show="Boolean(detail)"
      :width="'min(520px, calc(100vw - 20px))'"
      @update:show="!$event && (detail = null)"
      ><NDrawerContent title="任务详情" closable
        ><dl v-if="detail" class="detail-list">
          <template v-for="(value, key) in detail" :key="key"
            ><dt>{{ key }}</dt>
            <dd>
              <IdentityLabel
                v-if="key === 'botId' || key === 'groupId'"
                :kind="key === 'botId' ? 'bot' : 'group'"
                :id="String(value || '')"
              />
              <template v-else>{{
                ['createdAt', 'updatedAt', 'nextRetryAt', 'leaseUntil'].includes(String(key))
                  ? time(Number(value))
                  : value
              }}</template>
            </dd></template
          >
        </dl></NDrawerContent
      ></NDrawer
    >
  </div>
</template>
<style scoped>
.job-row {
  display: flex;
  gap: 16px;
  align-items: center;
  text-align: left;
  width: 100%;
  padding: 18px 0;
  color: var(--c-text);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--c-border);
}
.job-row:last-child {
  border-bottom: 0;
}
.job-row > div:first-child {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 6px;
}
.job-title {
  display: flex;
  gap: 10px;
  align-items: center;
  font-weight: 500;
}
.job-row .muted {
  font-size: 12px;
}
.job-error {
  font-size: 12px;
  color: var(--c-danger);
  overflow-wrap: anywhere;
}
.job-time {
  display: grid;
  gap: 5px;
  color: var(--c-muted);
  text-align: right;
}
@media (max-width: 600px) {
  .job-row {
    flex-wrap: wrap;
  }
  .job-time {
    width: 100%;
    text-align: left;
    display: flex;
    justify-content: space-between;
  }
  .job-row > svg {
    display: none;
  }
}
</style>
