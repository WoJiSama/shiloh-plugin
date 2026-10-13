<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  NAlert,
  NButton,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NInput,
  NSelect,
  NTag,
  type DataTableColumns
} from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import { api } from '../lib/api'
import IdentityLabel from '../components/IdentityLabel.vue'
import { groupLabel } from '../lib/identities'
import { count, useOpsResource } from '../lib/operations'

interface RecentTurn {
  at: string
  group: string
  trigger: string
  tools: string
  outbound: number
  totalMs: number
  failures: string[]
}
interface Timing {
  count: number
  avg: number
  p50: number
  p95: number
}
interface Summary {
  report: {
    turns: number
    intents: Array<[string, number]>
    triggers: Array<[string, number]>
    routes: Array<[string, number]>
    fastPathSkipCount: number
    totalMs: Timing
    modelStages: Record<string, Timing>
    tools: { runs: number; failures: number; topFailures: Array<[string, number]> }
    failureStages: Array<[string, number]>
    outbound: { total: number; avgPerTurn: number }
  }
  hours: Array<{ hour: string; turns: number; failures: number }>
  recent: RecentTurn[]
}
const summary = useOpsResource((signal) => api<Summary>('/api/observe/summary', { signal }), 45000)
const report = computed(() => summary.data.value?.report)
const maxTurns = computed(() =>
  Math.max(...(summary.data.value?.hours || []).map((hour) => hour.turns), 1)
)
const query = ref('')
const filter = ref('all')
const selectedTurn = ref<RecentTurn | null>(null)
const drawerOpen = ref(false)
const recent = computed(() =>
  (summary.data.value?.recent || []).filter((turn) => {
    const q = query.value.trim().toLowerCase()
    return (
      (!q ||
        `${groupLabel(turn.group)} ${turn.trigger} ${turn.tools} ${turn.failures.join(' ')}`
          .toLowerCase()
          .includes(q)) &&
      (filter.value === 'all' ||
        (filter.value === 'failed' && turn.failures.length > 0) ||
        (filter.value === 'success' && !turn.failures.length))
    )
  })
)
const stages = computed(() => Object.entries(report.value?.modelStages || {}))
const filterOptions = [
  { label: '全部回合', value: 'all' },
  { label: '包含失败', value: 'failed' },
  { label: '无失败记录', value: 'success' }
]
function seconds(ms: number | undefined) {
  return ms ? `${(ms / 1000).toFixed(2)}s` : '—'
}
function detail(turn: RecentTurn) {
  selectedTurn.value = turn
  drawerOpen.value = true
}
const columns: DataTableColumns<RecentTurn> = [
  { title: '时间', key: 'at', width: 100 },
  {
    title: '群聊',
    key: 'group',
    width: 240,
    render: (turn) => h(IdentityLabel, { kind: 'group', id: turn.group })
  },
  { title: '触发方式', key: 'trigger', width: 120 },
  { title: '工具', key: 'tools', minWidth: 190, ellipsis: { tooltip: true } },
  { title: '出站', key: 'outbound', width: 75 },
  { title: '耗时', key: 'totalMs', width: 90, render: (turn) => seconds(turn.totalMs) },
  {
    title: '状态',
    key: 'failures',
    width: 105,
    render: (turn) =>
      h(
        NTag,
        { size: 'small', type: turn.failures.length ? 'error' : 'default', bordered: false },
        { default: () => (turn.failures.length ? '包含失败' : '无失败记录') }
      )
  },
  {
    title: '',
    key: 'action',
    width: 80,
    render: (turn) =>
      h(
        NButton,
        { text: true, size: 'small', onClick: () => detail(turn) },
        { default: () => '详情 →' }
      )
  }
]
</script>

<template>
  <div class="page-stack">
    <PageHeader
      title="运行观测"
      eyebrow="运行与排障"
      description="从回合耗时、工具执行和失败阶段，定位近 48 小时的运行问题。"
      ><template #actions
        ><RouterLink to="/observe/details"><NButton secondary>运行明细 →</NButton></RouterLink
        ><NButton :loading="summary.loading.value" @click="summary.refresh"
          >刷新观测</NButton
        ></template
      ></PageHeader
    >
    <NAlert v-if="summary.error.value && summary.data.value" type="warning" :bordered="false"
      >刷新失败，当前展示上次同步的数据：{{ summary.error.value }}</NAlert
    ><PageState
      :loading="summary.loading.value && !summary.data.value"
      :error="!summary.data.value ? summary.error.value : null"
      @retry="summary.refresh"
    >
      <div v-if="report" class="page-stack">
        <div class="observe-metrics">
          <div class="panel metric">
            <span>回合总数</span><strong>{{ count(report.turns) }}</strong
            ><small>近 48 小时归档</small>
          </div>
          <div class="panel metric">
            <span>平均耗时</span><strong>{{ seconds(report.totalMs.avg) }}</strong
            ><small>P95 {{ seconds(report.totalMs.p95) }}</small>
          </div>
          <div class="panel metric">
            <span>出站消息</span><strong>{{ count(report.outbound.total) }}</strong
            ><small>平均 {{ report.outbound.avgPerTurn }} 条 / 回合</small>
          </div>
          <div class="panel metric">
            <span>工具失败</span
            ><strong :class="{ 'failure-text': report.tools.failures > 0 }"
              >{{ count(report.tools.failures)
              }}<small class="metric-denominator"> / {{ count(report.tools.runs) }}</small></strong
            ><small>工具执行次数</small>
          </div>
        </div>
        <section class="panel hours-panel">
          <div class="panel-heading">
            <div>
              <h2 class="section-title">回合活动</h2>
              <p class="field-help">
                最近 24 个有归档记录的小时 · {{ summary.updatedAt.value || '刚刚' }} 更新
              </p>
            </div>
            <div class="chart-legend">
              <span><i></i>回合量</span><span><i class="failure-key"></i>含失败回合</span>
            </div>
          </div>
          <div
            v-if="summary.data.value?.hours.length"
            class="hour-chart"
            role="img"
            aria-label="逐小时回合数与含失败回合数"
          >
            <div
              v-for="hour in summary.data.value.hours"
              :key="hour.hour"
              class="hour-column"
              :title="`${hour.hour}：${hour.turns} 个回合，${hour.failures} 个包含失败`"
            >
              <span class="hour-count">{{ hour.turns }}</span>
              <div class="hour-track">
                <div
                  class="hour-bar"
                  :style="{ height: `${Math.max((hour.turns / maxTurns) * 100, 2)}%` }"
                >
                  <div
                    v-if="hour.failures"
                    class="hour-failure"
                    :style="{ height: `${(hour.failures / Math.max(hour.turns, 1)) * 100}%` }"
                  ></div>
                </div>
              </div>
              <span class="hour-label">{{ hour.hour.slice(11) }}时</span>
            </div>
          </div>
          <div v-else class="empty-chart">暂无回合归档数据。</div>
        </section>
        <div class="distribution-grid">
          <section class="panel distribution-panel">
            <h2 class="section-title">意图分布</h2>
            <p v-if="!report.intents.length" class="empty-tally">暂无意图记录。</p>
            <div
              v-for="[intent, total] in report.intents.slice(0, 8)"
              :key="intent"
              class="tally-row"
            >
              <span>{{ intent }}</span
              ><strong>{{ count(total) }}</strong>
              <div class="tally-track">
                <i
                  :style="{ width: `${Math.max((total / Math.max(report.turns, 1)) * 100, 1)}%` }"
                ></i>
              </div>
            </div>
          </section>
          <section class="panel distribution-panel">
            <h2 class="section-title">失败阶段</h2>
            <p v-if="!report.failureStages.length" class="empty-tally">
              当前归档没有失败阶段记录。
            </p>
            <div
              v-for="[stage, total] in report.failureStages.slice(0, 8)"
              :key="stage"
              class="failure-row"
            >
              <span>{{ stage }}</span
              ><NTag type="error" size="small" :bordered="false">{{ count(total) }} 次</NTag>
            </div>
            <template v-if="report.tools.topFailures?.length"
              ><h3 class="section-title tool-heading">失败工具</h3>
              <div
                v-for="[tool, total] in report.tools.topFailures"
                :key="tool"
                class="failure-row"
              >
                <span>{{ tool }}</span
                ><strong class="failure-text">{{ count(total) }}</strong>
              </div></template
            >
          </section>
        </div>
        <section v-if="stages.length" class="panel stages-panel">
          <div class="panel-heading">
            <div>
              <h2 class="section-title">模型调用耗时</h2>
              <p class="field-help">按调用阶段统计，识别耗时集中位置。</p>
            </div>
          </div>
          <div class="table-scroll">
            <table class="stage-table">
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>调用次数</th>
                  <th>平均</th>
                  <th>P50</th>
                  <th>P95</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="[stage, timing] in stages" :key="stage">
                  <td>{{ stage }}</td>
                  <td>{{ count(timing.count) }}</td>
                  <td>{{ seconds(timing.avg) }}</td>
                  <td>{{ seconds(timing.p50) }}</td>
                  <td>{{ seconds(timing.p95) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section class="panel recent-panel">
          <div class="panel-heading">
            <div>
              <h2 class="section-title">最近回合</h2>
              <p class="field-help">
                最近 20 条归档记录，显示群名称与完整群号，详情保留接口提供的失败阶段。
              </p>
            </div>
          </div>
          <div class="recent-filters">
            <NInput
              v-model:value="query"
              placeholder="搜索群名称、群号、触发方式、工具或失败阶段"
              clearable
              aria-label="搜索最近回合"
            /><NSelect
              v-model:value="filter"
              :options="filterOptions"
              aria-label="按回合失败状态筛选"
            />
          </div>
          <PageState
            :empty="!recent.length"
            :empty-text="
              summary.data.value?.recent.length ? '没有匹配的回合记录。' : '暂无最近回合归档。'
            "
            ><NDataTable
              :columns="columns"
              :data="recent"
              :bordered="false"
              :single-line="false"
              :scroll-x="1000"
          /></PageState>
        </section>
        <details class="panel report-details">
          <summary>查看触发方式与路由分布</summary>
          <div class="distribution-grid">
            <div>
              <h3 class="section-title">触发方式</h3>
              <div v-for="[trigger, total] in report.triggers" :key="trigger" class="failure-row">
                <span>{{ trigger }}</span
                ><strong>{{ count(total) }}</strong>
              </div>
              <p v-if="!report.triggers.length" class="muted">暂无记录</p>
            </div>
            <div>
              <h3 class="section-title">运行路由</h3>
              <div v-for="[route, total] in report.routes" :key="route" class="failure-row">
                <span>{{ route }}</span
                ><strong>{{ count(total) }}</strong>
              </div>
              <p v-if="!report.routes.length" class="muted">暂无记录</p>
            </div>
          </div>
          <p class="field-help">快速路径跳过 {{ count(report.fastPathSkipCount) }} 次。</p>
        </details>
      </div>
    </PageState>
    <NDrawer v-model:show="drawerOpen" :width="'min(440px, 100vw)'" placement="right"
      ><NDrawerContent title="回合记录详情" closable
        ><div v-if="selectedTurn" class="page-stack">
          <NTag :type="selectedTurn.failures.length ? 'error' : 'default'" size="small">{{
            selectedTurn.failures.length ? '包含失败记录' : '无失败记录'
          }}</NTag>
          <dl class="turn-facts">
            <div>
              <dt>时间</dt>
              <dd>{{ selectedTurn.at }}</dd>
            </div>
            <div>
              <dt>群聊</dt>
              <dd><IdentityLabel kind="group" :id="selectedTurn.group" /></dd>
            </div>
            <div>
              <dt>触发方式</dt>
              <dd>{{ selectedTurn.trigger }}</dd>
            </div>
            <div>
              <dt>总耗时</dt>
              <dd>{{ seconds(selectedTurn.totalMs) }}</dd>
            </div>
            <div>
              <dt>出站消息</dt>
              <dd>{{ count(selectedTurn.outbound) }} 条</dd>
            </div>
            <div>
              <dt>工具执行</dt>
              <dd>{{ selectedTurn.tools }}</dd>
            </div>
          </dl>
          <section>
            <h3 class="section-title">失败阶段</h3>
            <p v-if="!selectedTurn.failures.length" class="field-help">
              当前回合没有失败阶段记录。
            </p>
            <div v-else class="failure-tags">
              <NTag
                v-for="(stage, index) in selectedTurn.failures"
                :key="index"
                type="error"
                size="small"
                >{{ stage }}</NTag
              >
            </div>
            <p class="field-help">聚合接口最多返回本回合前 3 个失败阶段。</p>
          </section>
        </div></NDrawerContent
      ></NDrawer
    >
  </div>
</template>

<style scoped>
.observe-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
}
.metric {
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.metric > span {
  font-size: 12px;
  color: var(--c-muted);
}
.metric > strong {
  font-size: 28px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.metric > small {
  color: var(--c-muted);
  font-size: 11px;
}
.metric-denominator {
  font-size: 16px;
  font-weight: 500;
  color: var(--c-muted);
}
.failure-text {
  color: var(--c-danger);
}
.hours-panel,
.distribution-panel,
.stages-panel,
.recent-panel,
.report-details {
  padding: 24px;
  min-width: 0;
}
.chart-legend {
  display: flex;
  gap: 15px;
  font-size: 11px;
  color: var(--c-muted);
  flex-wrap: wrap;
}
.chart-legend span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.chart-legend i {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: #759ddd;
}
.chart-legend .failure-key {
  background: #d0a266;
}
.hour-chart {
  display: flex;
  gap: 7px;
  padding-top: 18px;
  overflow-x: auto;
}
.hour-column {
  flex: 1;
  min-width: 25px;
  text-align: center;
}
.hour-count {
  display: block;
  font-size: 10px;
  color: var(--c-muted);
  padding-bottom: 8px;
}
.hour-track {
  height: 110px;
  display: flex;
  align-items: flex-end;
  border-bottom: 1px solid var(--c-border);
}
.hour-bar {
  width: 100%;
  background: #759ddd;
  border-radius: 3px 3px 0 0;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}
.hour-failure {
  width: 100%;
  background: #d0a266;
}
.hour-label {
  display: block;
  font-size: 10px;
  color: var(--c-muted);
  padding-top: 8px;
}
.empty-chart,
.empty-tally {
  padding: 25px 0;
  color: var(--c-muted);
  font-size: 13px;
}
.distribution-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 20px;
}
.tally-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px 15px;
  margin-top: 18px;
  font-size: 13px;
}
.tally-row > span,
.failure-row > span {
  overflow-wrap: anywhere;
}
.tally-row strong,
.failure-row strong {
  font-size: 12px;
  font-weight: 500;
}
.tally-track {
  grid-column: 1 / -1;
  height: 4px;
  border-radius: 2px;
  background: rgba(130, 150, 180, 0.1);
  overflow: hidden;
}
.tally-track i {
  height: 100%;
  display: block;
  border-radius: 2px;
  background: #688cce;
}
.failure-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  font-size: 13px;
  border-bottom: 1px solid rgba(130, 150, 180, 0.1);
}
.tool-heading {
  margin-top: 24px;
}
.recent-filters {
  display: flex;
  gap: 10px;
  max-width: 650px;
  margin: 20px 0;
}
.recent-filters .n-input {
  flex: 1;
}
.recent-filters .n-select {
  width: 160px;
  flex-shrink: 0;
}
.table-scroll {
  overflow-x: auto;
}
.stage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
}
.stage-table th {
  font-weight: 500;
  color: var(--c-muted);
  font-size: 12px;
  padding: 12px 10px;
  border-bottom: 1px solid var(--c-border);
}
.stage-table td {
  padding: 14px 10px;
  border-bottom: 1px solid rgba(130, 150, 180, 0.1);
  font-variant-numeric: tabular-nums;
}
.stage-table th:first-child,
.stage-table td:first-child {
  padding-left: 0;
}
.report-details > summary {
  cursor: pointer;
  color: var(--c-muted);
  font-size: 13px;
}
.report-details > .distribution-grid {
  margin-top: 24px;
}
.turn-facts {
  margin: 0;
  display: grid;
  gap: 20px;
  padding: 22px 0;
  border-bottom: 1px solid var(--c-border);
}
.turn-facts dt {
  color: var(--c-muted);
  font-size: 12px;
}
.turn-facts dd {
  margin: 6px 0 0;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.failure-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 14px 0;
}
@media (max-width: 900px) {
  .observe-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 600px) {
  .distribution-grid {
    grid-template-columns: 1fr;
  }
  .hours-panel,
  .distribution-panel,
  .stages-panel,
  .recent-panel,
  .report-details {
    padding: 18px;
  }
  .recent-filters {
    flex-wrap: wrap;
  }
  .recent-filters .n-input {
    flex-basis: 100%;
  }
  .recent-filters .n-select {
    width: 100%;
  }
  .metric {
    padding: 18px;
  }
  .metric > strong {
    font-size: 24px;
  }
  .observe-metrics {
    gap: 12px;
  }
}
</style>
