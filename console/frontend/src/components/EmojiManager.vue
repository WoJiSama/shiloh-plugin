<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NInput, NSelect, NTag, useDialog } from 'naive-ui'
import PageState from './PageState.vue'
import SaveBar from './SaveBar.vue'
import { commandsApi, COMMANDS_API, clone, changes } from '../lib/commands'
import { imageUrl } from '../lib/api'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import { errorText, useOpsResource } from '../lib/operations'
interface Emoji {
  hash: string
  tags: string[]
  isBanned: boolean
  usedCount: number
  registeredAt?: string
}
interface Admission {
  allow: string[]
  reject: string[]
}
const dialog = useDialog()
const gallery = useOpsResource((signal) =>
  commandsApi<{ items: Emoji[]; stats: { total: number; banned: number } }>('emoji-data', {
    signal
  })
)
const admission = useOpsResource((signal) => commandsApi<Admission>('emoji-admission', { signal }))
const draft = ref<Admission>({ allow: [], reject: [] })
const baseline = ref<Admission>({ allow: [], reject: [] })
const dirty = computed(() => changes(draft.value, baseline.value))
const saving = ref(false)
const deleting = ref(false)
const error = ref('')
const saved = ref('')
const success = ref('')
const selected = ref<string[]>([])
const query = ref('')
const filter = ref('all')
const all = computed(() => gallery.data.value?.items || [])
const filtered = computed(() =>
  all.value.filter(
    (item) =>
      (!query.value.trim() ||
        `${item.hash} ${item.tags.join(' ')}`
          .toLowerCase()
          .includes(query.value.trim().toLowerCase())) &&
      (filter.value === 'all' ||
        (filter.value === 'active' && !item.isBanned) ||
        (filter.value === 'banned' && item.isBanned))
  )
)
const selectedExisting = computed(() =>
  selected.value.filter((hash) => all.value.some((item) => item.hash === hash))
)
const page = ref(1)
const pages = computed(() => Math.ceil(filtered.value.length / 40))
const visible = computed(() => filtered.value.slice((page.value - 1) * 40, page.value * 40))
watch([query, filter], () => {
  page.value = 1
})
watch(pages, (total) => {
  page.value = Math.max(Math.min(page.value, total), 1)
})
watch(admission.data, (value) => {
  if (value && !dirty.value && !saving.value) {
    draft.value = clone(value)
    baseline.value = clone(value)
  }
})
let active = true
onUnmounted(() => {
  active = false
})
useUnsavedGuard(() => dirty.value > 0 || saving.value || deleting.value)
function select(hash: string, checked: boolean) {
  selected.value = checked
    ? [...new Set([...selected.value, hash])]
    : selected.value.filter((value) => value !== hash)
}
function discard() {
  dialog.warning({
    title: '放弃入库标准修改',
    content: '恢复到最近加载或保存的入库标准。',
    positiveText: '放弃修改',
    negativeText: '继续编辑',
    onPositiveClick: () => {
      draft.value = clone(baseline.value)
      error.value = ''
    }
  })
}
async function save() {
  if (saving.value) return
  const snapshot = {
    allow: draft.value.allow.map((row) => row.trim()).filter(Boolean),
    reject: draft.value.reject.map((row) => row.trim()).filter(Boolean)
  }
  if (snapshot.allow.length > 20 || snapshot.reject.length > 20) {
    error.value = '补充放行和补充拒绝各最多 20 条。'
    return
  }
  if ([...snapshot.allow, ...snapshot.reject].some((row) => row.length > 80)) {
    error.value = '每条补充标准最多 80 字。'
    return
  }
  saving.value = true
  error.value = ''
  try {
    const result = await commandsApi<Admission>('emoji-admission', {
      method: 'POST',
      body: JSON.stringify(snapshot)
    })
    if (!active) return
    baseline.value = clone(result)
    draft.value = clone(result)
    saved.value = `已保存 ${result.allow.length} 条放行、${result.reject.length} 条拒绝规则，新收藏立即生效`
  } catch (cause) {
    if (active) error.value = errorText(cause)
  } finally {
    if (active) saving.value = false
  }
}
function remove(hashes: string[]) {
  if (!hashes.length || deleting.value) return
  if (hashes.length > 500) {
    error.value = '一次最多删除 500 张，请缩小选择范围。'
    return
  }
  const snapshot = [...hashes]
  dialog.warning({
    title: `删除 ${snapshot.length} 张表情包`,
    content: '图库记录和对应图片文件都会删除，无法通过本页面恢复。',
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      if (!active || deleting.value) return
      deleting.value = true
      error.value = ''
      success.value = ''
      try {
        const result =
          snapshot.length === 1
            ? await commandsApi<{ removed?: number; missing?: number }>('emoji-delete', {
                method: 'POST',
                body: JSON.stringify({ hash: snapshot[0] })
              })
            : await commandsApi<{ removed: number; missing: number }>('emoji-delete-batch', {
                method: 'POST',
                body: JSON.stringify({ hashes: snapshot })
              })
        if (!active) return
        selected.value = selected.value.filter((hash) => !snapshot.includes(hash))
        success.value = `已删除 ${result.removed ?? 1} 张表情包${result.missing ? `，${result.missing} 张已不存在` : ''}。`
        await gallery.refresh()
      } catch (cause) {
        if (active) error.value = errorText(cause)
      } finally {
        if (active) deleting.value = false
      }
    }
  })
}
</script>

<template>
  <div class="page-stack">
    <div class="emoji-heading">
      <div>
        <h2 class="section-title">表情素材库</h2>
        <p class="field-help">管理自动收藏的图片与新素材的入库标准。</p>
      </div>
      <NButton :loading="gallery.loading.value" @click="gallery.refresh">刷新图库</NButton>
    </div>
    <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert
    ><NAlert v-if="success" type="success" :bordered="false">{{ success }}</NAlert>
    <details class="panel admission-panel">
      <summary>
        新素材入库标准 <NTag v-if="dirty" size="small" type="warning">有未保存修改</NTag>
      </summary>
      <div class="page-stack admission-content">
        <p class="field-help">
          内置标准优先接收梗图、夸张情绪与拟人反应。普通照片、风景和各类截图默认拒绝。补充标准由视觉模型在新图片自动收藏前判定。
        </p>
        <PageState
          :loading="admission.loading.value && !admission.data.value"
          :error="!admission.data.value ? admission.error.value : null"
          @retry="admission.refresh"
          ><div class="field-grid">
            <div v-for="key in ['allow', 'reject'] as const" :key="key" class="form-field">
              <label :for="`emoji-admission-${key}`">{{
                key === 'allow' ? '补充放行' : '补充拒绝'
              }}</label
              ><NInput
                :value="draft[key].join('\n')"
                type="textarea"
                :input-props="{ id: `emoji-admission-${key}` }"
                :autosize="{ minRows: 5, maxRows: 12 }"
                :disabled="saving"
                placeholder="每行一条，最多 20 条，每条最多 80 字"
                @update:value="draft[key] = $event.split('\n')"
              />
            </div>
          </div>
          <SaveBar :dirty="dirty" :saving="saving" :saved="saved" @save="save" @discard="discard"
        /></PageState>
      </div>
    </details>
    <div class="gallery-controls">
      <NInput
        v-model:value="query"
        clearable
        placeholder="搜索标签或图片标识"
        aria-label="搜索表情包"
      /><NSelect
        v-model:value="filter"
        :options="[
          { label: '全部素材', value: 'all' },
          { label: '可用', value: 'active' },
          { label: '已停用', value: 'banned' }
        ]"
        aria-label="按表情包状态筛选"
      /><span class="muted"
        >{{ filtered.length }} 张<span v-if="gallery.data.value?.stats">
          · 已停用 {{ gallery.data.value.stats.banned }}</span
        ></span
      >
    </div>
    <div class="gallery-selection">
      <NButton
        size="small"
        :disabled="deleting || !filtered.length"
        @click="selected = [...new Set([...selected, ...filtered.map((item) => item.hash)])]"
        >选择全部筛选结果</NButton
      ><NButton size="small" :disabled="deleting || !selectedExisting.length" @click="selected = []"
        >清空选择</NButton
      ><NButton
        size="small"
        type="error"
        secondary
        :loading="deleting"
        :disabled="!selectedExisting.length"
        @click="remove(selectedExisting)"
        >删除所选 {{ selectedExisting.length ? `（${selectedExisting.length}）` : '' }}</NButton
      >
    </div>
    <NAlert v-if="gallery.error.value && gallery.data.value" type="warning" :bordered="false"
      >刷新失败，当前图库仍保留：{{ gallery.error.value }}</NAlert
    >
    <PageState
      :loading="gallery.loading.value && !gallery.data.value"
      :error="!gallery.data.value ? gallery.error.value : null"
      :empty="!!gallery.data.value && !filtered.length"
      :empty-text="all.length ? '没有匹配的表情素材。' : '暂无自动收藏的表情素材。'"
      @retry="gallery.refresh"
      ><div class="emoji-grid">
        <article
          v-for="item in visible"
          :key="item.hash"
          class="panel emoji-card"
          :class="{ 'emoji-selected': selected.includes(item.hash) }"
        >
          <div class="emoji-image">
            <img
              :src="imageUrl(`${COMMANDS_API}/emoji-file/${item.hash}`)"
              :alt="item.tags.join('、') || `表情 ${item.hash.slice(0, 8)}`"
              loading="lazy"
            /><NCheckbox
              :checked="selected.includes(item.hash)"
              :disabled="deleting"
              :aria-label="`选择表情 ${item.hash.slice(0, 8)}`"
              @update:checked="select(item.hash, $event)"
            />
          </div>
          <div class="emoji-tags" :title="item.tags.join(' / ')">
            {{ item.tags.join(' / ') || '无标签' }}
          </div>
          <div class="emoji-meta">
            <span>使用 {{ item.usedCount || 0 }} 次</span
            ><span v-if="item.registeredAt">{{ item.registeredAt.slice(0, 10) }}</span>
          </div>
          <div class="emoji-actions">
            <NTag v-if="item.isBanned" type="warning" size="small">已停用</NTag
            ><NButton
              size="tiny"
              quaternary
              type="error"
              :disabled="deleting"
              @click="remove([item.hash])"
              >删除</NButton
            >
          </div>
        </article>
      </div>
      <div v-if="pages > 1" class="gallery-pagination">
        <NButton size="small" :disabled="page <= 1" @click="page--">上一页</NButton
        ><span class="muted">{{ page }} / {{ pages }}</span
        ><NButton size="small" :disabled="page >= pages" @click="page++">下一页</NButton>
      </div></PageState
    >
  </div>
</template>

<style scoped>
.emoji-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
  flex-wrap: wrap;
}
.emoji-heading .section-title {
  margin-bottom: 6px;
}
.admission-panel > summary {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  cursor: pointer;
  color: var(--c-muted);
}
.admission-content {
  margin-top: 22px;
}
.gallery-controls {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.gallery-controls > .n-input {
  max-width: 380px;
  flex: 1;
}
.gallery-controls > .n-select {
  width: 130px;
  flex-shrink: 0;
}
.gallery-controls > .muted {
  font-size: 12px;
  margin-left: auto;
}
.gallery-selection {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.emoji-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(155px, 1fr));
  gap: 16px;
}
.emoji-card {
  padding: 12px;
  border-radius: 10px;
  overflow: hidden;
}
.emoji-card.emoji-selected {
  border-color: var(--c-accent);
  background: var(--c-selected);
}
.emoji-image {
  height: 125px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--c-soft);
  border-radius: 7px;
  overflow: hidden;
}
.emoji-image > img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.emoji-image > .n-checkbox {
  position: absolute;
  right: 8px;
  top: 8px;
  background: var(--c-panel);
  border-radius: 3px;
  padding: 3px;
}
.emoji-tags {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin: 10px 0 5px;
}
.emoji-meta {
  display: flex;
  justify-content: space-between;
  gap: 7px;
  color: var(--c-muted);
  font-size: 10px;
}
.emoji-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
  min-height: 24px;
}
.emoji-actions > .n-tag {
  margin-right: auto;
}
.gallery-pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  margin-top: 20px;
  font-size: 12px;
}
@media (max-width: 480px) {
  .gallery-controls > .n-input {
    flex-basis: 100%;
    max-width: none;
  }
  .gallery-controls > .n-select {
    width: 100%;
  }
  .emoji-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .emoji-card {
    padding: 9px;
  }
  .emoji-image {
    height: 105px;
  }
  .emoji-meta {
    flex-direction: column;
    gap: 2px;
  }
}
</style>
