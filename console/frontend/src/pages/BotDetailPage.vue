<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import { NAlert, NButton, NSelect, NTag } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import AccountCard from '../components/AccountCard.vue'
import QzoneComposer from '../components/QzoneComposer.vue'
import { botLabel, containerLabel } from '../lib/identities'
import { api } from '../lib/api'
import {
  count,
  errorText,
  useOpsResource,
  useAccountActions,
  type Account,
  type Traffic,
  type PersonaLibrary
} from '../lib/operations'

const route = useRoute()
const qq = computed(() => String(route.params.qq || ''))
const accounts = useOpsResource(
  (signal) => api<{ accounts: Account[] }>('/api/overview/accounts', { signal }),
  30000
)
const account = computed(() =>
  accounts.data.value?.accounts.find((item) => String(item.account) === qq.value)
)
const stats = useOpsResource(
  (signal) =>
    api<{ today: Traffic; failCodes: Record<string, number> }>(
      `/api/bot/stats?qq=${encodeURIComponent(qq.value)}`,
      { signal }
    ),
  60000
)
const library = useOpsResource((signal) => api<PersonaLibrary>('/api/persona/library', { signal }))
const actions = useAccountActions(accounts.refresh, () => accounts.data.value?.accounts || [])
const qzoneOpen = ref(false)
const persona = ref('')
const savedPersona = ref('')
const personaSaving = ref(false)
const personaError = ref('')
const personaSuccess = ref('')
const dirty = computed(() => persona.value !== savedPersona.value)
const options = computed(() => [
  { label: '使用默认人设', value: '' },
  ...(library.data.value?.personas || []).map((item) => ({
    label: item.name || item.id,
    value: item.id
  }))
])
const failures = computed(() =>
  Object.entries(stats.data.value?.failCodes || {}).sort((a, b) => b[1] - a[1])
)
let active = true
onUnmounted(() => {
  active = false
})
watch(library.data, (value) => {
  if (!value || dirty.value || personaSaving.value) return
  persona.value = String(value.accountBindings?.[qq.value] || '')
  savedPersona.value = persona.value
})
watch(qq, () => {
  persona.value = ''
  savedPersona.value = ''
  personaError.value = ''
  personaSuccess.value = ''
  accounts.reset()
  stats.reset()
  library.reset()
})
useUnsavedGuard(() => dirty.value || personaSaving.value)
async function savePersona() {
  if (personaSaving.value || !library.data.value) return
  const target = qq.value
  const next = persona.value
  personaSaving.value = true
  personaError.value = ''
  personaSuccess.value = ''
  try {
    // Read immediately before merging so unrelated bindings saved elsewhere remain intact.
    const latest = await api<PersonaLibrary>('/api/persona/library')
    const bindings = { ...(latest.accountBindings || {}) }
    if (next) bindings[target] = next
    else delete bindings[target]
    await api('/api/persona/library', {
      method: 'PUT',
      body: JSON.stringify({ ...latest, accountBindings: bindings })
    })
    if (!active || qq.value !== target) return
    savedPersona.value = next
    personaSuccess.value = next ? '人设绑定已保存并热生效。' : '已恢复使用默认人设。'
    library.data.value = { ...latest, accountBindings: bindings }
  } catch (cause) {
    if (active && qq.value === target) personaError.value = errorText(cause)
  } finally {
    if (active) personaSaving.value = false
  }
}
</script>

<template>
  <div class="page-stack">
    <RouterLink to="/" class="back-link">← 返回机器人列表</RouterLink>
    <PageHeader
      :title="`机器人 ${botLabel(qq, account?.nickname)}`"
      eyebrow="账号详情"
      description="查看账号运行状态、消息统计，管理人设与发布任务。"
      ><template #actions
        ><NButton :loading="accounts.loading.value" @click="accounts.refresh">刷新状态</NButton
        ><NButton :disabled="!account" type="primary" @click="qzoneOpen = true"
          >发布说说</NButton
        ></template
      ></PageHeader
    >
    <NAlert v-if="actions.error.value" type="error" :bordered="false">{{
      actions.error.value
    }}</NAlert>
    <NAlert v-if="actions.busy.value" type="info" :bordered="false"
      >账号操作进行中，请等待回执。</NAlert
    >
    <NAlert
      v-if="actions.results.value.length"
      :type="actions.hasFailures.value ? 'warning' : 'success'"
      :bordered="false"
      ><div v-for="result in actions.results.value" :key="result.container">
        {{ containerLabel(result.container, accounts.data.value?.accounts) }}：{{
          result.ok ? '操作成功' : result.error || '操作失败'
        }}{{ result.note ? `（${result.note}）` : '' }}
      </div></NAlert
    >
    <NAlert v-if="accounts.error.value && accounts.data.value" type="warning" :bordered="false"
      >刷新失败，当前展示上次同步的数据：{{ accounts.error.value }}</NAlert
    ><PageState
      :loading="accounts.loading.value && !accounts.data.value"
      :error="!accounts.data.value ? accounts.error.value : null"
      :empty="!!accounts.data.value && !account"
      :empty-text="`未找到机器人 ${botLabel(qq)}，请确认账号仍存在。`"
      @retry="accounts.refresh"
    >
      <div v-if="account" class="detail-layout">
        <div class="page-stack">
          <AccountCard
            :account="account"
            detail
            :busy="actions.busy.value"
            @action="actions.confirmAction([account!.container], $event)"
          />
          <section class="panel persona-panel">
            <div class="panel-heading">
              <div>
                <h2 class="section-title">账号人设</h2>
                <p class="field-help">
                  设置这个机器人使用的人设。群级覆盖与人设内容可在人设库管理。
                </p>
              </div>
              <NTag v-if="dirty" type="warning" size="small">待保存</NTag>
            </div>
            <NAlert
              v-if="library.error.value && library.data.value"
              type="warning"
              :bordered="false"
              >刷新失败，当前展示上次同步的数据：{{ library.error.value }}</NAlert
            ><PageState
              :loading="library.loading.value && !library.data.value"
              :error="!library.data.value ? library.error.value : null"
              @retry="library.refresh"
              ><div v-if="library.data.value" class="form-field">
                <label for="bot-persona">使用的人设</label
                ><NSelect
                  :input-props="{ id: 'bot-persona', 'aria-label': '机器人使用的人设' }"
                  v-model:value="persona"
                  :options="options"
                  :disabled="personaSaving"
                  filterable
                />
              </div>
              <NAlert v-if="personaError" type="error" :bordered="false">{{ personaError }}</NAlert
              ><NAlert v-if="personaSuccess" type="success" :bordered="false">{{
                personaSuccess
              }}</NAlert>
              <div class="persona-actions">
                <RouterLink to="/persona">管理人设库 →</RouterLink
                ><NButton
                  type="primary"
                  :loading="personaSaving"
                  :disabled="!dirty || !library.data.value"
                  @click="savePersona"
                  >保存绑定</NButton
                >
              </div></PageState
            >
          </section>
        </div>
        <section class="panel traffic-panel">
          <div class="panel-heading">
            <div>
              <h2 class="section-title">今日消息</h2>
              <p class="field-help">账号维度收发计数与发送失败代码。</p>
            </div>
            <NButton text size="small" :loading="stats.loading.value" @click="stats.refresh"
              >刷新</NButton
            >
          </div>
          <NAlert v-if="stats.error.value && stats.data.value" type="warning" :bordered="false"
            >刷新失败，当前展示上次同步的数据：{{ stats.error.value }}</NAlert
          ><PageState
            :loading="stats.loading.value && !stats.data.value"
            :error="!stats.data.value ? stats.error.value : null"
            @retry="stats.refresh"
            ><template v-if="stats.data.value"
              ><div class="bot-traffic">
                <div>
                  <span>收信</span><strong>{{ count(stats.data.value.today.recv) }}</strong>
                </div>
                <div>
                  <span>发送</span><strong>{{ count(stats.data.value.today.send) }}</strong>
                </div>
                <div>
                  <span>失败</span
                  ><strong :class="{ 'failure-text': stats.data.value.today.fail > 0 }">{{
                    count(stats.data.value.today.fail)
                  }}</strong>
                </div>
              </div>
              <div class="failures-heading">
                <h3 class="section-title">发送失败明细</h3>
                <NTag size="small">{{ failures.length }} 种代码</NTag>
              </div>
              <p v-if="!failures.length" class="no-failures">当前没有记录到发送失败。</p>
              <div v-else class="failure-list">
                <div v-for="[code, total] in failures" :key="code">
                  <code>{{ code }}</code
                  ><strong>{{ count(total) }} 次</strong>
                </div>
              </div>
              <div class="related-links">
                <RouterLink to="/groups">查看服务群聊 →</RouterLink
                ><RouterLink to="/observe">查看运行观测 →</RouterLink>
              </div></template
            ></PageState
          >
        </section>
      </div>
    </PageState>
    <QzoneComposer v-model:show="qzoneOpen" :bot-ids="[qq]" />
  </div>
</template>

<style scoped>
.back-link {
  color: var(--c-muted);
  font-size: 12px;
  text-decoration: none;
  width: fit-content;
}
.detail-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 22px;
  align-items: start;
}
.persona-panel,
.traffic-panel {
  padding: 24px;
}
.persona-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 20px;
  flex-wrap: wrap;
}
.persona-actions a,
.related-links a {
  color: var(--c-accent);
  font-size: 12px;
  text-decoration: none;
}
.bot-traffic {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  padding: 20px 0 26px;
}
.bot-traffic > div {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bot-traffic span {
  color: var(--c-muted);
  font-size: 12px;
}
.bot-traffic strong {
  font-size: 30px;
  font-variant-numeric: tabular-nums;
}
.failure-text {
  color: var(--c-danger);
}
.failures-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 20px;
  border-top: 1px solid var(--c-border);
}
.no-failures {
  padding: 22px 0;
  font-size: 13px;
  color: var(--c-muted);
}
.failure-list {
  margin: 12px 0 20px;
}
.failure-list > div {
  display: flex;
  gap: 15px;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid rgba(130, 150, 180, 0.1);
  font-size: 13px;
}
.failure-list code {
  overflow-wrap: anywhere;
  color: var(--c-danger);
}
.failure-list strong {
  white-space: nowrap;
  font-weight: 500;
}
.related-links {
  display: flex;
  flex-wrap: wrap;
  gap: 22px;
  border-top: 1px solid var(--c-border);
  padding-top: 20px;
}
@media (max-width: 850px) {
  .detail-layout {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 480px) {
  .persona-panel,
  .traffic-panel {
    padding: 18px;
  }
  .bot-traffic {
    gap: 10px;
  }
  .bot-traffic strong {
    font-size: 25px;
  }
}
</style>
