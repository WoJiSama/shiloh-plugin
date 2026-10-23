<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue'
import {
  NButton,
  NInput,
  NSelect,
  NInputNumber,
  NImage,
  NImageGroup,
  NEmpty,
  NAlert,
  NSpin,
  NCollapse,
  NCollapseItem,
  useMessage,
  useDialog
} from 'naive-ui'
import { ImagePlus, Upload, WandSparkles, RefreshCw, X, Download, Copy } from 'lucide-vue-next'
import { api, imageUrl, ApiError } from '../lib/api'
import { IMAGE_BODY_LIMIT, serializeImageRequest } from '../lib/imageRequest'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import PageHeader from '../components/PageHeader.vue'
const message = useMessage(),
  dialog = useDialog()
const mode = ref<'generate' | 'edit'>('generate'),
  providers = ref<any>({ generation: [], edit: [] }),
  history = ref<any[]>([]),
  historyError = ref(''),
  providerError = ref('')
const form = reactive({ provider: '', aspectRatio: '', size: '', n: 1, quality: '', prompt: '' })
const references = ref<{ name: string; dataUri: string }[]>([]),
  gallery = ref<any[]>([]),
  busy = ref(false),
  cancelBusy = ref(false),
  elapsed = ref(0)
const fileInput = ref<HTMLInputElement | null>(null),
  dragging = ref(false)
let abort: AbortController | null = null,
  timer: ReturnType<typeof setInterval> | undefined,
  live = true
const list = computed(() =>
  mode.value === 'edit' ? providers.value.edit : providers.value.generation
)
const providerOptions = computed(() => [
  { label: '自动选择 · 按配置优先级回退', value: '' },
  ...list.value.map((p: any) => ({ label: p.label, value: p.label }))
])
const ratioOptions = [
  { label: '自动', value: '' },
  ...['1:1', '3:4', '4:3', '9:16', '16:9'].map((value) => ({ label: value, value }))
]
const qualityOptions = [
  { label: '自动', value: '' },
  ...['low', 'medium', 'high'].map((value) => ({ label: value, value }))
]
useUnsavedGuard(() => busy.value || Boolean(form.prompt.trim() || references.value.length))
async function loadProviders() {
  try {
    const result = await api('/api/image/providers')
    if (live) {
      providers.value = result
      providerError.value = ''
    }
  } catch (e) {
    if (live) providerError.value = (e as Error).message
  }
}
async function loadHistory() {
  try {
    const result = await api('/api/image/history')
    if (live) {
      history.value = result
      historyError.value = ''
    }
  } catch (e) {
    if (live) historyError.value = (e as Error).message
  }
}
async function files(selected: File[] | FileList | null) {
  if (!selected) return
  const candidates = [...selected].filter((file) => file.type.startsWith('image/'))
  if (candidates.length > 4 - references.value.length) message.warning('最多保留 4 张参考图')
  for (const file of candidates.slice(0, 4 - references.value.length)) {
    if (file.size > 20 * 1024 * 1024) {
      message.error(`${file.name} 超过 20 MB`)
      continue
    }
    if (
      references.value.reduce((total, image) => total + image.dataUri.length, 0) +
        Math.ceil(file.size / 3) * 4 >
      IMAGE_BODY_LIMIT - 64 * 1024
    ) {
      message.error('参考图总大小过大，请减少数量或压缩后上传')
      continue
    }
    try {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
        reader.readAsDataURL(file)
      })
      if (live && references.value.length < 4) {
        if (
          references.value.reduce((total, image) => total + image.dataUri.length, 0) +
            dataUri.length >
          IMAGE_BODY_LIMIT - 64 * 1024
        )
          message.error('参考图总大小过大，请减少数量或压缩后上传')
        else references.value.push({ name: file.name, dataUri })
      }
    } catch (e) {
      if (live) message.error((e as Error).message)
    }
  }
  if (references.value.length) mode.value = 'edit'
  if (fileInput.value) fileInput.value.value = ''
}
function refresh() {
  void loadProviders()
  void loadHistory()
}
function drop(event: DragEvent) {
  dragging.value = false
  void files(event.dataTransfer?.files || null)
}
function paste(event: ClipboardEvent) {
  const images = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean) as File[]
  if (images.length) {
    event.preventDefault()
    files(images).catch((e) => message.error(e.message))
  }
}
function fill(meta: any) {
  Object.assign(form, {
    provider: meta.provider || '',
    aspectRatio: meta.aspectRatio === 'auto' ? '' : meta.aspectRatio || '',
    size: meta.size || '',
    n: meta.n || 1,
    quality: meta.quality || '',
    prompt: meta.prompt || ''
  })
  mode.value = meta.mode === 'edit' ? 'edit' : 'generate'
  if (meta.mode === 'edit') message.info('参数已回填，请重新上传参考图')
  else message.info('参数已回填')
}
function formatHistoryTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  return date.toLocaleString('zh-CN', {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}
async function generate() {
  if (busy.value || cancelBusy.value) return
  if (!form.prompt.trim()) {
    message.warning('请填写提示词')
    return
  }
  if (mode.value === 'edit' && !references.value.length) {
    message.warning('图生图需要至少一张参考图')
    return
  }
  const payload = {
    ...form,
    prompt: form.prompt.trim(),
    ...(mode.value === 'edit' ? { images: references.value.map((x) => x.dataUri) } : {})
  }
  let body: string
  try {
    body = serializeImageRequest(payload)
  } catch (e) {
    message.error((e as Error).message)
    return
  }
  const entry = reactive<any>({
    id: Date.now(),
    payload,
    mode: mode.value,
    state: 'running',
    result: null,
    error: '',
    attempts: []
  })
  gallery.value.unshift(entry)
  busy.value = true
  elapsed.value = 0
  abort = new AbortController()
  const started = Date.now()
  timer = setInterval(() => {
    elapsed.value = Math.floor((Date.now() - started) / 1000)
  }, 1000)
  try {
    const result = await api(`/api/image/${mode.value === 'edit' ? 'edit' : 'generate'}`, {
      method: 'POST',
      body,
      signal: abort.signal
    })
    if (live) {
      entry.result = result
      entry.state = 'ok'
      loadHistory()
    }
  } catch (e) {
    if (live) {
      entry.state = 'failed'
      entry.error = (e as Error).name === 'AbortError' ? '请求已取消' : (e as Error).message
      entry.attempts = e instanceof ApiError ? e.details.attempts || [] : []
    }
  } finally {
    clearInterval(timer)
    abort = null
    if (live) busy.value = false
  }
}
function confirmCancel() {
  const target = abort
  if (!target || cancelBusy.value) return
  dialog.warning({
    title: '取消生成',
    content: '此操作会取消控制台当前所有正在进行的生图任务。确定继续？',
    positiveText: '取消任务',
    negativeText: '继续生成',
    onPositiveClick: async () => {
      if (!live || cancelBusy.value || abort !== target) return
      cancelBusy.value = true
      try {
        await api('/api/image/cancel', { method: 'POST', body: '{}' })
        target.abort()
      } catch (e) {
        if (live) message.error((e as Error).message)
      } finally {
        if (live) cancelBusy.value = false
      }
    }
  })
}
function retry(entry: any) {
  fill({ ...entry.payload, mode: entry.mode })
  if (entry.mode === 'edit' && entry.payload.images)
    references.value = entry.payload.images.map((dataUri: string, i: number) => ({
      name: `参考图${i + 1}`,
      dataUri
    }))
  generate()
}
onMounted(() => {
  loadProviders()
  loadHistory()
  document.addEventListener('paste', paste)
})
onBeforeUnmount(() => {
  live = false
  abort?.abort()
  clearInterval(timer)
  document.removeEventListener('paste', paste)
})
</script>
<template>
  <div class="page-stack">
    <PageHeader
      title="生图工作台"
      eyebrow="创作工具"
      description="描述画面，选择渠道，生成你想要的作品。"
      ><template #actions
        ><NButton quaternary @click="refresh"
          ><template #icon><RefreshCw :size="16" /></template>刷新</NButton
        ></template
      ></PageHeader
    >
    <div class="draw-layout">
      <section
        class="panel draw-controls"
        :class="{ dragging }"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="drop"
      >
        <div class="task-tabs" role="tablist" aria-label="生图模式">
          <button :aria-selected="mode === 'generate'" role="tab" @click="mode = 'generate'">
            文生图</button
          ><button :aria-selected="mode === 'edit'" role="tab" @click="mode = 'edit'">
            图生图
          </button>
        </div>
        <NAlert v-if="providerError" type="error" class="draw-alert"
          >{{ providerError }}<NButton size="tiny" @click="loadProviders">重试</NButton></NAlert
        >
        <div class="form-field">
          <span>提示词</span
          ><NInput
            v-model:value="form.prompt"
            type="textarea"
            :autosize="{ minRows: 5, maxRows: 12 }"
            placeholder="描述主体、环境、风格与光线…"
          />
        </div>
        <div v-if="mode === 'edit'" class="reference-zone">
          <div class="toolbar">
            <span class="section-title">参考图片</span
            ><small class="muted">{{ references.length }} / 4</small>
          </div>
          <input
            ref="fileInput"
            type="file"
            multiple
            accept="image/*"
            class="hidden-input"
            @change="files(($event.target as HTMLInputElement).files)"
          /><button class="upload-target" @click="fileInput?.click()">
            <Upload :size="21" /><span>选择图片或拖拽到此处</span><small>也支持粘贴截图</small>
          </button>
          <div class="reference-grid">
            <figure v-for="(image, index) in references" :key="image.dataUri">
              <img :src="image.dataUri" :alt="image.name" /><button
                :aria-label="`移除${image.name}`"
                @click="references.splice(index, 1)"
              >
                <X :size="13" />
              </button>
            </figure>
          </div>
        </div>
        <div class="form-field">
          <span>生成渠道</span><NSelect v-model:value="form.provider" :options="providerOptions" />
        </div>
        <div class="field-grid">
          <label class="form-field"
            ><span>画面比例</span
            ><NSelect v-model:value="form.aspectRatio" :options="ratioOptions" /></label
          ><label class="form-field"
            ><span>生成数量</span><NInputNumber v-model:value="form.n" :min="1" :max="4"
          /></label>
        </div>
        <NCollapse
          ><NCollapseItem title="尺寸与质量" name="advanced"
            ><div class="page-stack">
              <label class="form-field"
                ><span>自定义尺寸</span
                ><NInput v-model:value="form.size" placeholder="1024x1536 / 2K / 4K / auto" /><small
                  class="field-help"
                  >填写后优先于画面比例。具体能力由渠道决定。</small
                ></label
              ><label class="form-field"
                ><span>质量</span
                ><NSelect v-model:value="form.quality" :options="qualityOptions" /><small
                  class="field-help"
                  >gpt-image / grok 支持；grok 固定生成 1 张。</small
                ></label
              >
            </div></NCollapseItem
          ></NCollapse
        ><NButton
          type="primary"
          block
          size="large"
          :loading="busy"
          :disabled="cancelBusy"
          @click="generate"
          ><template #icon><WandSparkles :size="18" /></template
          >{{ busy ? `生成中 · ${elapsed} 秒` : '开始生成' }}</NButton
        ><NButton v-if="busy" block :loading="cancelBusy" @click="confirmCancel">取消任务</NButton>
      </section>
      <section class="draw-output">
        <div class="panel-heading">
          <h2>本次作品</h2>
          <NButton v-if="gallery.length && !busy" size="small" quaternary @click="gallery = []"
            >清空会话</NButton
          >
        </div>
        <div v-if="!gallery.length" class="panel draw-empty">
          <div class="empty-illustration"><ImagePlus :size="27" /></div>
          <h3>从一个想法开始</h3>
          <p>填写提示词，生成的作品会出现在这里。</p>
        </div>
        <article v-for="entry in gallery" :key="entry.id" class="panel gallery-entry">
          <template v-if="entry.state === 'running'"
            ><NSpin size="small" />
            <p class="muted">正在生成 · {{ elapsed }} 秒</p>
            <p>{{ entry.payload.prompt }}</p></template
          ><template v-else-if="entry.state === 'failed'"
            ><NAlert type="error" title="生成失败">{{ entry.error }}</NAlert
            ><NButton :disabled="busy" @click="retry(entry)">重试</NButton></template
          ><template v-else
            ><div class="gallery-meta">
              <strong>{{ entry.result.provider }}</strong
              ><span
                >{{ (entry.result.tookMs / 1000).toFixed(1) }} 秒 ·
                {{ entry.result.count }} 张</span
              >
            </div>
            <div class="gallery-images">
              <figure v-for="image in entry.result.images" :key="image.file">
                <NImage :src="image.dataUri" :alt="entry.payload.prompt" /><a
                  :href="image.dataUri"
                  :download="image.file"
                  ><Download :size="13" />下载 · {{ Math.round(image.bytes / 1024) }} KB</a
                >
              </figure>
            </div>
            <div class="toolbar">
              <NButton size="small" :disabled="busy" @click="retry(entry)">再次生成</NButton
              ><NButton
                size="small"
                quaternary
                @click="fill({ ...entry.payload, mode: entry.mode })"
                ><template #icon><Copy :size="14" /></template>参数回填</NButton
              >
            </div></template
          ><NCollapse v-if="(entry.result?.attempts || entry.attempts).length"
            ><NCollapseItem title="渠道尝试明细"
              ><div
                v-for="(attempt, index) in entry.result?.attempts || entry.attempts"
                :key="index"
                class="list-row"
              >
                <span>{{ attempt.provider }}</span
                ><small :class="attempt.ok ? 'muted' : 'danger-text'"
                  >{{ attempt.ok ? '成功' : attempt.error }} · {{ attempt.ms }} ms</small
                >
              </div></NCollapseItem
            ></NCollapse
          >
        </article>
      </section>
    </div>
    <section class="panel">
      <div class="panel-heading">
        <h2>生成历史</h2>
        <small class="muted">按每次生成分组 · 历史参考图不保留，图生图需重新上传</small>
      </div>
      <NAlert v-if="historyError" type="error">{{ historyError }}</NAlert
      ><NEmpty v-else-if="!history.length" description="暂无历史作品" />
      <div v-else class="history-batches">
        <article v-for="batch in history" :key="batch.id" class="history-batch">
          <div class="history-batch-head">
            <div class="gallery-meta">
              <strong>{{ batch.provider || '未知渠道' }}</strong>
              <span>
                {{ formatHistoryTime(batch.at) }} · {{ batch.count }} 张<template
                  v-if="batch.mode === 'edit'"
                  >· 图生图</template
                >
              </span>
            </div>
            <NButton size="tiny" quaternary @click="fill(batch)">使用参数</NButton>
          </div>
          <p class="history-prompt">{{ batch.prompt || '（无提示词）' }}</p>
          <!-- NImageGroup 隐藏态不渲染 DOM,网格类放在外层 div 上;组内图片点击后可整批翻看 -->
          <div class="history-grid">
            <NImageGroup>
              <figure v-for="image in batch.images" :key="image.file">
                <NImage
                  :src="imageUrl('/img/' + image.file)"
                  :alt="batch.prompt || image.file"
                  object-fit="cover"
                />
              </figure>
            </NImageGroup>
          </div>
        </article>
      </div>
    </section>
    <NCollapse
      ><NCollapseItem title="已配置渠道与回退顺序"
        ><div class="field-grid">
          <section v-for="kind in ['generation', 'edit']" :key="kind">
            <h3>{{ kind === 'generation' ? '文生图' : '图生图' }}</h3>
            <div v-for="(item, index) in providers[kind]" :key="item.label" class="list-row">
              <span
                >{{ Number(index) + 1 }}. {{ item.label
                }}<small class="muted"> · {{ item.model }}</small></span
              ><small class="muted">{{ item.host }}</small>
            </div>
          </section>
        </div></NCollapseItem
      ></NCollapse
    >
  </div>
</template>
<style scoped>
.draw-layout {
  display: grid;
  grid-template-columns: minmax(290px, 360px) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
.draw-controls {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.draw-controls.dragging {
  border-color: var(--c-accent);
}
.draw-alert {
  margin-bottom: 0;
}
.hidden-input {
  display: none;
}
.upload-target {
  width: 100%;
  display: grid;
  justify-items: center;
  gap: 4px;
  border: 1px dashed var(--c-border);
  background: var(--c-bg);
  color: var(--c-muted);
  padding: 18px;
  border-radius: 9px;
}
.reference-grid {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.reference-grid figure {
  margin: 0;
  position: relative;
  width: 60px;
  height: 60px;
}
.reference-grid img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 7px;
}
.reference-grid button {
  position: absolute;
  right: -4px;
  top: -4px;
  border: 0;
  background: var(--c-panel);
  color: var(--c-muted);
  border-radius: 50%;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
}
.draw-output {
  min-width: 0;
}
.draw-empty {
  text-align: center;
  padding: 90px 22px;
}
.draw-empty p {
  margin-top: 8px;
  color: var(--c-muted);
}
.gallery-entry {
  display: grid;
  gap: 14px;
  margin-bottom: 18px;
}
.gallery-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.gallery-meta span {
  color: var(--c-muted);
  font-size: 12px;
}
.gallery-images {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}
.gallery-images figure {
  margin: 0;
  min-width: 0;
}
.gallery-images :deep(img) {
  max-width: 100%;
  border-radius: 9px;
}
.gallery-images a {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  font-size: 12px;
}
.history-batches {
  display: grid;
  gap: 18px;
}
.history-batch {
  display: grid;
  gap: 10px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--c-border);
}
.history-batch:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}
.history-batch-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.history-prompt {
  margin: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 13px;
  color: var(--c-text);
}
.history-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.history-grid figure {
  margin: 0;
  min-width: 0;
}
.history-grid :deep(.n-image) {
  width: 100%;
}
.history-grid :deep(img) {
  width: 100%;
  height: 140px;
  object-fit: cover;
  border-radius: 9px;
}
.reference-zone .section-title {
  margin: 0;
}
@media (max-width: 1150px) {
  .draw-layout {
    grid-template-columns: 310px minmax(0, 1fr);
  }
}
@media (max-width: 1050px) {
  .draw-layout {
    grid-template-columns: 1fr;
  }
  .draw-empty {
    padding: 55px 18px;
  }
}
@media (max-width: 450px) {
  .gallery-images {
    grid-template-columns: 1fr;
  }
}
</style>
