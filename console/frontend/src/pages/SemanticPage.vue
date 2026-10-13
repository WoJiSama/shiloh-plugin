<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  NButton,
  NInput,
  NSwitch,
  NAlert,
  NEmpty,
  NTag,
  NPagination,
  useDialog,
  useMessage
} from 'naive-ui'
import { RefreshCw, Search, Trash2, Sparkles } from 'lucide-vue-next'
import { api } from '../lib/api'
import IdentityLabel from '../components/IdentityLabel.vue'
import { groupLabel } from '../lib/identities'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
const base = '/bl-chat/semantic-memory/api/',
  stats = ref<any>(null),
  loading = ref(true),
  error = ref(''),
  tab = ref('search'),
  group = ref(''),
  query = ref(''),
  rerank = ref(false),
  searching = ref(false),
  result = ref<any>(null),
  chunks = ref<any>(null),
  page = ref(1),
  history = ref<any[]>([]),
  actionBusy = ref('')
const resultGroup = ref(''),
  chunksGroup = ref('')
const message = useMessage(),
  dialog = useDialog()
let live = true,
  seq = 0,
  controller: AbortController | null = null
async function load() {
  error.value = ''
  loading.value = true
  try {
    const data = await api(base + 'stats')
    if (live) stats.value = data
    const evaluations = await api(base + 'eval-history')
    if (live) history.value = evaluations.history || []
  } catch (e) {
    if (live) error.value = (e as Error).message
  } finally {
    if (live) loading.value = false
  }
}
interface SearchRequest {
  group: string
  query: string
  rerank: boolean
}
interface BrowseRequest {
  group: string
  page: number
}
interface MemoryContext {
  source: 'search' | 'browse'
  group: string
  data: any
  epoch: number
  request: SearchRequest | BrowseRequest
}
let resultRequest: SearchRequest | null = null,
  chunksRequest: BrowseRequest | null = null
async function search(
  request: SearchRequest = {
    group: group.value.trim(),
    query: query.value.trim(),
    rerank: rerank.value
  }
) {
  if (!request.group || !request.query) {
    message.warning('请填写群号和检索内容')
    return
  }
  const id = ++seq
  controller?.abort()
  controller = new AbortController()
  searching.value = true
  try {
    const data = await api(
      base +
        `playground?group=${encodeURIComponent(request.group)}&q=${encodeURIComponent(request.query)}&rerank=${request.rerank ? '1' : '0'}`,
      { signal: controller.signal }
    )
    if (live && id === seq) {
      result.value = data
      resultGroup.value = request.group
      resultRequest = { ...request }
    }
  } catch (e) {
    if (live && id === seq && (e as Error).name !== 'AbortError')
      message.error((e as Error).message)
  } finally {
    if (live && id === seq) searching.value = false
  }
}
async function browse(request: BrowseRequest = { group: group.value.trim(), page: 1 }) {
  if (!request.group) {
    message.warning('请填写群号')
    return
  }
  const id = ++seq
  controller?.abort()
  controller = new AbortController()
  searching.value = true
  try {
    const data = await api(
      base +
        `chunks?group=${encodeURIComponent(request.group)}&offset=${(request.page - 1) * 20}&limit=20`,
      { signal: controller.signal }
    )
    if (live && id === seq) {
      chunks.value = data
      chunksGroup.value = request.group
      page.value = request.page
      chunksRequest = { ...request }
    }
  } catch (e) {
    if (live && id === seq && (e as Error).name !== 'AbortError')
      message.error((e as Error).message)
  } finally {
    if (live && id === seq) searching.value = false
  }
}
function context(): MemoryContext | null {
  if (tab.value === 'browse' && chunksRequest)
    return {
      source: 'browse',
      group: chunksGroup.value,
      data: chunks.value,
      epoch: seq,
      request: { ...chunksRequest }
    }
  if (tab.value === 'search' && resultRequest)
    return {
      source: 'search',
      group: resultGroup.value,
      data: result.value,
      epoch: seq,
      request: { ...resultRequest }
    }
  return null
}
async function action(item: any, type: string, owner = context()) {
  if (!live || actionBusy.value || !owner) return
  actionBusy.value = item.id
  try {
    const data = await api(base + type, {
      method: 'POST',
      body: JSON.stringify({ group: owner.group, id: item.id })
    })
    if (!live) return
    if (!data.ok) {
      message.error(data.message || '操作失败')
      return
    }
    message.success(data.message || '已更新记忆')
    if (type === 'forget') {
      if (resultGroup.value === owner.group && result.value)
        result.value.items = result.value.items.filter((x: any) => x.id !== item.id)
      if (chunksGroup.value === owner.group && chunks.value) {
        const before = chunks.value.chunks.length
        chunks.value.chunks = chunks.value.chunks.filter((x: any) => x.id !== item.id)
        if (chunks.value.chunks.length < before)
          chunks.value.total = Math.max(0, chunks.value.total - 1)
      }
    } else if (
      owner.epoch === seq &&
      tab.value === owner.source &&
      owner.source === 'browse' &&
      chunks.value === owner.data
    )
      await browse(owner.request as BrowseRequest)
    else if (
      owner.epoch === seq &&
      tab.value === owner.source &&
      owner.source === 'search' &&
      result.value === owner.data
    )
      await search(owner.request as SearchRequest)
  } catch (e) {
    if (live) message.error((e as Error).message)
  } finally {
    if (live) actionBusy.value = ''
  }
}
function forget(item: any) {
  const owner = context()
  if (!owner) return
  dialog.warning({
    title: '忘记这条记忆',
    content: `这条分块将从群 ${groupLabel(owner.group)} 的语义记忆中移除，之后不再被召回。确定继续？`,
    positiveText: '忘记',
    negativeText: '取消',
    onPositiveClick: () => action(item, 'forget', owner)
  })
}
function pct(value: any) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(1)}%`
    : '—'
}
const items = computed(() =>
  tab.value === 'browse' ? chunks.value?.chunks || [] : result.value?.items || []
)
onMounted(load)
onBeforeUnmount(() => {
  live = false
  seq++
  controller?.abort()
})
</script>
<template>
  <div class="page-stack">
    <PageHeader
      title="语义记忆"
      eyebrow="机器人能力"
      description="查看索引状态，测试检索效果，管理群聊中的长期记忆。"
      ><template #actions
        ><NButton :loading="loading" @click="load"
          ><template #icon><RefreshCw :size="16" /></template>刷新</NButton
        ></template
      ></PageHeader
    ><PageState :loading="loading" :error="error" @retry="load"
      ><NAlert v-if="!stats?.enabled" type="info" title="语义记忆尚未启用"
        >启用后可查看群索引、检索结果和评估历史。</NAlert
      ><template v-else
        ><div class="stat-grid">
          <section class="panel">
            <span class="muted">已索引群</span>
            <div class="stat-value">{{ stats.store?.groups ?? '—' }}</div>
          </section>
          <section class="panel">
            <span class="muted">记忆分块</span>
            <div class="stat-value">{{ stats.store?.chunks ?? '—' }}</div>
          </section>
          <section class="panel">
            <span class="muted">索引磁盘</span>
            <div class="stat-value">{{ stats.store?.diskMb ?? '—' }} <small>MB</small></div>
          </section>
        </div>
        <div class="task-tabs" role="tablist" aria-label="语义记忆工具">
          <button role="tab" :aria-selected="tab === 'search'" @click="tab = 'search'">
            检索测试</button
          ><button role="tab" :aria-selected="tab === 'browse'" @click="tab = 'browse'">
            分块管理</button
          ><button role="tab" :aria-selected="tab === 'evaluation'" @click="tab = 'evaluation'">
            评估历史</button
          ><button role="tab" :aria-selected="tab === 'runtime'" @click="tab = 'runtime'">
            运行信息
          </button>
        </div>
        <section v-if="tab === 'search' || tab === 'browse'" class="panel page-stack">
          <form class="semantic-form" @submit.prevent="tab === 'search' ? search() : browse()">
            <label class="form-field"
              ><span>群号</span
              ><NInput v-model:value="group" placeholder="输入完整群号" /><IdentityLabel
                v-if="group.trim()"
                kind="group"
                :id="group.trim()" /></label
            ><label v-if="tab === 'search'" class="form-field query-field"
              ><span>检索内容</span
              ><NInput v-model:value="query" placeholder="想找回什么记忆？" /></label
            ><NButton attr-type="submit" type="primary" :loading="searching"
              ><template #icon><Search :size="16" /></template
              >{{ tab === 'search' ? '检索' : '浏览' }}</NButton
            ><label v-if="tab === 'search' && stats.config?.rerankEnabled" class="rerank-label"
              ><NSwitch v-model:value="rerank" size="small" />启用重排</label
            >
          </form>
          <p v-if="tab === 'search' && result" class="field-help">
            群 <IdentityLabel kind="group" :id="resultGroup" /> ·
            {{ result.candidates ?? '—' }} 个候选 · {{ result.items?.length || 0 }} 条结果 ·
            {{ result.elapsedMs }} ms · 向量 {{ result.vectorMs }} ms / BM25
            {{ result.bm25Ms }} ms{{ result.reranked ? ` / 重排 ${result.rerankMs} ms` : '' }}
          </p>
          <p v-if="tab === 'browse' && chunks" class="field-help">
            当前结果来自群 <IdentityLabel kind="group" :id="chunksGroup" /> · 共
            {{ chunks.total }} 条
          </p>
          <NEmpty
            v-if="!items.length"
            :description="result || chunks ? '没有匹配的记忆' : '填写群号，开始查看记忆'"
          />
          <article v-for="item in items" :key="item.id" class="memory-item">
            <div class="memory-heading">
              <span>{{ item.timeRange }}</span
              ><small>{{ item.messages }} 条消息 · {{ item.speakers || '未知发言者' }}</small>
            </div>
            <p>{{ item.text || item.preview }}</p>
            <div class="memory-footer">
              <span class="field-help"
                >召回 {{ item.recallCount || 0 }} 次 · 强度
                {{ pct(item.effectiveStrength ?? item.effStrength)
                }}<template v-if="item.vectorScore !== undefined">
                  · 向量 {{ Number(item.vectorScore).toFixed(3) }} · 向量排名
                  {{ item.vectorRank ?? '—' }} / BM25 {{ item.bm25Rank ?? '—'
                  }}<template v-if="item.rerankScore != null">
                    · 重排 {{ Number(item.rerankScore).toFixed(3) }}</template
                  ></template
                ></span
              >
              <div class="toolbar">
                <NButton
                  size="small"
                  :loading="actionBusy === item.id"
                  @click="action(item, 'reinforce')"
                  ><template #icon><Sparkles :size="14" /></template>强化</NButton
                ><NButton
                  size="small"
                  quaternary
                  type="error"
                  :disabled="Boolean(actionBusy)"
                  @click="forget(item)"
                  ><template #icon><Trash2 :size="14" /></template>忘记</NButton
                >
              </div>
            </div>
          </article>
          <NPagination
            v-if="tab === 'browse' && chunks?.total"
            v-model:page="page"
            :item-count="chunks.total"
            :page-size="20"
            @update:page="browse({ group: chunksGroup, page: $event })"
          />
        </section>
        <section v-if="tab === 'evaluation'" class="panel">
          <NEmpty v-if="!history.length" description="暂无评估历史" />
          <template v-else>
            <h2 class="section-title">检索效果</h2>
            <p class="field-help">比较向量、混合检索和重排在评估样本上的召回率。</p>
            <div class="table-scroll">
              <table class="evaluation-table">
                <thead>
                  <tr>
                    <th>评估时间</th>
                    <th>样本</th>
                    <th>向量 Recall@5</th>
                    <th>混合 Recall@5</th>
                    <th>重排 Recall@5</th>
                    <th>混合 Recall@10</th>
                    <th>耗时 P50</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(item, index) in history" :key="index">
                    <td>
                      {{
                        item.generatedAt ||
                        item.at ||
                        item.timestamp ||
                        item.date ||
                        `评估 ${index + 1}`
                      }}
                    </td>
                    <td>{{ item.samples ?? item.count ?? '—' }}</td>
                    <td>{{ pct(item.recallAt5Vector) }}</td>
                    <td>{{ pct(item.recallAt5Hybrid) }}</td>
                    <td>{{ pct(item.recallAt5Rerank) }}</td>
                    <td>{{ pct(item.recallAt10Hybrid) }}</td>
                    <td>{{ item.latencyP50Ms == null ? '—' : `${item.latencyP50Ms} ms` }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <details class="evaluation-source">
              <summary>完整评估记录</summary>
              <pre>{{ JSON.stringify(history, null, 2) }}</pre>
            </details>
          </template>
        </section>
        <section v-if="tab === 'runtime'" class="panel">
          <div class="field-grid">
            <article
              v-for="key in ['config', 'embedding', 'reranker', 'retriever', 'indexer']"
              :key="key"
            >
              <h3 class="section-title">
                {{
                  (
                    {
                      config: '索引配置',
                      embedding: '向量模型',
                      reranker: '重排模型',
                      retriever: '检索器',
                      indexer: '索引器'
                    } as any
                  )[key]
                }}
              </h3>
              <dl class="detail-list">
                <template v-for="(value, label) in stats[key]" :key="label"
                  ><dt>{{ label }}</dt>
                  <dd>{{ value }}</dd></template
                >
              </dl>
              <p v-if="!stats[key]" class="muted">未启用</p>
            </article>
          </div>
        </section></template
      ></PageState
    >
  </div>
</template>
<style scoped>
.evaluation-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 800px;
  margin-top: 18px;
  font-size: 12px;
  text-align: left;
}
.evaluation-table th,
.evaluation-table td {
  padding: 14px 12px;
  border-bottom: 1px solid var(--c-border);
  white-space: nowrap;
}
.evaluation-table th {
  color: var(--c-muted);
  font-weight: 500;
}
.evaluation-source {
  margin-top: 22px;
  color: var(--c-muted);
  font-size: 12px;
}
.evaluation-source pre {
  margin-top: 14px;
}
.semantic-form {
  display: flex;
  gap: 14px;
  align-items: end;
  flex-wrap: wrap;
}
.semantic-form > .form-field {
  width: 170px;
}
.semantic-form > .query-field {
  flex: 1;
  min-width: 180px;
}
.rerank-label {
  display: flex;
  gap: 9px;
  align-items: center;
  font-size: 12px;
  padding-bottom: 7px;
}
.memory-item {
  padding: 18px 0;
  border-top: 1px solid var(--c-border);
}
.memory-heading {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--c-muted);
  font-size: 12px;
  flex-wrap: wrap;
}
.memory-item p {
  white-space: pre-wrap;
  margin: 13px 0;
  overflow-wrap: anywhere;
}
.memory-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.list-row pre {
  max-width: 70%;
  font-size: 12px;
}
@media (max-width: 600px) {
  .semantic-form > .form-field {
    width: 100%;
  }
  .list-row {
    display: block;
  }
  .list-row pre {
    max-width: 100%;
  }
}
</style>
