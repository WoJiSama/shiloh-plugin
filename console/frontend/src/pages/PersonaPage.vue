<script setup lang="ts">
import { clientId as newClientId } from '../lib/clientId'

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Plus, Trash2, UserRound } from 'lucide-vue-next'
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NInput,
  NSelect,
  NTab,
  NTabs,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import IdentityLabel from '../components/IdentityLabel.vue'
import { botLabel, groupLabel } from '../lib/identities'
import { api } from '../lib/api'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import SaveBar from '../components/SaveBar.vue'
import SchemaField from '../components/SchemaField.vue'
import SchemaPage from './SchemaPage.vue'
import {
  clone,
  defaultValue,
  equal,
  validateField,
  type SchemaFieldDefinition
} from '../lib/schemaState'
import { useSchemaSaveShortcut } from '../lib/schemaKeyboard'

interface Persona {
  id: string
  name: string
  _clientId: string
  [key: string]: any
}
interface LibraryState {
  personas: Persona[]
  groupBindings: Record<string, string>
  accountBindings: Record<string, string>
  privateBinding: string
}
interface LibraryView {
  personas: Record<string, any>[]
  groupBindings: Record<string, string>
  accountBindings: Record<string, string>
  privateBinding: string
  revision?: string
  basePersona?: { name?: string; identity?: string; tone?: string }
}
interface Account {
  qq: string
  nickname?: string
  container?: string
  running?: boolean
}
const fields: SchemaFieldDefinition[] = [
  {
    field: 'identity',
    label: '身份定位',
    component: 'InputTextArea',
    props: { placeholder: '在聊天中的身份、关系和角色' }
  },
  {
    field: 'tone',
    label: '语气',
    component: 'InputTextArea',
    props: { placeholder: '例如：熟人、随意、会碎碎念' }
  },
  { field: 'speechStyle', label: '说话风格', component: 'GTags' },
  { field: 'preferences', label: '偏好与话题', component: 'GTags' },
  { field: 'boundaries', label: '固定边界', component: 'GTags' },
  { field: 'notes', label: '其他备注', component: 'InputTextArea' },
  {
    field: 'moods',
    label: '调皮心情时刻',
    component: 'GSubForm',
    help: '每条回复按概率着色一次心情；建议概率 0.05～0.2，同群 10 分钟冷却。',
    subFields: [
      { field: 'name', label: '心情名', component: 'Input', required: true },
      { field: 'hint', label: '心情提示', component: 'InputTextArea', required: true },
      {
        field: 'probability',
        label: '触发概率',
        component: 'InputNumber',
        props: { min: 0.01, max: 1, step: 0.01 }
      }
    ]
  }
]
const blank = (): LibraryState => ({
  personas: [],
  groupBindings: {},
  accountBindings: {},
  privateBinding: ''
})
const draft = ref<LibraryState>(blank()),
  baseline = ref<LibraryState>(blank())
const view = ref<LibraryView | null>(null),
  accounts = ref<Account[]>([])
const loading = ref(true),
  saving = ref(false),
  error = ref(''),
  accountError = ref(''),
  saved = ref(''),
  conflict = ref(false)
const tab = ref('library'),
  defaultsOpened = ref(false),
  selectedId = ref(''),
  search = ref('')
const accountId = ref(''),
  accountPersona = ref('default'),
  groupId = ref(''),
  groupPersona = ref('default')
const message = useMessage(),
  dialog = useDialog()
const root = ref<HTMLElement | null>(null)
let request: AbortController | undefined,
  saveRequest: AbortController | undefined,
  generation = 0
function payload(state: LibraryState) {
  return { ...state, personas: state.personas.map(({ _clientId, ...persona }) => persona) }
}
function hydrate(next: LibraryView, comparison = baseline.value): LibraryState {
  return {
    personas: next.personas.map(
      (persona) =>
        ({
          ...persona,
          _clientId:
            comparison.personas.find((item) => item.id === persona.id)?._clientId ||
            persona.id ||
            newClientId()
        }) as Persona
    ),
    groupBindings: next.groupBindings || {},
    accountBindings: next.accountBindings || {},
    privateBinding: next.privateBinding || ''
  }
}
const dirty = computed(() => {
  const changedPeople = draft.value.personas.filter(
    (persona) =>
      !equal(
        persona,
        baseline.value.personas.find((item) => item._clientId === persona._clientId)
      )
  ).length
  const removed = baseline.value.personas.filter(
    (persona) => !draft.value.personas.some((item) => item._clientId === persona._clientId)
  ).length
  const changedBindings = ['accountBindings', 'groupBindings'].reduce((count, key) => {
    const a = draft.value[key as 'accountBindings'],
      b = baseline.value[key as 'accountBindings']
    return (
      count +
      [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((id) => a[id] !== b[id]).length
    )
  }, 0)
  return (
    changedPeople +
    removed +
    changedBindings +
    (draft.value.privateBinding !== baseline.value.privateBinding ? 1 : 0)
  )
})
const selected = computed(() =>
  draft.value.personas.find((persona) => persona._clientId === selectedId.value)
)
const filtered = computed(() =>
  draft.value.personas.filter((persona) =>
    `${persona.name} ${persona.identity || ''}`.toLowerCase().includes(search.value.toLowerCase())
  )
)
const options = computed(() => [
  { label: '使用全局默认', value: 'default' },
  ...draft.value.personas.map((persona) => ({
    label: persona.name || '未命名人设',
    value: persona.id
  }))
])
const accountRows = computed(() =>
  [
    ...new Set([
      ...accounts.value.map((account) => account.qq).filter(Boolean),
      ...Object.keys(draft.value.accountBindings)
    ])
  ].map((qq) => ({ qq, ...accounts.value.find((account) => account.qq === qq) }))
)
const validation = computed(() => {
  const failures: string[] = [],
    ids = new Set<string>(),
    names = new Set<string>()
  draft.value.personas.forEach((persona, index) => {
    if (!persona.name.trim()) failures.push(`第 ${index + 1} 个人设需要填写名字`)
    if (!persona.id.trim() || persona.id === 'default')
      failures.push(`${persona.name || '人设'}需要一个非 default 的标识`)
    if (ids.has(persona.id)) failures.push(`人设标识 ${persona.id} 重复`)
    if (names.has(persona.name.trim().toLowerCase())) failures.push(`人设名字 ${persona.name} 重复`)
    ids.add(persona.id)
    names.add(persona.name.trim().toLowerCase())
    for (const field of fields)
      if (persona[field.field] !== undefined)
        failures.push(
          ...validateField(field, persona[field.field]).map(
            (failure) => `${persona.name} · ${failure}`
          )
        )
  })
  return failures
})
useUnsavedGuard(() => dirty.value > 0)
useSchemaSaveShortcut(
  root,
  () =>
    Boolean(
      dirty.value && !saving.value && !loading.value && !conflict.value && !validation.value.length
    ),
  save,
  () => tab.value !== 'default'
)
function ensureSelection() {
  if (!draft.value.personas.some((persona) => persona._clientId === selectedId.value))
    selectedId.value = draft.value.personas[0]?._clientId || ''
}
function mergeRecord(
  fresh: Record<string, any>,
  current: Record<string, any>,
  comparison: Record<string, any>
) {
  const result = clone(fresh)
  for (const key of new Set([...Object.keys(current), ...Object.keys(comparison)])) {
    if (equal(current[key], comparison[key])) continue
    if (key in current) result[key] = clone(current[key])
    else delete result[key]
  }
  return result
}
function applyView(next: LibraryView, preserve: boolean, comparison = baseline.value) {
  const fresh = hydrate(next, comparison)
  if (preserve) {
    const current = draft.value
    const people = current.personas.flatMap((persona) => {
      const previous = comparison.personas.find((item) => item._clientId === persona._clientId)
      const server = fresh.personas.find((item) => item._clientId === persona._clientId)
      if (!previous) return [clone(persona)]
      if (!server) return equal(persona, previous) ? [] : [clone(persona)]
      return [mergeRecord(server, persona, previous) as Persona]
    })
    // Retain server-added entries unless the local draft explicitly deleted them.
    fresh.personas.forEach((persona) => {
      if (
        !comparison.personas.some((item) => item._clientId === persona._clientId) &&
        !people.some((item) => item._clientId === persona._clientId)
      )
        people.push(clone(persona))
    })
    draft.value = {
      personas: people,
      groupBindings: mergeRecord(
        fresh.groupBindings,
        current.groupBindings,
        comparison.groupBindings
      ),
      accountBindings: mergeRecord(
        fresh.accountBindings,
        current.accountBindings,
        comparison.accountBindings
      ),
      privateBinding:
        current.privateBinding !== comparison.privateBinding
          ? current.privateBinding
          : fresh.privateBinding
    }
  } else draft.value = clone(fresh)
  baseline.value = clone(fresh)
  view.value = next
  ensureSelection()
}
async function load(preserve = false) {
  const seq = ++generation
  request?.abort()
  request = new AbortController()
  loading.value = true
  error.value = ''
  const results = await Promise.allSettled([
    api<LibraryView>('/api/persona/library', { signal: request.signal }),
    api<{ accounts: Account[] }>('/api/persona/accounts', { signal: request.signal })
  ])
  if (seq !== generation) return
  if (results[0].status === 'fulfilled') {
    applyView(results[0].value, preserve)
    conflict.value = false
  } else if (results[0].reason?.name !== 'AbortError')
    error.value = results[0].reason.message || '人设库加载失败'
  if (results[1].status === 'fulfilled') {
    accounts.value = results[1].value.accounts || []
    accountError.value = ''
  } else if (results[1].reason?.name !== 'AbortError')
    accountError.value = '账号列表暂时无法加载，可以手动添加账号绑定。'
  loading.value = false
}
function refresh() {
  if (!dirty.value) {
    void load()
    return
  }
  dialog.warning({
    title: '刷新人设库？',
    content: '草稿会保留，服务器版本将重新载入。默认配置页的草稿也会继续保留。',
    positiveText: '刷新并保留草稿',
    negativeText: '继续编辑',
    onPositiveClick: () => load(true)
  })
}
function switchTab(value: string) {
  tab.value = value
  if (value === 'default') defaultsOpened.value = true
}
function addPersona() {
  const id = `persona-${newClientId()}`
  draft.value.personas.push({ id, _clientId: id, name: '新人设' })
  selectedId.value = id
  search.value = ''
  tab.value = 'library'
}
function bindingCount(id: string) {
  return (
    Object.values(draft.value.groupBindings).filter((value) => value === id).length +
    Object.values(draft.value.accountBindings).filter((value) => value === id).length +
    (draft.value.privateBinding === id ? 1 : 0)
  )
}
function deletePersona(persona: Persona) {
  dialog.warning({
    title: `删除人设「${persona.name}」？`,
    content: `保存后生效。${bindingCount(persona.id) ? `关联的 ${bindingCount(persona.id)} 个绑定将解除，按剩余绑定优先级回退。` : '此人设目前没有关联绑定。'}`,
    positiveText: '删除人设',
    negativeText: '取消',
    onPositiveClick: () => {
      draft.value.personas = draft.value.personas.filter(
        (item) => item._clientId !== persona._clientId
      )
      for (const bindings of [draft.value.groupBindings, draft.value.accountBindings])
        for (const key of Object.keys(bindings))
          if (bindings[key] === persona.id) delete bindings[key]
      if (draft.value.privateBinding === persona.id) draft.value.privateBinding = ''
      ensureSelection()
    }
  })
}
function renameId(persona: Persona, value: string) {
  const previous = persona.id
  persona.id = value
  for (const bindings of [draft.value.groupBindings, draft.value.accountBindings])
    for (const key of Object.keys(bindings)) if (bindings[key] === previous) bindings[key] = value
  if (draft.value.privateBinding === previous) draft.value.privateBinding = value
}
function inherit(persona: Persona, field: string) {
  delete persona[field]
}
function customize(persona: Persona, field: SchemaFieldDefinition) {
  persona[field.field] = defaultValue(field.component)
}
function setBinding(kind: 'accountBindings' | 'groupBindings', id: string, value: string | null) {
  if (!value || value === 'default') delete draft.value[kind][id]
  else draft.value[kind][id] = value
}
function addBinding(kind: 'accountBindings' | 'groupBindings') {
  const id = (kind === 'accountBindings' ? accountId.value : groupId.value).trim()
  const value = kind === 'accountBindings' ? accountPersona.value : groupPersona.value
  if (!/^\d+$/.test(id)) {
    message.warning('请输入有效的数字账号或群号')
    return
  }
  if (value === 'default') {
    message.warning('默认无需额外绑定，请选择一个人设')
    return
  }
  setBinding(kind, id, value)
  if (kind === 'accountBindings') accountId.value = ''
  else groupId.value = ''
}
async function save() {
  if (!dirty.value || saving.value || conflict.value || loading.value) return
  if (validation.value.length) {
    message.error(validation.value[0])
    return
  }
  const snapshot = clone(draft.value)
  saving.value = true
  error.value = ''
  saveRequest = new AbortController()
  try {
    await api('/api/persona/library', {
      method: 'PUT',
      body: JSON.stringify({ ...payload(snapshot), revision: view.value?.revision }),
      signal: saveRequest.signal
    })
    const next = await api<LibraryView>('/api/persona/library', { signal: saveRequest.signal })
    applyView(next, true, snapshot)
    conflict.value = false
    saved.value = '人设库与绑定已保存，立即热生效'
    message.success(dirty.value ? '已保存本次提交，后续编辑仍留在草稿中' : '人设库与绑定已保存')
  } catch (cause: any) {
    if (cause.name !== 'AbortError') {
      conflict.value = cause.status === 409
      error.value = cause.message || '保存失败，草稿已保留'
    }
  } finally {
    saving.value = false
  }
}
function discard() {
  dialog.warning({
    title: '放弃人设库和绑定修改？',
    content: '默认配置页有独立草稿，不会被这次操作清除。',
    positiveText: '放弃修改',
    negativeText: '继续编辑',
    onPositiveClick: () => {
      draft.value = clone(baseline.value)
      error.value = ''
      saved.value = ''
      ensureSelection()
    }
  })
}
onMounted(() => load())
onBeforeUnmount(() => {
  generation++
  request?.abort()
  saveRequest?.abort()
})
</script>

<template>
  <div ref="root" class="page-stack persona-page">
    <PageHeader
      title="人设"
      description="维护角色身份，按机器人账号、群聊与私聊建立绑定。"
      eyebrow="机器人能力"
      ><template #actions
        ><NButton secondary :disabled="loading || saving" @click="refresh">刷新人设库</NButton
        ><NButton type="primary" @click="addPersona"
          ><template #icon><Plus :size="16" /></template>新建人设</NButton
        ></template
      ></PageHeader
    >
    <PageState :loading="loading && !view" :error="!view ? error : ''" @retry="load()">
      <template v-if="view">
        <div class="panel persona-summary">
          <div>
            <strong>{{ draft.personas.length }} 套人设</strong
            ><span
              >{{ Object.keys(draft.accountBindings).length }} 个账号绑定 ·
              {{ Object.keys(draft.groupBindings).length }} 个群绑定</span
            >
          </div>
          <NTag :type="dirty ? 'warning' : 'success'" size="small" :bordered="false">{{
            dirty ? '有待保存修改' : '已同步'
          }}</NTag>
        </div>
        <NTabs :value="tab" type="line" @update:value="switchTab"
          ><NTab name="library">人设库</NTab><NTab name="bindings">账号与会话绑定</NTab
          ><NTab name="default">默认人设与画像</NTab></NTabs
        >
        <NAlert v-if="error" :type="conflict ? 'warning' : 'error'" :show-icon="false"
          >{{ error }}
          <div v-if="conflict" class="conflict-actions">
            <NButton size="small" @click="load(true)">刷新并保留草稿</NButton>
          </div></NAlert
        >
        <div v-show="tab === 'library'" class="persona-workspace">
          <aside class="persona-list panel" aria-label="人设列表">
            <NInput
              v-model:value="search"
              placeholder="搜索人设"
              clearable
              :input-props="{ 'aria-label': '搜索人设' }"
            /><button
              class="persona-option default-persona"
              type="button"
              @click="switchTab('default')"
            >
              <span class="persona-avatar"><UserRound :size="18" /></span
              ><span
                ><strong>{{ view.basePersona?.name || '全局默认人设' }}</strong
                ><small>所有人设的字段回退来源</small></span
              ></button
            ><button
              v-for="persona in filtered"
              :key="persona._clientId"
              class="persona-option"
              :class="{ selected: selectedId === persona._clientId }"
              type="button"
              :aria-pressed="selectedId === persona._clientId"
              @click="selectedId = persona._clientId"
            >
              <span class="persona-avatar">{{ persona.name?.slice(0, 1) || '?' }}</span
              ><span
                ><strong>{{ persona.name || '未命名人设' }}</strong
                ><small
                  >{{ bindingCount(persona.id) }} 个绑定{{
                    !equal(
                      persona,
                      baseline.personas.find((item) => item._clientId === persona._clientId)
                    )
                      ? ' · 草稿'
                      : ''
                  }}</small
                ></span
              >
            </button>
            <p v-if="!filtered.length" class="list-empty">
              {{ draft.personas.length ? '没有匹配的人设' : '还没有额外人设' }}
            </p>
          </aside>
          <section v-if="selected" class="panel persona-editor">
            <div class="panel-heading">
              <div>
                <h2>{{ selected.name || '未命名人设' }}</h2>
                <p>未自定义的字段会继承全局默认。自定义空值会覆盖默认内容。</p>
              </div>
              <NButton
                quaternary
                size="small"
                type="error"
                :aria-label="`删除人设${selected.name}`"
                @click="deletePersona(selected)"
                ><template #icon><Trash2 :size="16" /></template>删除</NButton
              >
            </div>
            <div class="form-field name-field">
              <label :for="`persona-${selected._clientId}-name`">人设名字</label
              ><NInput
                v-model:value="selected.name"
                :input-props="{ id: `persona-${selected._clientId}-name` }"
                placeholder="给这个角色起个名字"
              />
            </div>
            <div class="field-grid persona-fields">
              <div
                v-for="field in fields"
                :key="field.field"
                class="persona-field"
                :class="{ 'full-field': ['InputTextArea', 'GSubForm'].includes(field.component) }"
              >
                <div class="inherit-action">
                  <NButton
                    v-if="selected[field.field] !== undefined"
                    text
                    size="tiny"
                    @click="inherit(selected, field.field)"
                    >恢复继承</NButton
                  >
                </div>
                <SchemaField
                  v-if="selected[field.field] !== undefined"
                  :field="{ ...field, field: `${selected._clientId}-${field.field}` }"
                  :model-value="selected[field.field]"
                  @update:model-value="
                    (value) => {
                      if (selected) selected[field.field] = value
                    }
                  "
                />
                <div v-else class="inherited-field">
                  <label>{{ field.label }}</label>
                  <div>
                    <span>继承全局默认</span
                    ><NButton text size="small" @click="customize(selected, field)">自定义</NButton>
                  </div>
                </div>
              </div>
            </div>
            <NCollapse class="id-settings"
              ><NCollapseItem title="人设标识" name="id"
                ><div class="form-field">
                  <label :for="`persona-${selected._clientId}-id`">唯一标识</label
                  ><NInput
                    :value="selected.id"
                    :input-props="{ id: `persona-${selected._clientId}-id` }"
                    @update:value="
                      (value) => {
                        if (selected) renameId(selected, value)
                      }
                    "
                  /><span class="field-help"
                    >修改标识会同步调整本页已有绑定。标识不可为空、重复或使用 default。</span
                  >
                </div></NCollapseItem
              ></NCollapse
            >
          </section>
          <section v-else class="panel persona-empty">
            <UserRound :size="30" />
            <h2>创建一个有自己身份的人设</h2>
            <p>只需要填写名字，其余字段可以继承全局默认。</p>
            <NButton secondary @click="addPersona">新建人设</NButton>
          </section>
        </div>
        <div v-show="tab === 'bindings'" class="page-stack bindings-page">
          <div class="binding-priority panel">
            <h2>绑定生效顺序</h2>
            <div>
              <span>群绑定 / 私聊绑定</span><span class="priority-arrow">→</span
              ><span>账号默认</span><span class="priority-arrow">→</span><span>全局默认</span>
            </div>
            <p>
              没有显式会话绑定时使用账号人设。选择“使用全局默认”会解除该级绑定，再按剩余优先级回退。
            </p>
          </div>
          <NAlert v-if="accountError" type="warning" :show-icon="false">{{ accountError }}</NAlert>
          <section class="panel binding-panel">
            <div class="panel-heading">
              <h2>机器人账号</h2>
              <span class="muted">账号的默认身份</span>
            </div>
            <div v-for="account in accountRows" :key="account.qq" class="binding-row">
              <div>
                <strong
                  ><IdentityLabel kind="bot" :id="account.qq" :name="account.nickname" /></strong
                ><small
                  >{{ account.container || '手动配置的账号'
                  }}<span v-if="account.running !== undefined">
                    · {{ account.running ? '运行中' : '已停止' }}</span
                  ></small
                >
              </div>
              <NSelect
                :value="draft.accountBindings[account.qq] || 'default'"
                :options="options"
                :aria-label="`账号${botLabel(account.qq, account.nickname)}绑定人设`"
                @update:value="(value) => setBinding('accountBindings', account.qq, value)"
              /><NButton
                quaternary
                size="small"
                :disabled="!draft.accountBindings[account.qq]"
                @click="delete draft.accountBindings[account.qq]"
                >解除绑定</NButton
              >
            </div>
            <p v-if="!accountRows.length" class="muted">尚未发现账号，可在下面手动添加。</p>
            <div class="add-binding">
              <div class="binding-input">
                <NInput
                  v-model:value="accountId"
                  placeholder="机器人 QQ 号"
                  :input-props="{ 'aria-label': '新增绑定的机器人 QQ 号' }"
                /><IdentityLabel v-if="accountId.trim()" kind="bot" :id="accountId.trim()" />
              </div>
              <NSelect
                v-model:value="accountPersona"
                :options="options"
                aria-label="新增账号绑定的人设"
              /><NButton secondary @click="addBinding('accountBindings')">添加绑定</NButton>
            </div>
          </section>
          <section class="panel binding-panel">
            <div class="panel-heading">
              <h2>群聊绑定</h2>
              <span class="muted">群内优先使用指定人设</span>
            </div>
            <div v-for="(value, id) in draft.groupBindings" :key="id" class="binding-row">
              <div>
                <strong><IdentityLabel kind="group" :id="String(id)" /></strong><small>群聊</small>
              </div>
              <NSelect
                :value="value"
                :options="options"
                :aria-label="`群${groupLabel(String(id))}绑定人设`"
                @update:value="(next) => setBinding('groupBindings', String(id), next)"
              /><NButton quaternary size="small" @click="delete draft.groupBindings[id]"
                >解除绑定</NButton
              >
            </div>
            <p v-if="!Object.keys(draft.groupBindings).length" class="muted">
              还没有群绑定，群聊将使用账号默认人设。
            </p>
            <div class="add-binding">
              <div class="binding-input">
                <NInput
                  v-model:value="groupId"
                  placeholder="群号"
                  :input-props="{ 'aria-label': '新增绑定的群号' }"
                /><IdentityLabel v-if="groupId.trim()" kind="group" :id="groupId.trim()" />
              </div>
              <NSelect
                v-model:value="groupPersona"
                :options="options"
                aria-label="新增群绑定的人设"
              /><NButton secondary @click="addBinding('groupBindings')">添加绑定</NButton>
            </div>
          </section>
          <section class="panel binding-panel">
            <div class="panel-heading">
              <h2>私聊绑定</h2>
              <span class="muted">适用于所有私聊</span>
            </div>
            <div class="form-field private-binding">
              <label>所有私聊的优先人设</label
              ><NSelect
                :value="draft.privateBinding || 'default'"
                :options="options"
                aria-label="所有私聊的人设"
                @update:value="(value) => (draft.privateBinding = value === 'default' ? '' : value)"
              />
              <p class="field-help">
                显式私聊绑定优先于账号默认；未绑定时每个账号使用自己的默认人设。
              </p>
            </div>
          </section>
        </div>
        <div v-show="tab === 'default'">
          <SchemaPage v-if="defaultsOpened" kind="persona" embedded />
        </div>
        <p
          v-if="tab !== 'default' && dirty && validation.length"
          class="validation-note"
          role="status"
        >
          {{ validation[0] }}
        </p>
        <SaveBar
          v-if="tab !== 'default'"
          :dirty="dirty"
          :saving="saving"
          :disabled="!dirty || validation.length > 0 || conflict || loading"
          :saved="saved"
          @save="save"
          @discard="discard"
        />
      </template>
    </PageState>
  </div>
</template>

<style scoped>
.persona-page {
  max-width: 1180px;
}
.persona-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 22px;
}
.persona-summary > div {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.persona-summary strong {
  font-size: 14px;
}
.persona-summary span {
  color: var(--c-muted);
  font-size: 12px;
}
.persona-workspace {
  display: grid;
  grid-template-columns: 238px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.persona-list {
  padding: 14px;
  display: grid;
  gap: 8px;
}
.persona-option {
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  padding: 12px 9px;
  border-radius: 8px;
  color: inherit;
  display: flex;
  align-items: center;
  gap: 11px;
  cursor: pointer;
  text-align: left;
}
.persona-option:hover {
  background: rgba(100, 160, 220, 0.045);
}
.persona-option.selected {
  background: rgba(88, 150, 218, 0.09);
  border-color: rgba(95, 160, 229, 0.22);
}
.persona-option:focus-visible {
  outline: 2px solid var(--c-accent);
  outline-offset: 2px;
}
.persona-avatar {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  background: rgba(95, 160, 229, 0.08);
  color: var(--c-accent);
  border-radius: 9px;
  flex-shrink: 0;
  font-size: 13px;
}
.persona-option > span:last-child {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.persona-option strong {
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.persona-option small {
  font-size: 10px;
  color: var(--c-muted);
}
.default-persona {
  border-bottom: 1px solid var(--c-border);
  margin-bottom: 2px;
}
.list-empty {
  text-align: center;
  font-size: 12px;
  color: var(--c-muted);
  padding: 8px 0;
}
.persona-editor {
  padding: 24px;
  min-width: 0;
}
.persona-editor .panel-heading {
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 23px;
}
.panel-heading h2 {
  font-size: 15px;
  margin: 0;
}
.persona-editor .panel-heading p {
  color: var(--c-muted);
  font-size: 11px;
  line-height: 1.7;
  max-width: 420px;
  margin: 8px 0 0;
}
.name-field {
  max-width: 400px;
  margin-bottom: 23px;
}
.persona-fields {
  gap: 24px;
}
.persona-field {
  position: relative;
  min-width: 0;
}
.full-field {
  grid-column: 1 / -1;
}
.inherit-action {
  text-align: right;
  position: absolute;
  right: 0;
  top: -2px;
  font-size: 11px;
  z-index: 1;
}
.persona-field :deep(.field-label) {
  padding-right: 74px;
}
.inherited-field {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.inherited-field label {
  font-size: 13px;
  font-weight: 550;
}
.inherited-field > div {
  background: rgba(255, 255, 255, 0.015);
  border: 1px dashed var(--c-border);
  border-radius: 8px;
  padding: 9px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.inherited-field span {
  font-size: 12px;
  color: var(--c-muted);
}
.id-settings {
  margin-top: 26px;
  border-top: 1px solid var(--c-border);
  padding-top: 17px;
}
.persona-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 60px 20px;
  gap: 12px;
  color: var(--c-accent);
}
.persona-empty h2 {
  font-size: 16px;
  color: var(--c-text);
  margin: 8px 0 0;
}
.persona-empty p {
  font-size: 12px;
  color: var(--c-muted);
  max-width: 300px;
  line-height: 1.8;
  margin: 0 0 10px;
}
.binding-priority {
  padding: 22px;
}
.binding-priority h2 {
  font-size: 14px;
  margin: 0 0 16px;
}
.binding-priority > div {
  display: flex;
  align-items: center;
  gap: 13px;
  flex-wrap: wrap;
  font-size: 13px;
}
.priority-arrow {
  color: var(--c-accent);
}
.binding-priority p {
  color: var(--c-muted);
  font-size: 12px;
  line-height: 1.8;
  margin: 14px 0 0;
}
.binding-panel {
  padding: 24px;
}
.binding-panel .panel-heading {
  margin-bottom: 20px;
}
.binding-panel .muted {
  font-size: 11px;
}
.binding-row {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(160px, 1.3fr) auto;
  align-items: center;
  gap: 16px;
  padding: 13px 0;
  border-bottom: 1px solid var(--c-border);
}
.binding-row > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.binding-row strong {
  font-size: 13px;
}
.binding-row small {
  color: var(--c-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.binding-input {
  display: grid;
  gap: 6px;
  min-width: 0;
  align-content: start;
}
.add-binding {
  display: grid;
  grid-template-columns: 1fr 1.3fr auto;
  gap: 12px;
  padding-top: 20px;
}
.private-binding {
  max-width: 480px;
}
.private-binding p {
  margin: 0;
}
.validation-note {
  font-size: 12px;
  color: var(--c-danger);
  margin: 0;
}
.conflict-actions {
  margin-top: 12px;
}
@media (max-width: 1024px) {
  .persona-workspace {
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 15px;
  }
  .persona-editor {
    padding: 20px;
  }
}
@media (max-width: 736px) {
  .persona-workspace {
    grid-template-columns: 1fr;
  }
  .persona-list {
    display: flex;
    flex-wrap: wrap;
  }
  .persona-list :deep(.n-input) {
    flex-basis: 100%;
  }
  .persona-option {
    flex: 1 1 180px;
  }
  .default-persona {
    border-bottom: 0;
  }
  .persona-editor {
    padding: 18px 16px;
  }
  .persona-summary {
    padding: 16px;
  }
  .binding-panel,
  .binding-priority {
    padding: 18px 16px;
  }
  .binding-row {
    grid-template-columns: 1fr auto;
    gap: 12px;
  }
  .binding-row :deep(.n-select) {
    grid-row: 2;
    grid-column: 1 / -1;
  }
  .binding-input {
    display: grid;
    gap: 6px;
    min-width: 0;
    align-content: start;
  }
  .add-binding {
    grid-template-columns: 1fr;
  }
  .persona-empty {
    padding: 35px 16px;
  }
}
</style>
