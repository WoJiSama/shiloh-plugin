<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { NAlert, NButton, NInput, NModal, NSelect, NTag, useDialog } from 'naive-ui'
import PageState from './PageState.vue'
import { commandsApi, uploadFileName, type DiceData } from '../lib/commands'
import { useOpsResource, errorText } from '../lib/operations'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
const dialog = useDialog()
const data = useOpsResource((signal) => commandsApi<DiceData>('dice-data', { signal }))
const filter = ref('')
const decks = computed(() =>
  (data.data.value?.decks || []).filter((deck) =>
    `${deck.name} ${deck.fileName} ${deck.keys.join(' ')}`
      .toLowerCase()
      .includes(filter.value.toLowerCase())
  )
)
const packs = computed(() =>
  (data.data.value?.packs || []).filter((pack) =>
    `${pack.id} ${pack.name} ${pack.commands.join(' ')}`
      .toLowerCase()
      .includes(filter.value.toLowerCase())
  )
)
const error = ref('')
const success = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const uploadKind = ref('auto')
const fileName = ref('')
const importText = ref('')
const importing = ref(false)
const deleting = ref(false)
const confirming = ref('')
interface ImportResult {
  ok: boolean
  kind: 'deck' | 'rule'
  deckName?: string
  replaced?: boolean
  visibleCount?: number
  packId?: string
  packName?: string
  stageId?: string
  report?: string
  staged?: boolean
}
interface ImportFile {
  name: string
  source: string
  result?: ImportResult
  error?: string
  done?: boolean
  superseded?: boolean
}
const files = ref<ImportFile[]>([])
const editorOpen = ref(false)
const editorKind = ref<'deck' | 'seal'>('deck')
const editorId = ref('')
const source = ref('')
const sourceBaseline = ref('')
const sourceLoading = ref(false)
const sourceSaving = ref(false)
const sourceError = ref('')
const sourceSuccess = ref('')
const sourceDirty = computed(() => source.value !== sourceBaseline.value)
const kindOptions = [
  { label: '自动识别', value: 'auto' },
  { label: '牌堆', value: 'deck' },
  { label: '规则包 / JS 扩展', value: 'rule' }
]
let active = true
let editorSequence = 0
let editorController: AbortController | null = null
onUnmounted(() => {
  active = false
  editorController?.abort()
  ++editorSequence
})
useUnsavedGuard(
  () =>
    sourceDirty.value ||
    !!importText.value.trim() ||
    files.value.some((file) => !file.done || file.result?.staged) ||
    importing.value ||
    sourceSaving.value
)
async function readFiles(list: FileList | File[] | null) {
  if (!list || importing.value) return
  error.value = ''
  for (const file of Array.from(list)) {
    if (file.size > 4 * 1024 * 1024) {
      error.value = `${file.name} 超过 4MB，未加入导入队列。`
      continue
    }
    const name = uploadFileName(file.name)
    if (!name) {
      error.value = `${file.name} 文件名无效。仅支持 JSON、YAML 或 JavaScript，名称不能含路径或 /\\:*?"<>|，主文件名最多 81 字。`
      continue
    }
    const text = await file.text()
    if (!active) return
    files.value.push({ name, source: text })
  }
  if (fileInput.value) fileInput.value.value = ''
}
function queueText() {
  if (!fileName.value.trim() || !importText.value.trim()) {
    error.value = '粘贴导入需要填写文件名与文件内容。'
    return
  }
  const name = uploadFileName(fileName.value)
  if (!name) {
    error.value =
      '文件名需以 .json、.yaml、.yml、.js、.cjs 或 .mjs 结尾，不能含路径或 /\\:*?"<>|，主文件名最多 81 字。'
    return
  }
  if (new Blob([importText.value]).size > 4 * 1024 * 1024) {
    error.value = '文件内容超过 4MB。'
    return
  }
  files.value.push({ name, source: importText.value })
  fileName.value = ''
  importText.value = ''
  error.value = ''
}
async function runImports() {
  if (importing.value || !files.value.some((file) => !file.done)) return
  const replacements = files.value
    .filter(
      (file) => !file.done && data.data.value?.decks.some((deck) => deck.fileName === file.name)
    )
    .map((file) => file.name)
  if (replacements.length)
    dialog.warning({
      title: '替换已有牌堆文件',
      content: `将替换：${replacements.join('、')}。原文件内容将被覆盖，导入后立即热生效。`,
      positiveText: '确认替换并导入',
      negativeText: '取消',
      onPositiveClick: () => importFiles()
    })
  else await importFiles()
}
async function importFiles() {
  if (importing.value || !active) return
  importing.value = true
  error.value = ''
  success.value = ''
  const snapshot = files.value.filter((file) => !file.done)
  const kind = uploadKind.value
  try {
    for (const file of snapshot) {
      if (!active) break
      try {
        const result = await commandsApi<ImportResult>(
          `upload?fileName=${encodeURIComponent(file.name)}&kind=${encodeURIComponent(kind)}`,
          { method: 'POST', headers: { 'content-type': 'text/x-shiloh-upload' }, body: file.source }
        )
        if (!active) break
        if (result.kind === 'rule' && result.staged && result.packId)
          for (const earlier of files.value) {
            if (
              earlier !== file &&
              earlier.result?.packId === result.packId &&
              earlier.result.staged
            ) {
              earlier.result.staged = false
              earlier.superseded = true
              earlier.error = `同一规则包 ${result.packId} 的暂存已被「${file.name}」的新预检替换，请只确认最新报告。`
            }
          }
        file.result = result
        file.done = true
        file.superseded = false
        file.error = result.ok ? '' : result.report || '导入预检未通过。'
        if (result.staged && !result.stageId)
          file.error = '预检响应缺少暂存版本标识，不能安全确认导入。请更新服务并重新预检。'
      } catch (cause) {
        if (active) file.error = errorText(cause)
      }
    }
    if (active) await data.refresh()
  } finally {
    if (active) importing.value = false
  }
}
function confirmRule(file: ImportFile) {
  if (
    !file.result?.staged ||
    !file.result.packId ||
    !file.result.stageId ||
    file.superseded ||
    confirming.value ||
    importing.value
  )
    return
  const packId = file.result.packId
  const stageId = file.result.stageId
  const pendingResult = file.result
  dialog.warning({
    title: `确认导入 ${file.result.packName || packId}`,
    content: '请先检查下方预检报告。确认后规则包会写入规则库，启用范围由群内规则管理命令控制。',
    positiveText: '确认导入',
    negativeText: '取消',
    onPositiveClick: async () => {
      if (
        !active ||
        confirming.value ||
        importing.value ||
        !file.result?.staged ||
        file.superseded ||
        file.result !== pendingResult ||
        file.result.packId !== packId ||
        file.result.stageId !== stageId
      )
        return false
      confirming.value = packId
      file.error = ''
      try {
        const result = await commandsApi<{ message: string }>('rule-confirm', {
          method: 'POST',
          body: JSON.stringify({ id: packId, stageId })
        })
        if (!active) return
        file.result!.staged = false
        success.value = `已导入 ${result.message}。在目标群使用「.骰规则启用 ${packId}」启用。`
        await data.refresh()
      } catch (cause) {
        if (active) file.error = errorText(cause)
      } finally {
        if (active) confirming.value = ''
      }
    }
  })
}
function deleteDeck(name: string) {
  if (deleting.value) return
  dialog.warning({
    title: `删除牌堆 ${name}`,
    content: '这会删除牌堆文件并立即热重载，删除后无法通过本页面恢复。',
    positiveText: '删除牌堆',
    negativeText: '取消',
    onPositiveClick: async () => {
      if (!active || deleting.value) return
      deleting.value = true
      error.value = ''
      success.value = ''
      try {
        await commandsApi('deck-delete', {
          method: 'POST',
          body: JSON.stringify({ fileName: name })
        })
        if (!active) return
        success.value = `已删除 ${name}`
        await data.refresh()
      } catch (cause) {
        if (active) error.value = errorText(cause)
      } finally {
        if (active) deleting.value = false
      }
    }
  })
}
async function openEditor(kind: 'deck' | 'seal', id: string) {
  if (sourceDirty.value || sourceSaving.value) {
    error.value = '请先保存或关闭当前源码编辑器，再打开其他文件。'
    return
  }
  editorController?.abort()
  const ticket = ++editorSequence
  editorController = new AbortController()
  editorKind.value = kind
  editorId.value = id
  editorOpen.value = true
  source.value = ''
  sourceBaseline.value = ''
  sourceError.value = ''
  sourceSuccess.value = ''
  sourceLoading.value = true
  try {
    const result = await commandsApi<{ source: string }>(
      `${kind === 'deck' ? 'deck-source' : 'seal-source'}/${encodeURIComponent(id)}`,
      { signal: editorController.signal }
    )
    if (active && ticket === editorSequence) source.value = sourceBaseline.value = result.source
  } catch (cause) {
    if (active && ticket === editorSequence && !editorController.signal.aborted)
      sourceError.value = errorText(cause)
  } finally {
    if (active && ticket === editorSequence) sourceLoading.value = false
  }
}
function closeEditor() {
  if (sourceSaving.value) return
  const close = () => {
    editorOpen.value = false
    source.value = sourceBaseline.value
    editorController?.abort()
    ++editorSequence
  }
  if (sourceDirty.value)
    dialog.warning({
      title: '源码尚未保存',
      content: '关闭会放弃当前源码修改。',
      positiveText: '放弃并关闭',
      negativeText: '继续编辑',
      onPositiveClick: close
    })
  else close()
}
async function saveSource() {
  if (sourceSaving.value || !source.value.trim()) return
  const snapshot = source.value
  const kind = editorKind.value
  const id = editorId.value
  sourceSaving.value = true
  sourceError.value = ''
  sourceSuccess.value = ''
  try {
    await commandsApi(
      `${kind === 'deck' ? 'deck-source' : 'seal-source'}/${encodeURIComponent(id)}`,
      kind === 'deck'
        ? { method: 'POST', headers: { 'content-type': 'text/x-shiloh-upload' }, body: snapshot }
        : { method: 'POST', body: JSON.stringify({ source: snapshot }) }
    )
    if (!active) return
    sourceBaseline.value = snapshot
    sourceSuccess.value =
      kind === 'deck'
        ? '牌堆源码已保存并热重载。'
        : '扩展源码已通过校验并保存，下次命令使用新版本。'
    await data.refresh()
  } catch (cause) {
    if (active) sourceError.value = errorText(cause)
  } finally {
    if (active) sourceSaving.value = false
  }
}
</script>

<template>
  <div class="page-stack">
    <div class="asset-heading">
      <div>
        <h2 class="section-title">牌堆与规则库</h2>
        <p class="field-help">导入素材、查看规则版本，直接编辑牌堆与海豹 JavaScript 扩展源码。</p>
      </div>
      <NButton :loading="data.loading.value" @click="data.refresh">刷新列表</NButton>
    </div>
    <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert
    ><NAlert v-if="success" type="success" :bordered="false">{{ success }}</NAlert>
    <section
      class="panel import-panel"
      @dragover.prevent
      @drop.prevent="readFiles(Array.from($event.dataTransfer?.files || []))"
    >
      <div class="panel-heading">
        <div>
          <h3 class="section-title">导入文件</h3>
          <p class="field-help">
            拖放或选择 JSON、YAML、JS 文件，单文件最多 4MB。规则包预检后需要确认导入。
          </p>
        </div>
        <NButton :disabled="importing || !!confirming" @click="fileInput?.click()"
          >选择文件</NButton
        >
      </div>
      <input
        ref="fileInput"
        type="file"
        multiple
        accept=".json,.yaml,.yml,.js,.cjs,.mjs"
        hidden
        @change="readFiles(($event.target as HTMLInputElement).files)"
      />
      <div class="import-controls">
        <NSelect
          v-model:value="uploadKind"
          :options="kindOptions"
          :disabled="importing"
          aria-label="导入类型"
        /><NButton
          type="primary"
          :loading="importing"
          :disabled="!!confirming || !files.some((file) => !file.done)"
          @click="runImports"
          >导入待处理文件</NButton
        ><NButton v-if="files.length" :disabled="importing || !!confirming" @click="files = []"
          >清空队列</NButton
        >
      </div>
      <details class="paste-import">
        <summary>粘贴文件内容导入</summary>
        <div class="page-stack">
          <div class="form-field">
            <label for="import-file-name">文件名（含扩展名）</label
            ><NInput
              v-model:value="fileName"
              :input-props="{ id: 'import-file-name' }"
              placeholder="例如 my-deck.json"
              :disabled="importing"
            />
          </div>
          <div class="form-field">
            <label for="import-file-text">文件内容</label
            ><NInput
              v-model:value="importText"
              :input-props="{ id: 'import-file-text' }"
              type="textarea"
              :autosize="{ minRows: 5, maxRows: 12 }"
              :disabled="importing"
            />
          </div>
          <NButton secondary :disabled="importing" @click="queueText">加入导入队列</NButton>
        </div>
      </details>
      <div v-for="(file, index) in files" :key="index" class="import-receipt">
        <div class="receipt-heading">
          <strong>{{ file.name }}</strong
          ><NTag :type="file.error ? 'error' : file.done ? 'success' : 'default'" size="small">{{
            file.error
              ? '需要处理'
              : file.result?.staged
                ? '待确认'
                : file.done
                  ? '已处理'
                  : '待导入'
          }}</NTag
          ><NButton
            v-if="!file.done"
            size="tiny"
            quaternary
            :disabled="importing"
            @click="files.splice(index, 1)"
            >移除</NButton
          >
        </div>
        <NAlert v-if="file.error" type="error" :bordered="false">{{ file.error }}</NAlert>
        <p v-if="file.result?.kind === 'deck'" class="field-help">
          牌堆「{{ file.result.deckName }}」{{ file.result.replaced ? '已更新' : '已导入' }}，{{
            file.result.visibleCount
          }}
          个牌组，已热生效。
        </p>
        <pre v-if="file.result?.report" class="import-report">{{ file.result.report }}</pre>
        <NButton
          v-if="file.result?.staged"
          size="small"
          type="primary"
          :loading="confirming === file.result.packId"
          :disabled="
            importing || !file.result.stageId || (!!confirming && confirming !== file.result.packId)
          "
          @click="confirmRule(file)"
          >确认导入 {{ file.result.packName || file.result.packId }}</NButton
        >
      </div>
    </section>
    <NInput
      v-model:value="filter"
      clearable
      placeholder="搜索牌堆、规则包或命令"
      aria-label="搜索牌堆与规则"
    />
    <PageState
      :loading="data.loading.value && !data.data.value"
      :error="!data.data.value ? data.error.value : null"
      @retry="data.refresh"
      ><NAlert v-if="data.data.value?.deckError" type="warning" :bordered="false"
        >牌堆读取提示：{{ data.data.value.deckError }}</NAlert
      >
      <section class="page-stack">
        <h3 class="section-title">
          牌堆 <span class="muted">· {{ decks.length }}</span>
        </h3>
        <p v-if="!decks.length" class="panel muted">
          暂无匹配牌堆，导入 JSON 或 YAML 文件即可使用。
        </p>
        <div class="asset-grid">
          <article v-for="deck in decks" :key="deck.fileName" class="panel asset-card">
            <h3>{{ deck.name }}</h3>
            <p class="asset-file muted">{{ deck.fileName }}</p>
            <div class="asset-meta">
              <span>{{ deck.visibleCount }} 个牌组</span><span>{{ deck.entryCount }} 条内容</span
              ><span v-if="deck.author">{{ deck.author }}</span
              ><span v-if="deck.version">{{ deck.version }}</span>
            </div>
            <div class="asset-keys">
              <NTag
                v-for="key in deck.keys.slice(0, 12)"
                :key="key"
                size="small"
                :bordered="false"
                >{{ key }}</NTag
              ><span v-if="deck.keys.length > 12" class="muted">…</span>
            </div>
            <div class="asset-actions">
              <NButton size="small" secondary @click="openEditor('deck', deck.fileName)"
                >编辑源码</NButton
              ><NButton
                size="small"
                quaternary
                type="error"
                :disabled="deleting"
                @click="deleteDeck(deck.fileName)"
                >删除牌堆</NButton
              >
            </div>
          </article>
        </div>
      </section>
      <section class="page-stack rules-section">
        <h3 class="section-title">
          规则包与扩展 <span class="muted">· {{ packs.length }}</span>
        </h3>
        <p class="field-help">
          通过群内「.骰规则启用 / 禁用 &lt;包名&gt;」管理启用范围。在线源码编辑适用于海豹 JavaScript
          扩展。
        </p>
        <p v-if="!packs.length" class="panel muted">暂无匹配规则包，导入后可查看版本与启用情况。</p>
        <div class="asset-grid">
          <article v-for="pack in packs" :key="pack.id" class="panel asset-card">
            <h3>{{ pack.name }}</h3>
            <p class="asset-file muted">{{ pack.id }}</p>
            <div class="asset-meta">
              <span>版本 {{ pack.versions.join(' / ') || '—' }}</span
              ><span>{{ pack.enabledGroups || 0 }} 个启用群</span>
            </div>
            <div class="asset-keys">
              <NTag
                v-for="command in pack.commands"
                :key="command"
                size="small"
                :bordered="false"
                >{{ command }}</NTag
              >
            </div>
            <div class="asset-actions">
              <NButton size="small" secondary @click="openEditor('seal', pack.id)"
                >编辑扩展源码</NButton
              >
            </div>
          </article>
        </div>
      </section></PageState
    >
    <NModal
      :show="editorOpen"
      preset="card"
      class="source-modal"
      :title="`${editorKind === 'deck' ? '牌堆' : '扩展'}源码 · ${editorId}`"
      :closable="!sourceSaving"
      :mask-closable="!sourceSaving"
      :close-on-esc="!sourceSaving"
      @update:show="closeEditor"
      ><div class="page-stack">
        <NAlert v-if="sourceError" type="error" :bordered="false">{{ sourceError }}</NAlert
        ><NAlert v-if="sourceSuccess" type="success" :bordered="false">{{ sourceSuccess }}</NAlert>
        <p class="field-help">
          保存时后端会校验格式。{{
            editorKind === 'deck' ? '牌堆保存后立即热重载。' : '仅海豹扩展支持在线源码编辑。'
          }}
        </p>
        <PageState :loading="sourceLoading"
          ><NInput
            v-model:value="source"
            type="textarea"
            :autosize="{ minRows: 16, maxRows: 26 }"
            :disabled="sourceSaving || (!!sourceError && !sourceBaseline)"
            :input-props="{ 'aria-label': '文件源码', spellcheck: false }"
            class="source-input"
        /></PageState>
        <div class="source-actions">
          <span class="field-help">{{ sourceDirty ? '有未保存修改' : '内容已同步' }}</span
          ><NButton :disabled="sourceSaving" @click="closeEditor">关闭</NButton
          ><NButton
            type="primary"
            :loading="sourceSaving"
            :disabled="!sourceDirty || !source.trim() || sourceLoading"
            @click="saveSource"
            >保存源码</NButton
          >
        </div>
      </div></NModal
    >
  </div>
</template>

<style scoped>
.asset-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.asset-heading .section-title {
  margin-bottom: 6px;
}
.import-controls {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.import-controls > .n-select {
  width: 190px;
}
.paste-import {
  margin-top: 20px;
}
.paste-import summary {
  cursor: pointer;
  color: var(--c-muted);
  font-size: 12px;
}
.paste-import > .page-stack {
  margin-top: 20px;
}
.paste-import .n-button {
  align-self: flex-end;
}
.import-receipt {
  padding: 16px 0;
  border-top: 1px solid var(--c-border);
  margin-top: 16px;
}
.receipt-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  font-size: 13px;
}
.receipt-heading > strong {
  overflow-wrap: anywhere;
}
.import-report {
  font-size: 12px;
  padding: 12px;
  background: var(--c-soft);
  border-radius: 8px;
  max-height: 230px;
  overflow: auto;
  margin: 12px 0;
}
.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(310px, 100%), 1fr));
  gap: 18px;
}
.asset-card h3 {
  font-size: 16px;
  font-weight: 600;
}
.asset-file {
  font-size: 11px;
  margin-top: 5px;
  overflow-wrap: anywhere;
}
.asset-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--c-muted);
  margin: 16px 0;
}
.asset-keys {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.asset-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  border-top: 1px solid var(--c-border);
  padding-top: 16px;
  margin-top: 20px;
}
.rules-section {
  margin-top: 30px;
}
.source-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.source-actions > span {
  flex: 1;
}
.source-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
}
:global(.source-modal) {
  width: min(960px, calc(100vw - 28px));
}
.page-stack > .section-title {
  margin: 0;
}
@media (max-width: 500px) {
  .import-controls > .n-select {
    width: 100%;
  }
}
</style>
