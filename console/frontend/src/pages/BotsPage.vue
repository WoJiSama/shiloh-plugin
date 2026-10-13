<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import { RouterLink } from 'vue-router'
import { NAlert, NButton, NInput, NInputNumber, NSelect, NTag } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import AccountCard from '../components/AccountCard.vue'
import QzoneComposer from '../components/QzoneComposer.vue'
import IdentityLabel from '../components/IdentityLabel.vue'
import { botLabel, containerLabel } from '../lib/identities'
import { api } from '../lib/api'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import {
  count,
  errorText,
  useAccountActions,
  useOpsResource,
  type Account,
  type OverviewStats
} from '../lib/operations'

const accounts = useOpsResource(
  (signal) => api<{ accounts: Account[] }>('/api/overview/accounts', { signal }),
  30000
)
const stats = useOpsResource(
  (signal) => api<{ stats: OverviewStats | null }>('/api/overview/stats', { signal }),
  60000
)
const sentinel = useOpsResource(
  (signal) => api<{ status: string; alerts: string[] }>('/api/sentinel', { signal }),
  45000
)
const actions = useAccountActions(accounts.refresh, () => accounts.data.value?.accounts || [])
function alertBotId(alert: string) {
  return (
    alert
      .match(/\bnapcat(?:\((\d+)\)|[-_](\d+)\b)/)
      ?.slice(1)
      .find(Boolean) || ''
  )
}
const query = ref('')
const filter = ref('all')
const selected = ref<string[]>([])
const showAdd = ref(false)
const qzoneOpen = ref(false)
const addForm = ref({ qq: '', port: null as number | null, subnet: null as number | null })
const adding = ref(false)
useUnsavedGuard(
  () =>
    !!addForm.value.qq.trim() ||
    addForm.value.port !== null ||
    addForm.value.subnet !== null ||
    adding.value
)
const addError = ref('')
const addSuccess = ref('')
let active = true
onUnmounted(() => {
  active = false
})
const all = computed(() => accounts.data.value?.accounts || [])
const online = computed(
  () => all.value.filter((account) => account.running && account.loginState === '已登录').length
)
const needsAttention = computed(() =>
  all.value.filter((account) => !account.running || account.loginState !== '已登录')
)
const matching = computed(() =>
  all.value.filter((account) => {
    const q = query.value.trim().toLowerCase()
    const matchesQuery =
      !q ||
      `${botLabel(account.account, account.nickname)} ${account.container} ${account.exitIp || ''}`
        .toLowerCase()
        .includes(q)
    return (
      matchesQuery &&
      (filter.value === 'all' ||
        (filter.value === 'online' && account.running && account.loginState === '已登录') ||
        (filter.value === 'attention' && (!account.running || account.loginState !== '已登录')))
    )
  })
)
const selectedAccounts = computed(() =>
  all.value.filter((account) => selected.value.includes(account.container))
)
const selectedBotIds = computed(() =>
  selectedAccounts.value.map((account) => account.account).filter(Boolean)
)
const groupStats = computed(() =>
  Object.entries(stats.data.value?.stats?.todayGroups || {})
    .sort((a, b) => b[1].recv + b[1].send - a[1].recv - a[1].send)
    .slice(0, 8)
)
const filterOptions = [
  { label: '全部状态', value: 'all' },
  { label: '在线', value: 'online' },
  { label: '需要关注', value: 'attention' }
]
function select(container: string, value: boolean) {
  selected.value = value
    ? [...new Set([...selected.value, container])]
    : selected.value.filter((id) => id !== container)
}
async function addAccount() {
  if (adding.value) return
  const { qq, port, subnet } = addForm.value
  if (!/^[1-9]\d{4,11}$/.test(qq.trim())) {
    addError.value = '请输入 5–12 位有效 QQ 号。'
    return
  }
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    addError.value = 'WebUI 端口需为 1024–65535 的整数。'
    return
  }
  if (subnet !== null && (!Number.isInteger(subnet) || subnet < 1 || subnet > 250)) {
    addError.value = '子网序号需为 1–250 的整数。'
    return
  }
  adding.value = true
  addError.value = ''
  addSuccess.value = ''
  try {
    const result = await api<{ qq: string; port: number; subnet: number }>('/api/accounts/add', {
      method: 'POST',
      body: JSON.stringify({ qq: qq.trim(), port: port ?? '', subnet: subnet ?? '' })
    })
    if (!active) return
    addSuccess.value = `账号 ${botLabel(result.qq)} 已创建，WebUI 端口 ${result.port}，子网序号 ${result.subnet}。请在账号卡片启动后扫码登录。`
    addForm.value = { qq: '', port: null, subnet: null }
    showAdd.value = false
    await accounts.refresh()
  } catch (cause) {
    if (active) addError.value = errorText(cause)
  } finally {
    if (active) adding.value = false
  }
}
</script>

<template>
  <div class="page-stack">
    <PageHeader
      title="机器人"
      eyebrow="日常运营"
      description="管理账号、检查登录状态，快速处理需要关注的机器人。"
    >
      <template #actions
        ><NButton :loading="accounts.loading.value" @click="accounts.refresh">刷新账号</NButton
        ><NButton type="primary" @click="showAdd = !showAdd">{{
          showAdd ? '收起表单' : '添加机器人'
        }}</NButton></template
      >
    </PageHeader>
    <div class="overview-strip">
      <div>
        <span class="muted">机器人总数</span
        ><strong>{{ accounts.data.value ? count(all.length) : '—' }}</strong>
      </div>
      <div>
        <span class="muted">在线服务</span
        ><strong class="online-value">{{ accounts.data.value ? count(online) : '—' }}</strong>
      </div>
      <div>
        <span class="muted">需要关注</span
        ><strong>{{ accounts.data.value ? count(needsAttention.length) : '—' }}</strong>
      </div>
      <div>
        <span class="muted">最近同步</span
        ><strong class="sync-value">{{ accounts.updatedAt.value || '同步中' }}</strong>
      </div>
    </div>
    <NAlert v-if="addSuccess" type="success" closable @close="addSuccess = ''">{{
      addSuccess
    }}</NAlert>
    <section v-if="showAdd" class="panel add-panel">
      <div class="panel-heading">
        <div>
          <h2 class="section-title">添加机器人账号</h2>
          <p class="field-help">
            创建待启动账号，自动配置独立网络与出口服务。端口和子网留空即可自动分配。
          </p>
        </div>
      </div>
      <NAlert v-if="addError" type="error" :bordered="false">{{ addError }}</NAlert>
      <div class="field-grid add-grid">
        <div class="form-field">
          <label for="add-qq">QQ 号 <span class="required">*</span></label
          ><NInput
            :input-props="{ id: 'add-qq', inputmode: 'numeric' }"
            v-model:value="addForm.qq"
            placeholder="5–12 位 QQ 号"
            :disabled="adding"
            maxlength="12"
          />
        </div>
        <div class="form-field">
          <label for="add-port">WebUI 端口</label
          ><NInputNumber
            :input-props="{ id: 'add-port' }"
            v-model:value="addForm.port"
            placeholder="自动分配"
            :min="1024"
            :max="65535"
            :precision="0"
            :show-button="false"
            :disabled="adding"
          />
        </div>
        <div class="form-field">
          <label for="add-subnet">子网序号</label
          ><NInputNumber
            :input-props="{ id: 'add-subnet' }"
            v-model:value="addForm.subnet"
            placeholder="自动分配"
            :min="1"
            :max="250"
            :precision="0"
            :show-button="false"
            :disabled="adding"
          />
        </div>
      </div>
      <div class="add-actions">
        <NButton :disabled="adding" @click="showAdd = false">取消</NButton
        ><NButton type="primary" :loading="adding" @click="addAccount">创建账号</NButton>
      </div>
    </section>
    <div class="accounts-toolbar">
      <div class="filter-controls">
        <NInput
          v-model:value="query"
          clearable
          placeholder="搜索昵称、QQ 号、容器或出口 IP"
          aria-label="搜索机器人"
        /><NSelect v-model:value="filter" :options="filterOptions" aria-label="按机器人状态筛选" />
      </div>
      <div class="toolbar-buttons">
        <NButton
          size="small"
          :disabled="actions.busy.value || !needsAttention.length"
          @click="
            actions.confirmAction(
              needsAttention.map((account) => account.container),
              'restart'
            )
          "
          >重启异常账号</NButton
        ><NButton
          size="small"
          :disabled="actions.busy.value || !all.length"
          @click="
            actions.confirmAction(
              all.map((account) => account.container),
              'restart'
            )
          "
          >全部重启</NButton
        >
      </div>
    </div>
    <div v-if="selectedAccounts.length" class="selection-bar">
      <span
        >已选 <strong>{{ selectedAccounts.length }}</strong> 个机器人</span
      ><NButton text :disabled="actions.busy.value" @click="selected = []">清空选择</NButton>
      <div class="selection-actions">
        <NButton
          size="small"
          :disabled="actions.busy.value"
          @click="
            actions.confirmAction(
              selectedAccounts.map((account) => account.container),
              'start'
            )
          "
          >启动</NButton
        ><NButton
          size="small"
          :disabled="actions.busy.value"
          @click="
            actions.confirmAction(
              selectedAccounts.map((account) => account.container),
              'restart'
            )
          "
          >重启</NButton
        ><NButton
          size="small"
          type="error"
          secondary
          :disabled="actions.busy.value"
          @click="
            actions.confirmAction(
              selectedAccounts.map((account) => account.container),
              'stop'
            )
          "
          >停止</NButton
        ><NButton
          size="small"
          type="primary"
          :disabled="!selectedBotIds.length || actions.busy.value"
          @click="qzoneOpen = true"
          >发布说说</NButton
        >
      </div>
    </div>
    <NAlert v-if="actions.busy.value" type="info" :bordered="false"
      >账号操作进行中，请等待回执。</NAlert
    >
    <NAlert v-if="actions.error.value" type="error" :bordered="false">{{
      actions.error.value
    }}</NAlert>
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
      :empty="!!accounts.data.value && !matching.length"
      :empty-text="
        all.length
          ? '没有匹配的机器人，试试其他搜索词或状态。'
          : '暂未发现机器人账号，添加账号后即可开始。'
      "
      @retry="accounts.refresh"
      ><div class="accounts-grid">
        <AccountCard
          v-for="account in matching"
          :key="account.container"
          :account="account"
          selectable
          :selected="selected.includes(account.container)"
          :busy="actions.busy.value"
          @select="select(account.container, $event)"
          @action="actions.confirmAction([account.container], $event)"
        /></div
    ></PageState>
    <div class="operations-columns">
      <section class="panel stats-panel">
        <div class="panel-heading">
          <div>
            <h2 class="section-title">消息概览</h2>
            <span class="muted">最近 7 天</span>
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
          :empty="!!stats.data.value && !stats.data.value.stats"
          empty-text="消息统计暂不可用，请检查统计服务连接。"
          @retry="stats.refresh"
          ><template v-if="stats.data.value?.stats"
            ><div class="traffic-totals">
              <div>
                <span>收信</span><strong>{{ count(stats.data.value.stats.total.recv) }}</strong>
              </div>
              <div>
                <span>发送</span><strong>{{ count(stats.data.value.stats.total.send) }}</strong>
              </div>
              <div>
                <span>失败</span><strong>{{ count(stats.data.value.stats.total.fail) }}</strong>
              </div>
            </div>
            <div class="table-scroll">
              <table class="ops-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>收信</th>
                    <th>发送</th>
                    <th>失败</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="day in stats.data.value.stats.week" :key="day.day">
                    <td>{{ day.day }}</td>
                    <td>{{ count(day.recv) }}</td>
                    <td>{{ count(day.send) }}</td>
                    <td>
                      <span :class="{ 'failure-text': day.fail > 0 }">{{ count(day.fail) }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <template v-if="groupStats.length"
              ><div class="panel-heading group-heading">
                <h3 class="section-title">今日活跃群聊</h3>
                <RouterLink to="/groups">查看全部 →</RouterLink>
              </div>
              <div class="table-scroll">
                <table class="ops-table">
                  <thead>
                    <tr>
                      <th>群聊</th>
                      <th>收信</th>
                      <th>发送</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="[id, value] in groupStats" :key="id">
                      <td><IdentityLabel kind="group" :id="id" /></td>
                      <td>{{ count(value.recv) }}</td>
                      <td>{{ count(value.send) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div></template
            ></template
          ></PageState
        >
      </section>
      <section class="panel sentinel-panel">
        <div class="panel-heading">
          <div>
            <h2 class="section-title">运行哨兵</h2>
            <span class="muted">状态与最近告警</span>
          </div>
          <NButton text size="small" :loading="sentinel.loading.value" @click="sentinel.refresh"
            >刷新</NButton
          >
        </div>
        <NAlert v-if="sentinel.error.value && sentinel.data.value" type="warning" :bordered="false"
          >刷新失败，当前展示上次同步的数据：{{ sentinel.error.value }}</NAlert
        ><PageState
          :loading="sentinel.loading.value && !sentinel.data.value"
          :error="!sentinel.data.value ? sentinel.error.value : null"
          @retry="sentinel.refresh"
        >
          <pre class="sentinel-status">{{ sentinel.data.value?.status || '暂无状态信息' }}</pre>
          <template v-if="sentinel.data.value?.alerts.length"
            ><h3 class="section-title alerts-heading">
              最近告警 <NTag size="small">{{ sentinel.data.value.alerts.length }}</NTag>
            </h3>
            <ul class="alerts-list">
              <li v-for="(alert, index) in sentinel.data.value.alerts" :key="index">
                <IdentityLabel v-if="alertBotId(alert)" kind="bot" :id="alertBotId(alert)" />
                <span>{{ alert }}</span>
              </li>
            </ul></template
          ><RouterLink to="/observe" class="observe-link">查看运行观测 →</RouterLink></PageState
        >
      </section>
    </div>
    <QzoneComposer v-model:show="qzoneOpen" :bot-ids="selectedBotIds" />
  </div>
</template>

<style scoped>
.overview-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
  border: 1px solid var(--c-border);
  border-radius: 14px;
  padding: 20px 24px;
  background: var(--c-panel);
}
.overview-strip > div {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
}
.overview-strip .muted {
  font-size: 12px;
}
.overview-strip strong {
  font-size: 25px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.overview-strip .sync-value {
  font-size: 17px;
  padding-top: 5px;
}
.online-value {
  color: var(--c-green);
}
.add-panel,
.stats-panel,
.sentinel-panel {
  padding: 24px;
}
.add-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 18px;
}
.required {
  color: var(--c-danger);
}
.add-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.accounts-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  justify-content: space-between;
}
.filter-controls {
  display: flex;
  gap: 10px;
  flex: 1;
  min-width: 0;
  max-width: 570px;
}
.filter-controls .n-input {
  flex: 1;
}
.filter-controls .n-select {
  width: 146px;
  flex-shrink: 0;
}
.toolbar-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.accounts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(310px, 100%), 1fr));
  gap: 18px;
}
.selection-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  background: rgba(89, 130, 213, 0.11);
  border: 1px solid rgba(107, 150, 234, 0.28);
  border-radius: 10px;
  font-size: 13px;
}
.selection-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
}
.operations-columns {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.traffic-totals {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 20px 0;
}
.traffic-totals > div {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.traffic-totals span {
  font-size: 12px;
  color: var(--c-muted);
}
.traffic-totals strong {
  font-size: 23px;
  font-variant-numeric: tabular-nums;
}
.table-scroll {
  overflow-x: auto;
}
.ops-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
}
.ops-table th {
  font-weight: 500;
  color: var(--c-muted);
  font-size: 12px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--c-border);
}
.ops-table td {
  padding: 12px 8px;
  border-bottom: 1px solid rgba(130, 150, 180, 0.09);
  font-variant-numeric: tabular-nums;
}
.ops-table th:first-child,
.ops-table td:first-child {
  padding-left: 0;
}
.failure-text {
  color: var(--c-danger);
}
.sentinel-status {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: inherit;
  line-height: 1.8;
  font-size: 13px;
  color: var(--c-muted);
  margin: 18px 0;
}
.alerts-heading,
.group-heading {
  margin-top: 24px;
}
.alerts-list {
  list-style: none;
  padding: 0;
  margin: 10px 0 20px;
  font-size: 12px;
  line-height: 1.7;
}
.alerts-list li {
  padding: 10px 0;
  border-bottom: 1px solid rgba(130, 150, 180, 0.1);
  overflow-wrap: anywhere;
}
.observe-link,
.group-heading a {
  color: var(--c-accent);
  font-size: 12px;
  text-decoration: none;
}
@media (max-width: 900px) {
  .operations-columns {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 600px) {
  .overview-strip {
    grid-template-columns: 1fr 1fr;
    padding: 18px;
    gap: 24px;
  }
  .add-grid {
    grid-template-columns: 1fr;
  }
  .add-panel,
  .stats-panel,
  .sentinel-panel {
    padding: 18px;
  }
  .filter-controls {
    flex-wrap: wrap;
    flex-basis: 100%;
  }
  .filter-controls .n-input {
    flex-basis: 100%;
  }
  .filter-controls .n-select {
    width: 100%;
  }
  .selection-actions {
    margin-left: 0;
  }
}
</style>
