<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowDown, ArrowUp, FlaskConical, Plus, Trash2 } from 'lucide-vue-next'
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NInput,
  NInputNumber,
  NRadioButton,
  NRadioGroup,
  NSwitch,
  NTab,
  NTabs,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import { api } from '../lib/api'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import SchemaPage from './SchemaPage.vue'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import SaveBar from '../components/SaveBar.vue'
import { clone, equal } from '../lib/schemaState'
import {
  hydrateProvider,
  previewAiUrl,
  providerPayload,
  rebaseAiProviders,
  type AiDefinition,
  type AiOverview,
  type AiProvider
} from '../lib/schemaAi'
import { useSchemaSaveShortcut } from '../lib/schemaKeyboard'

interface ProbeResult {
  ok?: boolean
  name?: string
  ms?: number
  detail?: string
}
interface ProbeState {
  loading: boolean
  results: ProbeResult[]
  error?: string
  outdated?: boolean
}
const message = useMessage(),
  dialog = useDialog()
const overview = ref<AiOverview | null>(null),
  active = ref(''),
  loading = ref(true),
  loadError = ref('')
const baseline = ref<Record<string, AiProvider[]>>({}),
  drafts = ref<Record<string, AiProvider[]>>({})
const saving = ref<Record<string, boolean>>({}),
  errors = ref<Record<string, string>>({}),
  conflicts = ref<Record<string, boolean>>({}),
  saved = ref<Record<string, string>>({})
const probes = ref<Record<string, ProbeState>>({})
const root = ref<HTMLElement | null>(null)
let loadRequest: AbortController | undefined
const requests = new Set<AbortController>()
let loadGeneration = 0
const definition = computed(() =>
  overview.value?.definitions.find((def) => def.configKey === active.value)
)
const providers = computed(() => drafts.value[active.value] || [])
function dirtyCount(key: string) {
  const current = drafts.value[key] || [],
    base = baseline.value[key] || []
  const orderChanged = !equal(
    current.map((provider) => provider._clientId),
    base.map((provider) => provider._clientId)
  )
  return (
    current.filter(
      (provider) =>
        !equal(
          provider,
          base.find((item) => item._clientId === provider._clientId)
        )
    ).length + (orderChanged ? 1 : 0)
  )
}
const dirty = computed(() => dirtyCount(active.value))
const allDirty = computed(() =>
  Object.keys(drafts.value).reduce((total, key) => total + dirtyCount(key), 0)
)
const validation = computed(() => {
  const failures: string[] = []
  if (!providers.value.length) failures.push('至少保留一个渠道，避免意外清空模型配置')
  providers.value.forEach((provider, index) => {
    if (!provider.name.trim()) failures.push(`渠道 ${index + 1} 需要填写名称`)
    if (!/^https?:\/\//i.test(provider.apiUrl.trim()))
      failures.push(`渠道 ${index + 1} 需要填写完整的 HTTP 或 HTTPS URL`)
    if (!provider.model.trim()) failures.push(`渠道 ${index + 1} 需要填写模型名称`)
    if (provider.priority === null || Number(provider.priority) <= 0)
      failures.push(`渠道 ${index + 1} 的优先级需要大于 0`)
    if (provider._keyAction === 'replace' && !provider.apiKey.trim())
      failures.push(`渠道 ${index + 1} 需要输入新 API Key，或选择保持现有`)
  })
  return failures
})
useUnsavedGuard(() => allDirty.value > 0)
useSchemaSaveShortcut(
  root,
  () =>
    Boolean(
      dirty.value &&
      !saving.value[active.value] &&
      !loading.value &&
      !conflicts.value[active.value] &&
      !validation.value.length
    ),
  save
)
async function load(preserve = false) {
  loadRequest?.abort()
  loadRequest = new AbortController()
  const seq = ++loadGeneration
  loading.value = true
  loadError.value = ''
  try {
    const next = await api<AiOverview>('/api/ai/config', { signal: loadRequest.signal })
    if (seq !== loadGeneration) return
    const fresh = Object.fromEntries(
      Object.entries(next.sections || {}).map(([key, list]) => [
        key,
        list.map((provider) => hydrateProvider(provider))
      ])
    )
    const kept = Object.fromEntries(
      Object.keys(fresh).map((key) => [
        key,
        preserve && dirtyCount(key)
          ? rebaseAiProviders(fresh[key], drafts.value[key], baseline.value[key])
          : clone(fresh[key])
      ])
    )
    baseline.value = fresh
    drafts.value = kept
    overview.value = next
    conflicts.value = {}
    errors.value = {}
    if (!next.definitions.some((def) => def.configKey === active.value))
      active.value = next.definitions[0]?.configKey || ''
  } catch (cause: any) {
    if (cause.name !== 'AbortError' && seq === loadGeneration)
      loadError.value = cause.message || '模型配置加载失败'
  } finally {
    if (seq === loadGeneration) loading.value = false
  }
}
function refresh() {
  if (!allDirty.value) {
    void load()
    return
  }
  dialog.warning({
    title: '刷新模型配置？',
    content: '各组的未保存草稿会保留，服务器版本将重新加载。',
    positiveText: '刷新并保留草稿',
    negativeText: '继续编辑',
    onPositiveClick: () => load(true)
  })
}
function addProvider() {
  const key = active.value
  const maximum = Math.max(
    0,
    ...(drafts.value[key] || []).map((provider) => Number(provider.priority) || 0)
  )
  drafts.value[key].push(
    hydrateProvider({ name: '', apiUrl: '', model: '', priority: maximum + 1, autoResolve: true })
  )
}
function moveProvider(index: number, direction: number) {
  const rows = [...providers.value],
    target = index + direction
  if (target < 0 || target >= rows.length) return
  ;[rows[index], rows[target]] = [rows[target], rows[index]]
  rows.forEach((provider, order) => {
    provider.priority = order + 1
  })
  drafts.value[active.value] = rows
}
function removeProvider(provider: AiProvider) {
  const key = active.value,
    id = provider._clientId
  dialog.warning({
    title: `删除渠道「${provider.name || '未命名'}」？`,
    content: '删除会先记录在草稿中，保存本组后生效。',
    positiveText: '删除渠道',
    negativeText: '取消',
    onPositiveClick: () => {
      drafts.value[key] = drafts.value[key].filter((item) => item._clientId !== id)
    }
  })
}
function changeKeyAction(provider: AiProvider, action: AiProvider['_keyAction']) {
  provider._keyAction = action
  if (action !== 'replace') provider.apiKey = ''
}
async function save() {
  const key = active.value
  if (!dirtyCount(key) || saving.value[key] || conflicts.value[key] || loading.value) return
  if (validation.value.length) {
    message.error(validation.value[0])
    return
  }
  const snapshot = clone(drafts.value[key])
  const controller = new AbortController()
  requests.add(controller)
  saving.value[key] = true
  errors.value[key] = ''
  try {
    const result = await api<{
      providers: Record<string, any>[]
      revision?: string
      backup?: string
    }>('/api/ai/config', {
      method: 'PUT',
      body: JSON.stringify({
        configKey: key,
        providers: snapshot.map(providerPayload),
        revision: overview.value?.revisions?.[key]
      }),
      signal: controller.signal
    })
    const next = result.providers.map((provider, index) =>
      hydrateProvider(provider, snapshot[index]?._clientId)
    )
    const current = drafts.value[key]
    const byId = new Map(next.map((provider) => [provider._clientId, provider]))
    drafts.value[key] = current.map((provider) => {
      const submitted = snapshot.find((item) => item._clientId === provider._clientId)
      const fresh = byId.get(provider._clientId)
      if (!fresh || !submitted) return provider
      if (equal(provider, submitted)) return clone(fresh)
      const merged = clone(provider)
      merged._consoleId = fresh._consoleId
      merged.apiKeyConfigured = fresh.apiKeyConfigured
      if (provider._keyAction === submitted._keyAction && provider.apiKey === submitted.apiKey) {
        merged._keyAction = 'keep'
        merged.apiKey = ''
      }
      return merged
    })
    baseline.value[key] = clone(next)
    if (overview.value) {
      overview.value.sections[key] = result.providers
      if (result.revision)
        overview.value.revisions = { ...overview.value.revisions, [key]: result.revision }
    }
    conflicts.value[key] = false
    saved.value[key] = '本组已保存，立即生效'
    message.success(
      dirtyCount(key) ? '已保存本次提交，后续编辑仍留在草稿中' : '本组渠道已保存并生效'
    )
  } catch (cause: any) {
    if (cause.name !== 'AbortError') {
      errors.value[key] = cause.message || '保存失败，草稿已保留'
      conflicts.value[key] = cause.status === 409
    }
  } finally {
    saving.value[key] = false
    requests.delete(controller)
  }
}
function discard() {
  const key = active.value
  dialog.warning({
    title: '放弃本组修改？',
    content: '其他配置组的草稿会继续保留。',
    positiveText: '放弃本组修改',
    negativeText: '继续编辑',
    onPositiveClick: () => {
      drafts.value[key] = clone(baseline.value[key])
      errors.value[key] = ''
      saved.value[key] = ''
    }
  })
}
async function probe(provider?: AiProvider) {
  const key = active.value,
    id = provider ? `${key}:${provider._clientId}` : key
  if (probes.value[id]?.loading) return
  const snapshot = provider ? clone(provider) : null
  if (
    provider &&
    (!provider.apiUrl ||
      !provider.model ||
      (provider._keyAction === 'replace' && !provider.apiKey.trim()))
  ) {
    message.warning('先填写 URL、模型与替换的 API Key')
    return
  }
  const controller = new AbortController()
  requests.add(controller)
  probes.value[id] = { loading: true, results: [] }
  try {
    const result = await api<{ results: ProbeResult[] }>(
      provider ? '/api/ai/probe-provider' : '/api/ai/probe',
      {
        method: 'POST',
        body: JSON.stringify({
          configKey: key,
          ...(snapshot ? { provider: providerPayload(snapshot) } : {})
        }),
        signal: controller.signal
      }
    )
    const current = snapshot
      ? drafts.value[key].find((item) => item._clientId === snapshot._clientId)
      : null
    probes.value[id] = {
      loading: false,
      results: result.results || [],
      outdated: Boolean(snapshot && !equal(current, snapshot))
    }
  } catch (cause: any) {
    if (cause.name !== 'AbortError')
      probes.value[id] = { loading: false, results: [], error: cause.message || '测试失败' }
  } finally {
    requests.delete(controller)
  }
}
function shortTitle(def: AiDefinition) {
  return def.title.replace(/\s+[A-Za-z]\w*AiConfig$/, '').replace(/\s+embeddingAiConfig$/, '')
}
onMounted(() => load())
onBeforeUnmount(() => {
  loadGeneration++
  loadRequest?.abort()
  requests.forEach((controller) => controller.abort())
})
</script>

<template>
  <div ref="root" class="page-stack ai-page">
    <PageHeader
      title="AI 模型"
      description="按能力配置渠道、模型与备用顺序，独立保存每个配置组。"
      eyebrow="机器人能力"
      ><template #actions
        ><NButton secondary :disabled="loading" @click="refresh">刷新配置</NButton></template
      ></PageHeader
    >
    <section class="panel provider-panel">
      <h2>思考程度</h2>
      <p class="field-help">按全局聊天、短闲聊和复杂请求分别设置。模型支持的档位以渠道说明为准。</p>
      <SchemaPage kind="reasoning" embedded />
    </section>
    <PageState :loading="loading && !overview" :error="!overview ? loadError : ''" @retry="load()">
      <template v-if="overview && definition">
        <NAlert v-if="loadError" type="error" :show-icon="false">{{ loadError }}</NAlert>
        <div class="panel ai-summary">
          <div>
            <strong>{{ overview.definitions.length }} 个能力分组</strong
            ><span>切换分组会保留所有未保存草稿</span>
          </div>
          <NTag :type="allDirty ? 'warning' : 'success'" :bordered="false" size="small">{{
            allDirty ? '有待保存修改' : '已同步'
          }}</NTag>
        </div>
        <NTabs :value="active" type="line" @update:value="active = $event"
          ><NTab v-for="def in overview.definitions" :key="def.configKey" :name="def.configKey">{{
            shortTitle(def) + (dirtyCount(def.configKey) ? ' ·' : '')
          }}</NTab></NTabs
        >
        <div class="section-intro">
          <div>
            <h2>{{ shortTitle(definition) }}</h2>
            <p>{{ definition.usageHint }}</p>
          </div>
          <NButton secondary size="small" :loading="probes[active]?.loading" @click="probe()"
            ><template #icon><FlaskConical :size="15" /></template>测试已保存渠道</NButton
          >
        </div>
        <NAlert
          v-if="errors[active]"
          :type="conflicts[active] ? 'warning' : 'error'"
          :show-icon="false"
          >{{ errors[active] }}
          <div v-if="conflicts[active]" class="probe-actions">
            <NButton size="small" @click="load(true)">刷新并保留各组草稿</NButton>
          </div></NAlert
        >
        <div v-if="probes[active]" class="panel probe-panel" role="status">
          <p v-if="probes[active].loading">正在测试服务器上已保存的渠道…</p>
          <p v-if="probes[active].error" class="probe-error">{{ probes[active].error }}</p>
          <p v-for="(result, index) in probes[active].results" :key="index" class="probe-result">
            <NTag size="small" :bordered="false" :type="result.ok ? 'success' : 'error'">{{
              result.ok ? '通过' : '失败'
            }}</NTag
            ><strong>{{ result.name }}</strong
            ><span>{{ result.ms || 0 }} ms · {{ result.detail }}</span>
          </p>
        </div>
        <p class="ordering-hint">优先级数字越小越先使用。移动渠道会同步更新顺序和优先级。</p>
        <section
          v-for="(provider, index) in providers"
          :key="provider._clientId"
          class="panel provider-panel"
        >
          <div class="provider-heading">
            <div>
              <span class="provider-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <h3>{{ provider.name || '未命名渠道' }}</h3>
              <NTag
                size="small"
                :bordered="false"
                :type="provider.apiKeyConfigured ? 'success' : 'default'"
                >{{ provider.apiKeyConfigured ? '凭据已配置' : '无现有凭据' }}</NTag
              >
            </div>
            <div class="provider-ops">
              <NButton
                quaternary
                size="small"
                :disabled="index === 0"
                :aria-label="`上移渠道${index + 1}`"
                @click="moveProvider(index, -1)"
                ><template #icon><ArrowUp :size="16" /></template></NButton
              ><NButton
                quaternary
                size="small"
                :disabled="index === providers.length - 1"
                :aria-label="`下移渠道${index + 1}`"
                @click="moveProvider(index, 1)"
                ><template #icon><ArrowDown :size="16" /></template></NButton
              ><NButton
                quaternary
                size="small"
                type="error"
                :aria-label="`删除渠道${provider.name || index + 1}`"
                @click="removeProvider(provider)"
                ><template #icon><Trash2 :size="15" /></template
              ></NButton>
            </div>
          </div>
          <div class="field-grid">
            <div class="form-field">
              <label :for="`ai-${provider._clientId}-name`">渠道名称</label
              ><NInput
                v-model:value="provider.name"
                :input-props="{ id: `ai-${provider._clientId}-name` }"
                placeholder="例如 主渠道 / 备用渠道"
              />
            </div>
            <div class="form-field">
              <label :for="`ai-${provider._clientId}-model`">模型名称</label
              ><NInput
                v-model:value="provider.model"
                :input-props="{ id: `ai-${provider._clientId}-model` }"
                :placeholder="definition.modelPlaceholder"
              />
            </div>
            <div class="form-field full-field">
              <label :for="`ai-${provider._clientId}-url`">API 地址</label
              ><NInput
                v-model:value="provider.apiUrl"
                :input-props="{ id: `ai-${provider._clientId}-url`, spellcheck: false }"
                :placeholder="definition.urlPlaceholder"
              />
              <p class="url-preview">
                实际请求
                <code>{{ previewAiUrl(definition, provider) || '填写 API 地址后显示' }}</code>
              </p>
            </div>
            <div class="form-field full-field">
              <label>API Key</label>
              <div class="credential-row">
                <NRadioGroup
                  :value="provider._keyAction"
                  size="small"
                  :name="`key-${provider._clientId}`"
                  aria-label="API Key 处理方式"
                  @update:value="(value) => changeKeyAction(provider, value)"
                  ><NRadioButton value="keep">保持现有</NRadioButton
                  ><NRadioButton value="replace">替换</NRadioButton
                  ><NRadioButton value="clear">清除</NRadioButton></NRadioGroup
                ><span class="field-help">现有凭据不会回显</span>
              </div>
              <NInput
                v-if="provider._keyAction === 'replace'"
                v-model:value="provider.apiKey"
                type="password"
                show-password-on="click"
                placeholder="输入新的 API Key"
                :input-props="{
                  autocomplete: 'new-password',
                  'aria-label': provider.name + '新 API Key'
                }"
              />
              <p v-if="provider._keyAction === 'clear'" class="probe-error">
                保存后清除凭据，请确认渠道支持匿名访问。
              </p>
            </div>
          </div>
          <NCollapse class="provider-advanced"
            ><NCollapseItem title="渠道参数" name="parameters"
              ><div class="field-grid">
                <div class="form-field">
                  <label :for="`ai-${provider._clientId}-priority`">优先级</label
                  ><NInputNumber
                    v-model:value="provider.priority"
                    :min="1"
                    :step="1"
                    :input-props="{ id: `ai-${provider._clientId}-priority` }"
                  />
                </div>
                <div class="form-field">
                  <label>URL 自动补全</label
                  ><NSwitch
                    v-model:value="provider.autoResolve"
                    :aria-label="provider.name + ' URL 自动补全'"
                  /><span class="field-help">聊天地址会自动补全 /v1/chat/completions</span>
                </div>
                <div
                  v-for="extra in definition.extraFields || []"
                  :key="extra.field"
                  class="form-field"
                >
                  <label :for="`ai-${provider._clientId}-${extra.field}`">{{ extra.label }}</label
                  ><NInput
                    v-model:value="provider[extra.field]"
                    :placeholder="extra.placeholder"
                    :input-props="{ id: `ai-${provider._clientId}-${extra.field}` }"
                  />
                </div></div></NCollapseItem
          ></NCollapse>
          <div class="provider-footer">
            <span>保存后立即生效，自动保留备份</span
            ><NButton
              size="small"
              secondary
              :loading="probes[`${active}:${provider._clientId}`]?.loading"
              @click="probe(provider)"
              ><template #icon><FlaskConical :size="14" /></template>测试当前草稿</NButton
            >
          </div>
          <div
            v-if="probes[`${active}:${provider._clientId}`]"
            class="provider-probe"
            role="status"
          >
            <span v-if="probes[`${active}:${provider._clientId}`].loading">测试中…</span
            ><span v-if="probes[`${active}:${provider._clientId}`].error" class="probe-error">{{
              probes[`${active}:${provider._clientId}`].error
            }}</span>
            <p
              v-for="(result, resultIndex) in probes[`${active}:${provider._clientId}`].results"
              :key="resultIndex"
              class="probe-result"
            >
              <NTag :type="result.ok ? 'success' : 'error'" size="small" :bordered="false">{{
                result.ok ? '通过' : '失败'
              }}</NTag
              ><span>{{ result.ms || 0 }} ms · {{ result.detail }}</span>
            </p>
            <span v-if="probes[`${active}:${provider._clientId}`].outdated" class="field-help"
              >测试后草稿已有变化，以上结果对应测试时的配置。</span
            >
          </div>
        </section>
        <div v-if="!providers.length" class="panel empty-providers">
          <h3>还没有渠道</h3>
          <p>添加一个模型渠道，为这项能力提供服务。</p>
        </div>
        <NButton secondary class="add-provider" @click="addProvider"
          ><template #icon><Plus :size="16" /></template>添加渠道</NButton
        >
        <p v-if="dirty && validation.length" class="probe-error validation-note" role="status">
          {{ validation[0] }}
        </p>
        <SaveBar
          :dirty="dirty"
          :saving="Boolean(saving[active])"
          :disabled="!dirty || validation.length > 0 || Boolean(conflicts[active]) || loading"
          :saved="saved[active]"
          @save="save"
          @discard="discard"
        />
      </template>
    </PageState>
  </div>
</template>

<style scoped>
.ai-page {
  max-width: 1120px;
}
.ai-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px;
  gap: 12px;
}
.ai-summary > div {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ai-summary strong {
  font-size: 14px;
}
.ai-summary span {
  color: var(--c-muted);
  font-size: 12px;
}
.section-intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}
.section-intro h2 {
  font-size: 17px;
  margin: 0 0 8px;
}
.section-intro p {
  margin: 0;
  color: var(--c-muted);
  font-size: 12px;
  line-height: 1.7;
}
.ordering-hint {
  font-size: 12px;
  color: var(--c-muted);
  margin: 0;
}
.provider-panel {
  padding: 22px;
}
.provider-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 22px;
}
.provider-heading > div:first-child {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.provider-heading h3 {
  margin: 0;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.provider-index {
  color: var(--c-accent);
  font-size: 11px;
  background: rgba(95, 160, 229, 0.08);
  border-radius: 6px;
  padding: 5px 7px;
}
.provider-ops {
  display: flex;
  flex-shrink: 0;
}
.full-field {
  grid-column: 1 / -1;
}
.url-preview {
  color: var(--c-muted);
  font-size: 11px;
  margin: 0;
  line-height: 1.6;
  word-break: break-all;
}
.url-preview code {
  color: var(--c-accent);
  margin-left: 7px;
}
.credential-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.provider-advanced {
  border-top: 1px solid var(--c-border);
  padding-top: 15px;
  margin-top: 22px;
}
.provider-advanced .field-grid {
  padding-top: 9px;
}
.provider-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 18px;
}
.provider-footer > span {
  color: var(--c-muted);
  font-size: 11px;
}
.provider-probe {
  margin-top: 15px;
  padding-top: 12px;
  border-top: 1px solid var(--c-border);
  font-size: 12px;
}
.probe-panel {
  padding: 16px 20px;
}
.probe-panel p {
  margin: 7px 0;
  font-size: 12px;
}
.probe-result {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  font-size: 12px;
}
.probe-result span {
  overflow-wrap: anywhere;
}
.probe-error {
  color: var(--c-danger);
  font-size: 12px;
  margin: 0;
}
.probe-actions {
  margin-top: 12px;
}
.empty-providers {
  text-align: center;
  padding: 34px 16px;
}
.empty-providers h3 {
  font-size: 16px;
}
.empty-providers p {
  color: var(--c-muted);
  font-size: 12px;
}
.add-provider {
  align-self: flex-start;
}
.validation-note {
  margin: 0;
}
@media (max-width: 736px) {
  .provider-panel {
    padding: 18px 15px;
  }
  .section-intro {
    flex-direction: column;
    gap: 13px;
  }
  .provider-heading > div:first-child {
    gap: 7px;
    flex-wrap: wrap;
  }
  .provider-heading :deep(.n-tag) {
    display: none;
  }
  .provider-footer {
    align-items: flex-start;
  }
  .provider-footer > span {
    max-width: 160px;
    line-height: 1.6;
  }
  .ai-summary {
    padding: 16px;
  }
}
</style>
