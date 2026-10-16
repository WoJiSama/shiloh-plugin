<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { NAlert, NButton, NTab, NTabs, NTag, useDialog, useMessage } from 'naive-ui'
import { api } from '../lib/api'
import { clone, describeApply, validateField } from '../lib/schemaState'
import {
  groupAdminChanges,
  groupAdminFields,
  groupAdminInitial,
  groupAdminModules,
  groupAdminPayload,
  isGroupEnabled,
  rebaseGroupAdminDraft,
  resetGroupAdminField,
  sameGroupAdminEntry,
  type GroupAdminDraft,
  type GroupAdminField,
  type GroupAdminView
} from '../lib/groupAdminState'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import { useSchemaSaveShortcut } from '../lib/schemaKeyboard'
import PageState from './PageState.vue'
import SaveBar from './SaveBar.vue'
import SchemaField from './SchemaField.vue'

const props = defineProps<{ groupId: string }>()
const emit = defineEmits<{ saved: [] }>()
const dialog = useDialog()
const message = useMessage()
const view = ref<GroupAdminView | null>(null)
const baseline = ref<GroupAdminDraft>({})
const draft = ref<GroupAdminDraft>({})
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const conflict = ref(false)
const saved = ref('')
const activeTab = ref<string>('groupGuard')
const root = ref<HTMLElement | null>(null)
let request: AbortController | undefined
let saveRequest: AbortController | undefined
let generation = 0
const fields = computed(() => (view.value ? groupAdminFields(view.value) : []))
const changedFields = computed(() => groupAdminChanges(fields.value, draft.value, baseline.value))
const dirty = computed(() => changedFields.value.length)
const validation = computed(() =>
  changedFields.value.flatMap((field) =>
    draft.value[field.field]?.custom ? validateField(field, draft.value[field.field].value) : []
  )
)
const sections = computed(() =>
  groupAdminModules
    .map((module) => ({
      ...module,
      groups: (view.value?.groups || [])
        .map((group) => ({
          ...group,
          fields: group.fields.filter((field) => field.field.startsWith(`${module.id}.`))
        }))
        .filter((group) => group.fields.length)
    }))
    .filter((module) => module.groups.length)
)
const current = computed(
  () => sections.value.find((section) => section.id === activeTab.value) || sections.value[0]
)
const paused = computed(() =>
  sections.value.filter(
    (section) =>
      draft.value[`${section.id}.enabled`]?.value === true && !view.value?.masters[section.id]
  )
)
const customizationCount = computed(
  () =>
    fields.value.filter((field) => !isGroupEnabled(field.field) && draft.value[field.field]?.custom)
      .length
)
useUnsavedGuard(() => dirty.value > 0 || saving.value)
useSchemaSaveShortcut(
  root,
  () =>
    Boolean(
      dirty.value && !saving.value && !loading.value && !conflict.value && !validation.value.length
    ),
  save
)
function sectionDirty(id: string) {
  return changedFields.value.filter((field) => field.field.startsWith(`${id}.`)).length
}
function applyView(next: GroupAdminView, preserve = false, comparison = baseline.value) {
  draft.value = preserve
    ? rebaseGroupAdminDraft(next, draft.value, comparison)
    : groupAdminInitial(next)
  baseline.value = groupAdminInitial(next)
  view.value = next
  if (!sections.value.some((section) => section.id === activeTab.value))
    activeTab.value = sections.value[0]?.id || ''
}
async function load(preserve = false) {
  if (saving.value) return
  const comparison = clone(preserve ? baseline.value : draft.value)
  const seq = ++generation
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const next = await api<GroupAdminView>(`/api/groups/${props.groupId}/admin`, {
      signal: controller.signal
    })
    if (seq !== generation || controller.signal.aborted) return
    applyView(next, true, comparison)
    conflict.value = false
  } catch (cause: any) {
    if (seq === generation && !controller.signal.aborted)
      error.value = cause.message || '本群配置加载失败'
  } finally {
    if (seq === generation) loading.value = false
  }
}
async function save() {
  if (!dirty.value || saving.value || loading.value || conflict.value || !view.value) return
  if (validation.value.length) {
    message.error(validation.value[0])
    return
  }
  const seq = generation
  const groupId = props.groupId
  const snapshot = clone(draft.value)
  const payload = groupAdminPayload(fields.value, snapshot, baseline.value, view.value.revision)
  const controller = new AbortController()
  saveRequest = controller
  saving.value = true
  error.value = ''
  try {
    const result = await api<GroupAdminView & { changed: number; applyHint?: string }>(
      `/api/groups/${groupId}/admin`,
      { method: 'PUT', body: JSON.stringify(payload), signal: controller.signal }
    )
    if (seq !== generation || controller.signal.aborted || props.groupId !== groupId) return
    applyView(result, true, snapshot)
    saved.value = result.applyHint || `已保存 ${result.changed} 项配置，后续群事件生效`
    conflict.value = false
    emit('saved')
    message.success(dirty.value ? '本次提交已保存，后续编辑仍在草稿中' : '本群配置已保存')
  } catch (cause: any) {
    if (seq !== generation || controller.signal.aborted) return
    conflict.value = cause.status === 409
    error.value = cause.message || '保存失败，草稿已保留'
  } finally {
    if (seq === generation) saving.value = false
  }
}
function edit(field: GroupAdminField, value: any) {
  draft.value[field.field] = { custom: true, value: clone(value) }
}
function customize(field: GroupAdminField) {
  draft.value[field.field] = { custom: true, value: clone(draft.value[field.field].value) }
}
function reset(field: GroupAdminField) {
  if (!isGroupEnabled(field.field)) draft.value[field.field] = resetGroupAdminField(field)
}
function stateLabel(field: GroupAdminField) {
  const entry = draft.value[field.field]
  if (!entry?.custom) return baseline.value[field.field]?.custom ? '待恢复默认' : '继承默认'
  if (field.inheritance === 'legacy' && sameGroupAdminEntry(entry, baseline.value[field.field]))
    return '原有单群配置'
  return '本群自定义'
}
function preview(value: any) {
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (value === '' || value === null || value === undefined) return '留空'
  if (Array.isArray(value))
    return value.length
      ? value.map((entry) => (typeof entry === 'object' ? JSON.stringify(entry) : entry)).join('、')
      : '无'
  return String(value)
}
function resetAll() {
  const groupId = props.groupId
  dialog.warning({
    title: '恢复本群默认策略？',
    content:
      '清除本群自定义参数、旧通知文案与本群通知名单，保留三个模块的本群启用状态。确认后仍需保存。',
    positiveText: '恢复默认',
    negativeText: '继续编辑',
    onPositiveClick: () => {
      if (groupId !== props.groupId || saving.value) return
      fields.value.forEach(reset)
    }
  })
}
function discard() {
  const groupId = props.groupId
  dialog.warning({
    title: '放弃本群未保存的修改？',
    content: '恢复到最近加载或保存的本群配置。',
    positiveText: '放弃修改',
    negativeText: '继续编辑',
    onPositiveClick: () => {
      if (groupId !== props.groupId || saving.value) return
      draft.value = clone(baseline.value)
      error.value = ''
      saved.value = ''
    }
  })
}
function reload() {
  if (saving.value) return
  if (!dirty.value) return void load()
  const groupId = props.groupId
  dialog.warning({
    title: '重新载入本群配置？',
    content: '重新载入会丢弃本群草稿。发生冲突时也可以刷新并保留草稿。',
    positiveText: '丢弃草稿并重载',
    negativeText: '继续编辑',
    onPositiveClick: () => {
      if (groupId === props.groupId) return load()
    }
  })
}
watch(
  () => props.groupId,
  () => {
    generation++
    request?.abort()
    saveRequest?.abort()
    saving.value = false
    view.value = null
    baseline.value = {}
    draft.value = {}
    conflict.value = false
    saved.value = ''
    activeTab.value = 'groupGuard'
    void load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  generation++
  request?.abort()
  saveRequest?.abort()
})
</script>

<template>
  <div ref="root" class="page-stack group-admin-editor">
    <div class="panel editor-summary">
      <div>
        <span class="summary-label">本群策略</span>
        <strong>{{
          customizationCount ? `${customizationCount} 项本群自定义` : '继承默认参数'
        }}</strong>
        <p>编辑字段后仅为本群保存。恢复默认保留模块启用状态，保存后用于后续群事件。</p>
      </div>
      <div class="editor-actions">
        <NButton size="small" :disabled="loading || saving" @click="resetAll">恢复本群默认</NButton>
        <NButton
          size="small"
          secondary
          :loading="loading && !!view"
          :disabled="saving"
          @click="reload"
          >刷新配置</NButton
        >
      </div>
    </div>
    <NAlert v-if="conflict" type="warning" title="服务器配置已发生变化" :show-icon="false">
      本群草稿已保留。刷新服务器版本后核对修改，再保存。
      <div class="editor-actions conflict-actions">
        <NButton size="small" :disabled="loading" @click="load(true)">刷新并保留草稿</NButton>
        <NButton size="small" quaternary :disabled="loading" @click="reload">重新载入</NButton>
      </div>
    </NAlert>
    <NAlert
      v-else-if="error && view"
      type="error"
      :show-icon="false"
      closable
      @close="error = ''"
      >{{ error }}</NAlert
    >
    <PageState :loading="loading && !view" :error="!view ? error : ''" @retry="load()">
      <template v-if="view">
        <NAlert v-if="paused.length" type="warning" :show-icon="false" title="部分功能尚未生效">
          {{ paused.map((module) => module.label).join('、') }}已在本群启用，但对应总开关关闭。
          <RouterLink to="/group-admin?scope=defaults">前往默认策略开启总开关 →</RouterLink>
        </NAlert>
        <NTabs :value="activeTab" type="line" @update:value="activeTab = $event">
          <NTab v-for="section in sections" :key="section.id" :name="section.id">
            {{ section.label
            }}<span v-if="sectionDirty(section.id)"> · {{ sectionDirty(section.id) }}</span>
          </NTab>
        </NTabs>
        <section
          v-for="group in current?.groups || []"
          :key="group.label"
          class="panel group-config-panel"
        >
          <div class="panel-heading">
            <div>
              <h2>{{ group.label }}</h2>
              <p>{{ current?.description }}</p>
            </div>
            <NTag
              v-if="current"
              :type="
                draft[`${current.id}.enabled`]?.value && view.masters[current.id]
                  ? 'success'
                  : 'default'
              "
              size="small"
              :bordered="false"
            >
              {{
                draft[`${current.id}.enabled`]?.value
                  ? view.masters[current.id]
                    ? '本群已启用'
                    : '总开关关闭'
                  : '本群未启用'
              }}
            </NTag>
          </div>
          <div class="field-grid">
            <div
              v-for="field in group.fields"
              :key="field.field"
              class="group-admin-field"
              :class="{
                'field-full': field.component === 'InputTextArea' || field.component === 'GSubForm'
              }"
              :data-field="field.field"
            >
              <div v-if="!isGroupEnabled(field.field)" class="inheritance-toolbar">
                <NTag
                  :type="draft[field.field]?.custom ? 'info' : 'default'"
                  size="small"
                  :bordered="false"
                  >{{ stateLabel(field) }}</NTag
                >
                <NButton
                  v-if="draft[field.field]?.custom"
                  size="tiny"
                  quaternary
                  @click="reset(field)"
                  >恢复默认</NButton
                >
                <NButton v-else size="tiny" quaternary @click="customize(field)"
                  >本群自定义</NButton
                >
              </div>
              <SchemaField
                :field="field"
                :model-value="draft[field.field]?.value"
                :apply-hint="describeApply(field, 'groupAdmin')"
                @update:model-value="edit(field, $event)"
              />
              <p
                v-if="!isGroupEnabled(field.field) && draft[field.field]?.custom"
                class="default-preview"
                :title="preview(field.defaultValue)"
              >
                默认：{{ preview(field.defaultValue) }}
              </p>
            </div>
          </div>
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
.editor-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.summary-label {
  display: block;
  color: var(--c-muted);
  font-size: 11px;
  margin-bottom: 4px;
}
.editor-summary strong {
  font-size: 15px;
  font-weight: 550;
}
.editor-summary p {
  color: var(--c-muted);
  font-size: 12px;
  margin-top: 6px;
  max-width: 66ch;
}
.editor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
}
.conflict-actions {
  margin-top: 12px;
}
.group-config-panel {
  padding: 24px;
}
.panel-heading h2 {
  font-size: 15px;
}
.group-admin-field {
  border-top: 1px solid var(--c-border);
  padding-top: 16px;
  min-width: 0;
}
.field-full {
  grid-column: 1 / -1;
}
.inheritance-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
.default-preview {
  font-size: 11px;
  color: var(--c-muted);
  margin-top: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.validation-note {
  color: var(--c-danger);
  font-size: 12px;
}
@media (max-width: 736px) {
  .editor-summary {
    flex-wrap: wrap;
    padding: 16px;
  }
  .group-config-panel {
    padding: 18px 16px;
  }
  .editor-actions {
    flex-wrap: wrap;
  }
}
</style>
