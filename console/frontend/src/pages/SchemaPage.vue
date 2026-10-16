<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NTab,
  NTabs,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import { api } from '../lib/api'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import SaveBar from '../components/SaveBar.vue'
import SchemaField from '../components/SchemaField.vue'
import {
  clone,
  equal,
  initialValues,
  validateField,
  validatePolicyFields,
  describeApply,
  type SchemaFieldDefinition,
  type SchemaGroup,
  type SchemaView
} from '../lib/schemaState'
import { useSchemaSaveShortcut } from '../lib/schemaKeyboard'
import { groupAdminModules } from '../lib/groupAdminState'
import { policyAdvanced, policyHelp, policySections, type PolicyKind } from '../lib/policySections'

const props = defineProps<{
  kind:
    | 'pipeline'
    | 'riskControl'
    | 'persona'
    | 'reasoning'
    | 'conversation'
    | 'groupAdmin'
    | PolicyKind
  embedded?: boolean
}>()
const message = useMessage()
const dialog = useDialog()
const loading = ref(true),
  saving = ref(false),
  error = ref(''),
  conflict = ref(false),
  saved = ref('')
const view = ref<SchemaView | null>(null)
const baseline = ref<Record<string, any>>({}),
  draft = ref<Record<string, any>>({})
const activeTab = ref('')
const root = ref<HTMLElement | null>(null)
let request: AbortController | undefined, saveRequest: AbortController | undefined
let generation = 0
const titles = {
  dice: '骰子基础设置',
  tracking: '对话追踪',
  memory: '记忆策略',
  groupAdmin: '群管理默认策略',
  conversation: '对话设置',
  reasoning: '思考程度',
  pipeline: '消息管道',
  riskControl: '风控管理',
  persona: '默认人设与画像'
}
const descriptions = {
  dice: '配置默认检定、掷骰上限、暗骰与团录行为。',
  tracking: '控制严格模式追踪与智能模式的群聊参与、续话和防刷屏策略。',
  memory: '配置记忆提取、召回、巩固、纠错和中期摘要。',
  groupAdmin: '设置群管理总开关与默认参数，单群可按需覆盖。',
  conversation: '设置对话触发、访问权限、上下文与回复方式。',
  reasoning: '按用途设置思考程度，保存后用于后续请求。',
  pipeline: '可靠接收、媒体搬运与健康报告，在一个地方配置。',
  riskControl: '为群聊和私聊设置发送节奏、内容审查与风险响应。',
  persona: '管理全局人设、表达学习和用户与群画像。'
}
const fields = computed(() => view.value?.groups.flatMap((group) => group.fields) || [])
const changedFields = computed(() =>
  fields.value.filter((field) => !equal(draft.value[field.field], baseline.value[field.field]))
)
const dirty = computed(() => changedFields.value.length)
const validation = computed(() => {
  const failures = changedFields.value.flatMap((field) =>
    validateField(field, draft.value[field.field])
  )
  if (
    props.kind === 'riskControl' &&
    changedFields.value.some((field) =>
      ['riskControl.delayMinMs', 'riskControl.delayMaxMs'].includes(field.field)
    ) &&
    Number(draft.value['riskControl.delayMinMs'] ?? 0) >
      Number(draft.value['riskControl.delayMaxMs'] ?? 400)
  )
    failures.push('随机延迟上限不能小于下限')
  return [...failures, ...validatePolicyFields(props.kind, draft.value, changedFields.value)]
})
useUnsavedGuard(() => dirty.value > 0 || saving.value)
useSchemaSaveShortcut(
  root,
  () =>
    Boolean(
      dirty.value && !saving.value && !loading.value && !conflict.value && !validation.value.length
    ),
  save
)

const sections = computed(() => {
  const groups = view.value?.groups || []
  if (['dice', 'tracking', 'memory'].includes(props.kind))
    return policySections(props.kind as PolicyKind, groups)
  if (props.kind === 'groupAdmin')
    return groupAdminModules
      .map((part) => ({
        ...part,
        groups: groups
          .map((group) => ({
            ...group,
            fields: group.fields.filter((field) => field.field.startsWith(`${part.id}.`))
          }))
          .filter((group) => group.fields.length)
      }))
      .filter((part) => part.groups.length)
  if (props.kind === 'conversation') {
    const parts = [
      { id: 'access', label: '触发与私聊', labels: ['对话开关与触发', '私聊功能'] },
      { id: 'permissions', label: '访问权限', labels: ['群聊权限', '用户黑名单', '违禁词拦截'] },
      { id: 'context', label: '上下文与路由', labels: ['聊天上下文', '上下文选择与智能路由'] },
      { id: 'models', label: '任务模型', labels: ['短闲聊模型', '进度回复模型', '翻译任务模型'] },
      { id: 'replies', label: '回复方式', labels: ['回复节奏', '理解增强'] }
    ]
    return parts
      .map((part) => ({
        ...part,
        groups: groups.filter((group) => part.labels.includes(group.label))
      }))
      .filter((part) => part.groups.length)
  }
  if (props.kind === 'pipeline')
    return [
      {
        id: 'pipeline',
        label: '可靠管道',
        groups: groups.filter((group) =>
          group.fields.some((field) => field.field.startsWith('messagePipeline.'))
        )
      },
      {
        id: 'authorization',
        label: '平台授权',
        groups: groups.filter((group) =>
          group.fields.some((field) => /^(bilibiliQualityRelay|youtubeRelay)\./.test(field.field))
        )
      },
      {
        id: 'reports',
        label: '健康报告',
        groups: groups.filter((group) =>
          group.fields.some((field) => field.field.startsWith('mediaRelayAdminReport.'))
        )
      }
    ].filter((section) => section.groups.length)
  if (props.kind === 'riskControl')
    return [
      {
        id: 'rate',
        label: '发送节奏',
        groups: groups.filter(
          (group) => !group.fields.some((field) => /censor|signal/.test(field.field))
        )
      },
      {
        id: 'censor',
        label: '内容审查',
        groups: groups.filter((group) => group.fields.some((field) => /censor/.test(field.field)))
      },
      {
        id: 'monitor',
        label: '风险响应',
        groups: groups.filter((group) => group.fields.some((field) => /signal/.test(field.field)))
      }
    ].filter((section) => section.groups.length)
  return groups.map((group, index) => ({ id: String(index), label: group.label, groups: [group] }))
})
const current = computed(
  () => sections.value.find((section) => section.id === activeTab.value) || sections.value[0]
)
const sectionHelp = computed(() =>
  ['dice', 'tracking', 'memory'].includes(props.kind)
    ? policyHelp[props.kind as PolicyKind][current.value?.id || ''] || ''
    : props.kind === 'conversation'
      ? (
          {
            access:
              '决定哪些消息可以触发对话，以及谁能私聊机器人。关闭对话总开关不影响骰子、搬运和群管。',
            permissions:
              '设置可使用对话的群、需要屏蔽的用户和违禁词。关闭群白名单后，所有群都可使用对话。',
            context: '控制近期聊天记录和每次请求选择的上下文，复杂请求可自动使用更强的模型。',
            models:
              '为短闲聊、进度回复和翻译单独设置模型。留空时沿用现有回退顺序；思考档位在 AI 模型页设置。',
            replies: '设置文字与表情的回复节奏，并增强对引用、转发和图片的理解。'
          } as Record<string, string>
        )[current.value?.id || '']
      : ''
)
function isAdvanced(field: SchemaFieldDefinition) {
  return (
    (props.kind === 'pipeline' && /Ttl|Concurrency|mediaArtifact|mediaShared/.test(field.field)) ||
    policyAdvanced(props.kind, field)
  )
}
const advancedTitle = computed(() =>
  props.kind === 'dice'
    ? '高级设置 · 存储目录'
    : props.kind === 'tracking'
      ? '高级设置 · 判断预算与状态细节'
      : props.kind === 'memory'
        ? '高级设置 · 去重与裁决预算'
        : '高级设置 · 并发、缓存与目录'
)
function basicFields(group: SchemaGroup) {
  return group.fields.filter((field) => !isAdvanced(field))
}
function advancedFields(group: SchemaGroup) {
  return group.fields.filter(isAdvanced)
}
function sectionDirty(groups: SchemaGroup[]) {
  return groups
    .flatMap((group) => group.fields)
    .filter((field) => !equal(draft.value[field.field], baseline.value[field.field])).length
}
function applyView(next: SchemaView, preserve: boolean, comparison = baseline.value) {
  const nextBaseline = initialValues(next)
  const local = draft.value
  draft.value = preserve
    ? Object.fromEntries(
        Object.entries(nextBaseline).map(([key, value]) => [
          key,
          key in local && !equal(local[key], comparison[key]) ? clone(local[key]) : value
        ])
      )
    : clone(nextBaseline)
  baseline.value = clone(nextBaseline)
  view.value = next
  if (!sections.value.some((section) => section.id === activeTab.value))
    activeTab.value = sections.value[0]?.id || ''
}
async function load(preserve = false) {
  if (saving.value) return
  const comparison = clone(preserve ? baseline.value : draft.value)
  const seq = ++generation
  request?.abort()
  request = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const next = await api<SchemaView>(`/api/config/${props.kind}`, { signal: request.signal })
    if (seq !== generation) return
    applyView(next, true, comparison)
    conflict.value = false
  } catch (cause: any) {
    if (cause?.name !== 'AbortError' && seq === generation)
      error.value = cause.message || '配置加载失败'
  } finally {
    if (seq === generation) loading.value = false
  }
}
async function save() {
  if (!dirty.value || saving.value || !view.value || loading.value || conflict.value) return
  if (validation.value.length) {
    message.error(validation.value[0])
    return
  }
  const seq = generation
  const kind = props.kind
  const snapshot = clone(draft.value)
  const snapshotBaseline = clone(baseline.value)
  const values: Record<string, any> = {},
    secrets: Record<string, any> = {}
  for (const field of fields.value) {
    if (equal(snapshot[field.field], snapshotBaseline[field.field])) continue
    if (field.secret || field.component === 'InputPassword')
      secrets[field.field] = snapshot[field.field]
    else values[field.field] = snapshot[field.field]
  }
  saving.value = true
  error.value = ''
  const controller = new AbortController()
  saveRequest = controller
  try {
    const result = await api<{ changed: number; applyHint?: string; revision?: string }>(
      `/api/config/${kind}`,
      {
        method: 'PUT',
        body: JSON.stringify({ values, secrets, revision: view.value.revision }),
        signal: controller.signal
      }
    )
    if (seq !== generation || controller.signal.aborted) return
    // Compare with the submitted snapshot so edits made while the request was running stay in the draft.
    const next = await api<SchemaView>(`/api/config/${kind}`, { signal: controller.signal })
    if (seq !== generation || controller.signal.aborted) return
    applyView(next, true, snapshot)
    saved.value = result.applyHint || `已保存 ${result.changed} 项配置`
    conflict.value = false
    message.success(dirty.value ? '已保存本次提交，之后的编辑仍保留在草稿中' : '配置已保存')
  } catch (cause: any) {
    if (cause?.name === 'AbortError' || seq !== generation || controller.signal.aborted) return
    conflict.value = cause.status === 409
    error.value = cause.message || '保存失败，草稿已保留'
  } finally {
    if (seq === generation) saving.value = false
  }
}
function discard() {
  dialog.warning({
    title: '放弃未保存的修改？',
    content: '当前页面的配置将恢复到最近加载或保存的版本。',
    positiveText: '放弃修改',
    negativeText: '继续编辑',
    onPositiveClick: () => {
      draft.value = clone(baseline.value)
      error.value = ''
      saved.value = ''
    }
  })
}
function reload() {
  if (saving.value) return
  if (!dirty.value) {
    void load()
    return
  }
  dialog.warning({
    title: '重新载入服务器配置？',
    content: '重新载入会丢弃本页草稿。选择“刷新并保留草稿”可以保留修改，再与最新配置比较。',
    positiveText: '丢弃草稿并重载',
    negativeText: '保留草稿',
    onPositiveClick: () => load()
  })
}
watch(
  () => props.kind,
  () => {
    activeTab.value = ''
    saved.value = ''
    void load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  generation++
  request?.abort()
  saveRequest?.abort()
})
defineExpose({ dirty, reload, saving, loading })
</script>

<template>
  <div ref="root" class="page-stack schema-page" :class="{ embedded }">
    <PageHeader
      v-if="!embedded"
      :title="titles[kind]"
      :description="descriptions[kind]"
      eyebrow="配置中心"
      ><template #actions
        ><NButton secondary :disabled="saving || loading" @click="reload"
          >刷新配置</NButton
        ></template
      ></PageHeader
    >
    <NAlert v-if="conflict" type="warning" title="服务器配置已发生变化" :show-icon="false"
      >草稿已保留。刷新服务器版本后核对修改，再保存。
      <div class="conflict-actions">
        <NButton size="small" @click="load(true)">刷新并保留草稿</NButton
        ><NButton size="small" quaternary @click="reload">重新载入</NButton>
      </div></NAlert
    >
    <NAlert
      v-else-if="error && view"
      type="error"
      :show-icon="false"
      :closable="true"
      @close="error = ''"
      >{{ error }}</NAlert
    >
    <PageState :loading="loading && !view" :error="!view ? error : ''" @retry="load()">
      <template v-if="view">
        <NAlert v-if="kind === 'memory'" type="info" :show-icon="false" title="保存后的记忆处理">
          保存会重新装配记忆服务，尚未摘要的中期缓冲会重新累积。已开始或已排队的摘要可能按旧参数完成；已有摘要与消息归档会保留。
        </NAlert>
        <div class="config-summary panel">
          <div>
            <span class="summary-label">配置状态</span
            ><strong>{{ dirty ? `${dirty} 项待保存` : '与服务器一致' }}</strong>
          </div>
          <p>保存自动备份。每个字段的生效方式会显示在说明中。</p>
          <NTag :type="dirty ? 'warning' : 'success'" size="small" :bordered="false">{{
            dirty ? '草稿' : '已同步'
          }}</NTag>
        </div>
        <NTabs :value="activeTab" type="line" animated @update:value="activeTab = $event"
          ><NTab v-for="section in sections" :key="section.id" :name="section.id">{{
            sectionDirty(section.groups)
              ? `${section.label} · ${sectionDirty(section.groups)}`
              : section.label
          }}</NTab></NTabs
        >
        <NAlert v-if="sectionHelp" type="info" :show-icon="false">{{ sectionHelp }}</NAlert>
        <section
          v-for="group in current?.groups || []"
          :key="group.label"
          class="panel config-panel"
        >
          <div class="panel-heading">
            <h2>{{ group.label }}</h2>
            <span class="muted">{{ group.fields.length }} 项设置</span>
          </div>
          <div v-if="basicFields(group).length" class="field-grid">
            <SchemaField
              v-for="field in basicFields(group)"
              :key="field.field"
              :field="field"
              v-model="draft[field.field]"
              :apply-hint="describeApply(field, kind)"
            />
          </div>
          <NCollapse v-if="advancedFields(group).length" class="advanced-settings"
            ><NCollapseItem name="advanced" :title="advancedTitle"
              ><div class="field-grid">
                <SchemaField
                  v-for="field in advancedFields(group)"
                  :key="field.field"
                  :field="field"
                  v-model="draft[field.field]"
                  :apply-hint="describeApply(field, kind)"
                /></div></NCollapseItem
          ></NCollapse>
        </section>
        <p v-if="dirty && validation.length" class="validation-note" role="status">
          {{ validation[0]
          }}<span v-if="validation.length > 1">，另有 {{ validation.length - 1 }} 项需要核对</span>
        </p>
        <SaveBar
          :dirty="dirty"
          :saving="saving"
          :disabled="!dirty || validation.length > 0 || loading || conflict"
          :saved="saved"
          @save="save"
          @discard="discard"
        />
      </template>
    </PageState>
  </div>
</template>

<style scoped>
.schema-page {
  max-width: 1120px;
}
.config-summary {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 18px 22px;
}
.config-summary > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 130px;
}
.summary-label {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--c-muted);
}
.config-summary strong {
  font-size: 14px;
  font-weight: 550;
}
.config-summary p {
  color: var(--c-muted);
  font-size: 12px;
  line-height: 1.6;
  flex: 1;
  margin: 0;
}
.config-panel {
  padding: 24px;
}
.config-panel .panel-heading {
  margin-bottom: 24px;
}
.panel-heading h2 {
  margin: 0;
  font-size: 15px;
}
.panel-heading .muted {
  font-size: 11px;
}
.advanced-settings {
  margin-top: 24px;
  border-top: 1px solid var(--c-border);
  padding-top: 18px;
}
.advanced-settings .field-grid {
  padding-top: 10px;
}
.conflict-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.validation-note {
  color: var(--c-danger);
  font-size: 12px;
  margin: 0;
}
.embedded {
  max-width: none;
}
@media (max-width: 736px) {
  .config-summary {
    flex-wrap: wrap;
    padding: 16px;
    gap: 12px;
  }
  .config-summary p {
    order: 3;
    flex-basis: 100%;
  }
  .config-summary :deep(.n-tag) {
    margin-left: auto;
  }
  .config-panel {
    padding: 18px 16px;
  }
}
</style>
