<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NInput,
  NModal,
  NTag,
  useDialog
} from 'naive-ui'
import IdentityLabel from './IdentityLabel.vue'
import { botLabel } from '../lib/identities'
import { api } from '../lib/api'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import { errorText } from '../lib/operations'

const props = withDefaults(defineProps<{ show: boolean; botIds?: string[] }>(), {
  botIds: () => []
})
const emit = defineEmits<{ 'update:show': [value: boolean] }>()
const dialog = useDialog()
const bots = ref<Array<{ qq: string; nickname: string }>>([])
const selected = ref<string[]>([])
const content = ref('')
const loading = ref(false)
const sending = ref(false)
useUnsavedGuard(() => !!content.value.trim() || sending.value)
const error = ref('')
const results = ref<Array<{ qq: string; ok: boolean; error?: string }>>([])
const valid = computed(() => content.value.trim().length > 0 && selected.value.length > 0)
let controller: AbortController | null = null
let active = true
let sequence = 0
watch(
  () => props.show,
  async (show) => {
    controller?.abort()
    const ticket = ++sequence
    if (!show) {
      loading.value = false
      return
    }
    error.value = ''
    results.value = []
    loading.value = true
    controller = new AbortController()
    try {
      const result = await api<{ bots: Array<{ qq: string; nickname: string }> }>(
        '/api/qzone/bots',
        { signal: controller.signal }
      )
      if (!active || ticket !== sequence) return
      bots.value = (result.bots || []).map((bot) => ({ ...bot, qq: String(bot.qq) }))
      selected.value = props.botIds
        .map(String)
        .filter((id) => bots.value.some((bot) => bot.qq === id))
    } catch (cause) {
      if (active && ticket === sequence && !controller.signal.aborted)
        error.value = errorText(cause)
    } finally {
      if (active && ticket === sequence) loading.value = false
    }
  },
  { immediate: true }
)
onUnmounted(() => {
  active = false
  controller?.abort()
  ++sequence
})
function close() {
  if (!sending.value) emit('update:show', false)
}
function publish() {
  if (!valid.value || sending.value) return
  const snapshot = { botIds: [...selected.value], content: content.value.trim() }
  dialog.warning({
    title: `确认以 ${snapshot.botIds.length} 个账号发布说说`,
    content: `账号：${snapshot.botIds.map((qq) => botLabel(qq, bots.value.find((bot) => bot.qq === qq)?.nickname)).join('、')}。内容：${snapshot.content}`,
    positiveText: '确认发布',
    negativeText: '返回编辑',
    onPositiveClick: async () => {
      if (!active || sending.value || !props.show) return
      sending.value = true
      error.value = ''
      results.value = []
      try {
        const result = await api<{ results: Array<{ qq: string; ok: boolean; error?: string }> }>(
          '/api/qzone/publish',
          { method: 'POST', body: JSON.stringify(snapshot) }
        )
        if (!active) return
        results.value = result.results || []
        if (!results.value.length) error.value = '接口没有返回发布回执，请核对运行状态后再操作。'
        else if (results.value.every((item) => item.ok)) content.value = ''
      } catch (cause) {
        if (active) error.value = errorText(cause)
      } finally {
        if (active) sending.value = false
      }
    }
  })
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="发布 QQ 空间说说"
    class="qzone-modal"
    :mask-closable="!sending"
    :close-on-esc="!sending"
    :closable="!sending"
    @update:show="close"
  >
    <div class="page-stack">
      <p class="muted">每个选中的机器人将以自己的身份发布一条说说。</p>
      <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert>
      <div class="form-field">
        <label for="qzone-content">说说内容</label>
        <NInput
          :input-props="{ id: 'qzone-content' }"
          v-model:value="content"
          type="textarea"
          placeholder="写下要发布的内容…"
          :autosize="{ minRows: 5, maxRows: 10 }"
          :maxlength="2000"
          show-count
          :disabled="sending"
        />
      </div>
      <div class="form-field">
        <div class="composer-heading">
          <span
            >发布账号 <span class="muted">· 已选 {{ selected.length }} 个</span></span
          ><NButton
            text
            size="small"
            :disabled="loading || sending"
            @click="selected = bots.map((bot) => bot.qq)"
            >全选</NButton
          ><NButton text size="small" :disabled="sending" @click="selected = []">清空</NButton>
        </div>
        <p v-if="loading" class="muted">正在加载可用机器人…</p>
        <p v-else-if="!bots.length" class="muted">
          暂无可用机器人，请确认机器人服务连接和 QQ 空间接口配置。
        </p>
        <NCheckboxGroup v-else v-model:value="selected" :disabled="sending">
          <div class="bot-choices">
            <NCheckbox v-for="bot in bots" :key="bot.qq" :value="bot.qq"
              ><IdentityLabel kind="bot" :id="bot.qq" :name="bot.nickname"
            /></NCheckbox>
          </div>
        </NCheckboxGroup>
      </div>
      <div v-if="results.length" class="receipts" aria-live="polite">
        <div class="section-title">
          发布回执 · {{ results.filter((result) => result.ok).length }}/{{ results.length }} 成功
        </div>
        <div v-for="result in results" :key="result.qq" class="receipt">
          <NTag :type="result.ok ? 'success' : 'error'" size="small">{{
            result.ok ? '已发布' : '失败'
          }}</NTag
          ><IdentityLabel
            kind="bot"
            :id="result.qq"
            :name="bots.find((bot) => bot.qq === result.qq)?.nickname"
          />
          <span v-if="result.error" class="muted">{{ result.error }}</span>
        </div>
        <p v-if="results.some((result) => !result.ok)" class="field-help">
          重试前请只选择失败账号，避免给已成功账号重复发布。
        </p>
      </div>
      <div class="composer-actions">
        <NButton :disabled="sending" @click="close">关闭</NButton
        ><NButton type="primary" :loading="sending" :disabled="!valid || loading" @click="publish"
          >发布到 {{ selected.length }} 个账号</NButton
        >
      </div>
    </div>
  </NModal>
</template>

<style scoped>
:global(.qzone-modal) {
  width: min(640px, calc(100vw - 32px));
}
.composer-heading {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
}
.composer-heading > span {
  flex: 1;
}
.bot-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
.receipts {
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 16px;
}
.receipt {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.receipt .muted {
  overflow-wrap: anywhere;
}
@media (max-width: 480px) {
  .bot-choices {
    grid-template-columns: 1fr;
  }
}
</style>
