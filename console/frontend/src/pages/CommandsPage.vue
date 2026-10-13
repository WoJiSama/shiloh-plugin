<script setup lang="ts">
import { clientId } from '../lib/clientId'
import { computed, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NInputNumber, NSelect, NTag, useDialog } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import SaveBar from '../components/SaveBar.vue'
import DiceSettings from '../components/DiceSettings.vue'
import DiceAssets from '../components/DiceAssets.vue'
import EmojiManager from '../components/EmojiManager.vue'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import { useOpsResource, errorText } from '../lib/operations'
import { commandsApi, clone, changes, type CommandDomain } from '../lib/commands'

const dialog = useDialog()
const tab = ref('registry')
const tabs = [
  { id: 'registry', label: '命令总表' },
  { id: 'dice', label: '骰子回复' },
  { id: 'assets', label: '牌堆与规则' },
  { id: 'emoji', label: '表情包' }
]
const resource = useOpsResource((signal) =>
  commandsApi<{ domains: CommandDomain[]; commandCount: number; loadError?: string }>('data', {
    signal
  })
)
const domains = ref<CommandDomain[]>([])
const baseline = ref<CommandDomain[]>([])
const activeIndex = ref(0)
const query = ref('')
const saving = ref(false)
const exporting = ref(false)
const error = ref('')
const saved = ref('')
const dirty = computed(() => changes(domains.value, baseline.value))
const current = computed(() => domains.value[activeIndex.value])
const visibleCommands = computed(() =>
  (current.value?.commands || [])
    .map((command, index) => ({ command, index }))
    .filter(
      ({ command }) =>
        !query.value.trim() ||
        `${command.usage} ${command.desc} ${command.src}`
          .toLowerCase()
          .includes(query.value.trim().toLowerCase())
    )
)
const commandCount = computed(() =>
  domains.value.reduce((total, domain) => total + domain.commands.length, 0)
)
const permOptions = [
  { label: '所有人', value: 'all' },
  { label: '群管理', value: 'admin' },
  { label: '仅主人', value: 'master' }
]
let active = true
onUnmounted(() => {
  active = false
})
useUnsavedGuard(() => dirty.value > 0 || saving.value)
watch(resource.data, (data) => {
  if (!data || dirty.value || saving.value) return
  domains.value = clone(data.domains || [])
  baseline.value = clone(domains.value)
  activeIndex.value = Math.min(activeIndex.value, Math.max(domains.value.length - 1, 0))
})
function reload() {
  if (dirty.value)
    dialog.warning({
      title: '重新加载命令表',
      content: '重新加载将放弃命令表里尚未保存的修改。',
      positiveText: '放弃并重新加载',
      negativeText: '继续编辑',
      onPositiveClick: () => {
        domains.value = clone(baseline.value)
        void resource.refresh()
      }
    })
  else void resource.refresh()
}
function selectDomain(index: number) {
  activeIndex.value = index
  query.value = ''
}
function addCommand() {
  current.value?.commands.push({ usage: '', desc: '', perm: 'all', src: '' })
  query.value = ''
}
function addDomain() {
  if (domains.value.length >= 50) {
    error.value = '最多创建 50 个命令模块。'
    return
  }
  const key = `module_${clientId()}`
  domains.value.push({
    key,
    name: '新模块',
    icon: '',
    desc: '',
    order: domains.value.length + 1,
    commands: [{ usage: '.新命令', desc: '', perm: 'all', src: '' }]
  })
  activeIndex.value = domains.value.length - 1
}
function removeDomain() {
  if (!current.value) return
  const index = activeIndex.value
  const name = current.value.name
  dialog.warning({
    title: `移除模块「${name}」`,
    content: '模块及其命令将从命令总表移除，保存后生效。',
    positiveText: '移除模块',
    negativeText: '取消',
    onPositiveClick: () => {
      if (!active || saving.value) return
      domains.value.splice(index, 1)
      activeIndex.value = Math.min(index, Math.max(domains.value.length - 1, 0))
    }
  })
}
function discard() {
  dialog.warning({
    title: '放弃命令表修改',
    content: '恢复到最近加载或保存的版本。',
    positiveText: '放弃修改',
    negativeText: '继续编辑',
    onPositiveClick: () => {
      domains.value = clone(baseline.value)
      error.value = ''
      activeIndex.value = Math.min(activeIndex.value, Math.max(domains.value.length - 1, 0))
    }
  })
}
function validate(): string {
  if (!domains.value.length) return '至少保留一个命令模块。'
  const keys = new Set<string>()
  for (const domain of domains.value) {
    if (!/^[\w-]{1,32}$/.test(domain.key))
      return `模块「${domain.name}」的标识需为 1–32 位字母、数字、下划线或连字符。`
    if (keys.has(domain.key)) return `模块标识重复：${domain.key}`
    keys.add(domain.key)
    if (!domain.name.trim()) return `模块 ${domain.key} 缺少名称。`
    if (!domain.commands.length)
      return `模块「${domain.name}」至少需要一条命令，以免保存后被读取器忽略。`
    if (domain.commands.some((command) => !command.usage.trim()))
      return `模块「${domain.name}」存在未填写用法的命令。`
  }
  return commandCount.value > 500 ? '命令总数最多为 500 条。' : ''
}
async function save() {
  if (saving.value) return
  error.value = validate()
  if (error.value) return
  const snapshot = clone(domains.value)
  saving.value = true
  try {
    const result = await commandsApi<{ commandCount: number; docPath: string }>('save', {
      method: 'POST',
      body: JSON.stringify({ domains: snapshot })
    })
    if (!active) return
    baseline.value = snapshot
    saved.value = `已保存 ${result.commandCount} 条命令，并生成 ${result.docPath} · ${new Date().toLocaleTimeString('zh-CN')}`
  } catch (cause) {
    if (active) error.value = errorText(cause)
  } finally {
    if (active) saving.value = false
  }
}
async function exportDoc() {
  if (exporting.value) return
  exporting.value = true
  error.value = ''
  try {
    const result = await commandsApi<{ docPath: string }>('export', { method: 'POST', body: '{}' })
    if (active) saved.value = `已导出服务器上的已保存命令表：${result.docPath}`
  } catch (cause) {
    if (active) error.value = errorText(cause)
  } finally {
    if (active) exporting.value = false
  }
}
</script>

<template>
  <div class="page-stack">
    <PageHeader
      title="命令与骰子"
      eyebrow="机器人能力"
      description="维护命令说明与权限标记，配置骰子回复，管理牌堆、规则包与表情素材。"
      ><template #actions
        ><NButton v-if="tab === 'registry'" :loading="exporting" @click="exportDoc"
          >导出已保存文档</NButton
        ><NButton
          v-if="tab === 'registry'"
          :loading="resource.loading.value"
          :disabled="saving"
          @click="reload"
          >重新加载</NButton
        ></template
      ></PageHeader
    >
    <nav class="task-tabs" aria-label="命令与骰子任务分区">
      <button
        v-for="item in tabs"
        :key="item.id"
        :aria-selected="tab === item.id"
        @click="tab = item.id"
      >
        {{ item.label
        }}<NTag v-if="item.id === 'registry' && dirty" type="warning" size="small">{{
          dirty
        }}</NTag>
      </button>
    </nav>
    <div v-show="tab === 'registry'" class="page-stack">
      <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert>
      <NAlert v-if="resource.data.value?.loadError" type="warning" :bordered="false"
        >后端命令配置读取异常：{{ resource.data.value.loadError }}</NAlert
      >
      <PageState
        :loading="resource.loading.value && !resource.data.value"
        :error="!resource.data.value ? resource.error.value : null"
        @retry="resource.refresh"
      >
        <NAlert v-if="resource.error.value && resource.data.value" type="warning" :bordered="false"
          >加载失败，当前修改仍保留：{{ resource.error.value }}</NAlert
        >
        <div class="command-workspace">
          <aside class="panel domain-navigation">
            <div class="domain-nav-heading">
              <strong>模块</strong
              ><span class="muted">{{ domains.length }} 个 · {{ commandCount }} 条</span>
            </div>
            <button
              v-for="(domain, index) in domains"
              :key="index"
              class="domain-item"
              :class="{ selected: activeIndex === index }"
              @click="selectDomain(index)"
            >
              <span>{{ domain.icon }} {{ domain.name }}</span
              ><small>{{ domain.commands.length }}</small></button
            ><NButton block dashed :disabled="saving" @click="addDomain">添加模块</NButton>
          </aside>
          <section class="panel command-editor">
            <template v-if="current"
              ><div class="panel-heading">
                <h2 class="section-title">{{ current.name }}</h2>
                <NButton
                  size="small"
                  quaternary
                  type="error"
                  :disabled="saving"
                  @click="removeDomain"
                  >移除模块</NButton
                >
              </div>
              <div class="field-grid module-fields">
                <div class="form-field">
                  <label>模块名称</label
                  ><NInput
                    v-model:value="current.name"
                    :maxlength="50"
                    :disabled="saving"
                    aria-label="模块名称"
                  />
                </div>
                <div class="form-field">
                  <label>模块标识</label
                  ><NInput
                    v-model:value="current.key"
                    :maxlength="32"
                    :disabled="saving"
                    aria-label="模块标识"
                  /><span class="field-help">发送「.命令 标识」查看本模块。</span>
                </div>
                <div class="form-field">
                  <label>模块图标</label
                  ><NInput
                    v-model:value="current.icon"
                    :maxlength="4"
                    :disabled="saving"
                    aria-label="模块图标"
                  />
                </div>
                <div class="form-field">
                  <label>展示顺序</label
                  ><NInputNumber
                    v-model:value="current.order"
                    :precision="0"
                    :disabled="saving"
                    aria-label="模块展示顺序"
                  />
                </div>
                <div class="form-field module-description">
                  <label>模块说明</label
                  ><NInput
                    v-model:value="current.desc"
                    :maxlength="200"
                    :disabled="saving"
                    aria-label="模块说明"
                  />
                </div>
              </div>
              <div class="command-list-heading">
                <h3 class="section-title">命令列表</h3>
                <NButton size="small" secondary :disabled="saving" @click="addCommand"
                  >添加命令</NButton
                >
              </div>
              <NInput
                v-model:value="query"
                clearable
                placeholder="搜索本模块的用法、说明或实现位置"
                aria-label="搜索命令" />
              <p class="field-help permission-note">
                权限字段用于命令总表的展示说明。命令实际鉴权由对应实现处理。
              </p>
              <p v-if="!visibleCommands.length" class="empty-command muted">暂无匹配命令。</p>
              <div v-for="{ command, index } in visibleCommands" :key="index" class="command-row">
                <div class="command-row-heading">
                  <span class="muted">{{ String(index + 1).padStart(2, '0') }}</span
                  ><NButton
                    size="tiny"
                    quaternary
                    type="error"
                    :disabled="saving"
                    @click="current.commands.splice(index, 1)"
                    >删除</NButton
                  >
                </div>
                <div class="field-grid">
                  <div class="form-field">
                    <label>命令用法</label
                    ><NInput
                      v-model:value="command.usage"
                      :maxlength="200"
                      :disabled="saving"
                      placeholder="例如 .draw <牌组>"
                      :aria-label="`第 ${index + 1} 条命令用法`"
                    />
                  </div>
                  <div class="form-field">
                    <label>权限标记</label
                    ><NSelect
                      v-model:value="command.perm"
                      :options="permOptions"
                      :disabled="saving"
                      :aria-label="`第 ${index + 1} 条命令权限`"
                    />
                  </div>
                  <div class="form-field">
                    <label>命令说明</label
                    ><NInput
                      v-model:value="command.desc"
                      type="textarea"
                      :autosize="{ minRows: 1, maxRows: 3 }"
                      :maxlength="300"
                      :disabled="saving"
                      :aria-label="`第 ${index + 1} 条命令说明`"
                    />
                  </div>
                  <div class="form-field">
                    <label>实现位置</label
                    ><NInput
                      v-model:value="command.src"
                      :maxlength="200"
                      :disabled="saving"
                      :aria-label="`第 ${index + 1} 条命令实现位置`"
                    />
                  </div>
                </div></div
            ></template>
            <p v-else class="muted">添加模块以维护命令总表。</p>
          </section>
        </div>
        <SaveBar :dirty="dirty" :saving="saving" :saved="saved" @save="save" @discard="discard" />
      </PageState>
    </div>
    <DiceSettings v-show="tab === 'dice'" />
    <DiceAssets v-show="tab === 'assets'" />
    <EmojiManager v-show="tab === 'emoji'" />
  </div>
</template>

<style scoped>
.task-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--c-border);
  padding-bottom: 12px;
}
.task-tabs button {
  display: flex;
  gap: 9px;
  align-items: center;
  background: transparent;
  color: var(--c-muted);
  border: 0;
  border-radius: 7px;
  padding: 8px 14px;
  font-size: 13px;
}
.task-tabs button[aria-selected='true'] {
  color: var(--c-accent);
  background: var(--c-selected);
}
.command-workspace {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.domain-navigation {
  padding: 16px;
  position: sticky;
  top: 84px;
}
.domain-nav-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  margin: 3px 0 14px;
}
.domain-nav-heading .muted {
  font-size: 10px;
}
.domain-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--c-muted);
  border-radius: 7px;
  padding: 11px 10px;
  text-align: left;
  font-size: 13px;
}
.domain-item small {
  font-size: 11px;
}
.domain-item.selected {
  background: var(--c-selected);
  color: var(--c-accent);
}
.domain-navigation > .n-button {
  margin-top: 14px;
}
.module-description {
  grid-column: 1/-1;
}
.module-fields {
  padding-bottom: 22px;
  border-bottom: 1px solid var(--c-border);
}
.command-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 24px 0 14px;
}
.command-list-heading .section-title {
  margin: 0;
}
.command-row {
  padding: 20px 0;
  border-bottom: 1px solid var(--c-border);
}
.command-row:last-child {
  border-bottom: 0;
}
.command-row-heading {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.command-row .form-field > label {
  font-size: 12px;
  color: var(--c-muted);
}
.permission-note {
  margin-top: 12px;
}
.empty-command {
  padding: 30px 0;
}
@media (max-width: 850px) {
  .command-workspace {
    grid-template-columns: 1fr;
  }
  .domain-navigation {
    position: static;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .domain-nav-heading {
    width: 100%;
  }
  .domain-item {
    width: auto;
    flex: 1 1 auto;
  }
  .domain-navigation > .n-button {
    width: auto;
    margin: 0;
  }
}
</style>
