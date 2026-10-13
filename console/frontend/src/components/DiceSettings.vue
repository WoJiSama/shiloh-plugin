<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NCollapse, NCollapseItem, NInput, NTag, useDialog } from 'naive-ui'
import PageState from './PageState.vue'
import SaveBar from './SaveBar.vue'
import { useUnsavedGuard } from '../composables/useUnsavedGuard'
import { commandsApi, clone, changes, type DiceData, type DiceTemplateMeta } from '../lib/commands'
import { useOpsResource, errorText } from '../lib/operations'
const dialog = useDialog()
const data = useOpsResource((signal) => commandsApi<DiceData>('dice-data', { signal }))
type Draft = Pick<DiceData, 'templates' | 'checkLevels' | 'insanityTables' | 'jrrpComments'>
const empty = (): Draft => ({
  templates: {},
  checkLevels: {},
  insanityTables: { temp: [], indefinite: [] },
  jrrpComments: ['', '', '', '', '', '']
})
const draft = ref<Draft>(empty())
const baseline = ref<Draft>(empty())
const saving = ref(false)
const error = ref('')
const saved = ref('')
const dirty = computed(() => changes(draft.value, baseline.value))
const ranges = ['1–10 分', '11–30 分', '31–50 分', '51–70 分', '71–90 分', '91–100 分']
const mappedKeys = computed(
  () =>
    new Set(
      (data.data.value?.builtin || []).flatMap((rule) => [
        ...(rule.groups || []).flatMap((group) => group.templates.map((template) => template.key)),
        ...(rule.templateKeys || []).map((template) => template.key)
      ])
    )
)
const leftovers = computed(() =>
  Object.keys(draft.value.templates).filter((key) => !mappedKeys.value.has(key))
)
function normalize(value: DiceData): Draft {
  return {
    templates: clone(value.templates || {}),
    checkLevels: clone(value.checkLevels || {}),
    insanityTables: {
      temp: clone(value.insanityTables?.temp || []),
      indefinite: clone(value.insanityTables?.indefinite || [])
    },
    jrrpComments: Array.from({ length: 6 }, (_, index) => value.jrrpComments?.[index] || '')
  }
}
watch(data.data, (value) => {
  if (value && !dirty.value && !saving.value) {
    draft.value = normalize(value)
    baseline.value = clone(draft.value)
  }
})
useUnsavedGuard(() => dirty.value > 0 || saving.value)
let active = true
onUnmounted(() => {
  active = false
})
function rows(rule: DiceData['builtin'][number]) {
  return rule.groups?.length
    ? rule.groups
    : [{ title: '回复内容', command: '', hint: '', templates: rule.templateKeys || [] }]
}
function hint(template: DiceTemplateMeta) {
  return (
    template.hint ||
    (template.key.startsWith('check_')
      ? `留空时使用默认检定模板：${draft.value.templates.check || ''}`
      : '')
  )
}
function discard() {
  dialog.warning({
    title: '放弃骰子回复修改',
    content: '恢复到最近加载或保存的骰子设置。',
    positiveText: '放弃修改',
    negativeText: '继续编辑',
    onPositiveClick: () => {
      draft.value = clone(baseline.value)
      error.value = ''
    }
  })
}
function reload() {
  if (dirty.value)
    dialog.warning({
      title: '重新加载骰子回复',
      content: '将放弃当前骰子回复的未保存修改。',
      positiveText: '放弃并加载',
      negativeText: '继续编辑',
      onPositiveClick: () => {
        draft.value = clone(baseline.value)
        void data.refresh()
      }
    })
  else void data.refresh()
}
async function save() {
  if (saving.value) return
  const snapshot = clone(draft.value)
  for (const key of ['temp', 'indefinite'] as const) {
    if (snapshot.insanityTables[key].length > 50) {
      error.value = '每张疯狂表最多 50 条，请删减后保存。'
      return
    }
    if (snapshot.insanityTables[key].some((row) => row.length > 200)) {
      error.value = '疯狂表每条内容最多 200 字。'
      return
    }
  }
  saving.value = true
  error.value = ''
  try {
    const result = await commandsApi<{ saved: number; savedLevels: number; savedInsanity: number }>(
      'dice-templates',
      { method: 'POST', body: JSON.stringify(snapshot) }
    )
    if (!active) return
    baseline.value = snapshot
    saved.value = `已保存 ${result.saved} 个模板、${result.savedLevels} 个档位、${result.savedInsanity} 条疯狂表并热生效`
  } catch (cause) {
    if (active) error.value = errorText(cause)
  } finally {
    if (active) saving.value = false
  }
}
</script>

<template>
  <div class="page-stack">
    <div class="dice-heading">
      <div>
        <h2 class="section-title">骰子回复与判定</h2>
        <p class="field-help">按规则和命令分组编辑。保留模板里的变量占位符，保存后配置热生效。</p>
      </div>
      <NButton :loading="data.loading.value" :disabled="saving" @click="reload">重新加载</NButton>
    </div>
    <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert>
    <NAlert v-if="data.error.value && data.data.value" type="warning" :bordered="false"
      >刷新失败，当前草稿仍保留：{{ data.error.value }}</NAlert
    >
    <PageState
      :loading="data.loading.value && !data.data.value"
      :error="!data.data.value ? data.error.value : null"
      @retry="data.refresh"
    >
      <NCollapse v-if="data.data.value" class="dice-rules">
        <NCollapseItem
          v-for="rule in data.data.value.builtin"
          :key="rule.id"
          :name="rule.id"
          :title="rule.name"
          ><template #header-extra
            ><span class="muted rule-command-count"
              >{{ rule.commands?.length || 0 }} 个命令</span
            ></template
          >
          <div class="rule-description">
            <p class="field-help">{{ rule.desc }}</p>
            <div class="rule-commands">
              <NTag
                v-for="command in rule.commands"
                :key="command"
                size="small"
                :bordered="false"
                >{{ command }}</NTag
              >
            </div>
          </div>
          <div v-for="(group, index) in rows(rule)" :key="index" class="template-group">
            <h3 v-if="group.templates.length" class="section-title">
              {{ group.title || group.command }}
            </h3>
            <p v-if="group.hint" class="field-help">{{ group.hint }}</p>
            <div
              v-for="template in group.templates"
              :key="template.key"
              class="form-field template-field"
            >
              <label :for="`template-${template.key}`">{{ template.label || template.key }}</label
              ><NInput
                v-model:value="draft.templates[template.key]"
                type="textarea"
                :input-props="{ id: `template-${template.key}` }"
                :autosize="{ minRows: 2, maxRows: 6 }"
                :maxlength="2000"
                :placeholder="hint(template)"
                :disabled="saving"
              /><span v-if="template.hint" class="field-help">{{ template.hint }}</span>
            </div>
          </div>
          <template v-if="rule.hasLevels"
            ><h3 class="section-title">判定档位名称</h3>
            <p class="field-help">设置插入 {level} 的短名。整句回复在对应检定模板中设置。</p>
            <div class="field-grid levels-grid">
              <div
                v-for="level in data.data.value.checkLevelMeta"
                :key="level.key"
                class="form-field"
              >
                <label :for="`level-${level.key}`">{{ level.label }}</label
                ><NInput
                  v-model:value="draft.checkLevels[level.key]"
                  :input-props="{ id: `level-${level.key}` }"
                  :maxlength="30"
                  :disabled="saving"
                />
              </div></div></template
          ><template v-if="rule.hasInsanity"
            ><h3 class="section-title">疯狂表</h3>
            <div class="field-grid insanity-grid">
              <div v-for="key in ['temp', 'indefinite'] as const" :key="key" class="form-field">
                <label :for="`insanity-${key}`">{{
                  key === 'temp' ? '临时疯狂（.ti）' : '总结疯狂（.li）'
                }}</label
                ><NInput
                  :value="draft.insanityTables[key].join('\n')"
                  type="textarea"
                  :input-props="{ id: `insanity-${key}` }"
                  :autosize="{ minRows: 7, maxRows: 15 }"
                  :disabled="saving"
                  placeholder="每行一条，最多 50 条"
                  @update:value="draft.insanityTables[key] = $event.split('\n')"
                />
              </div></div
          ></template>
          <p
            v-if="
              !rows(rule).some((group) => group.templates.length) &&
              !rule.hasLevels &&
              !rule.hasInsanity
            "
            class="field-help"
          >
            本规则没有回复模板设置，牌堆与规则文件可在对应分区管理。
          </p></NCollapseItem
        >
        <NCollapseItem v-if="leftovers.length" name="common" title="通用回复模板"
          ><div v-for="key in leftovers" :key="key" class="form-field template-field">
            <label :for="`template-${key}`">{{ key }}</label
            ><NInput
              v-model:value="draft.templates[key]"
              type="textarea"
              :input-props="{ id: `template-${key}` }"
              :autosize="{ minRows: 2, maxRows: 6 }"
              :maxlength="2000"
              :disabled="saving"
            /></div
        ></NCollapseItem>
        <NCollapseItem name="jrrp" title="今日人品 · 分数段评语"
          ><p class="field-help">
            .jrrp 按分数段插入对应评语，留空使用默认文案。整句格式在 jrrp 模板管理。
          </p>
          <div class="field-grid jrrp-grid">
            <div v-for="(range, index) in ranges" :key="range" class="form-field">
              <label :for="`jrrp-${index}`">{{ range }}</label
              ><NInput
                v-model:value="draft.jrrpComments[index]"
                :input-props="{ id: `jrrp-${index}` }"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 5 }"
                :maxlength="100"
                placeholder="留空使用默认评语"
                :disabled="saving"
              />
            </div></div
        ></NCollapseItem>
      </NCollapse>
      <SaveBar :dirty="dirty" :saving="saving" :saved="saved" @save="save" @discard="discard" />
    </PageState>
  </div>
</template>

<style scoped>
.dice-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  flex-wrap: wrap;
}
.dice-heading .section-title {
  margin-bottom: 6px;
}
.dice-rules {
  border: 1px solid var(--c-border);
  background: var(--c-panel);
  border-radius: 12px;
  padding: 8px 22px;
}
.dice-rules :deep(.n-collapse-item) {
  padding: 15px 0;
}
.rule-description {
  margin-bottom: 20px;
}
.rule-commands {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.rule-command-count {
  font-size: 11px;
}
.template-group {
  padding: 20px 0;
  border-top: 1px solid var(--c-border);
}
.template-field {
  margin-top: 16px;
}
.template-field > label {
  font-size: 13px;
}
.levels-grid,
.insanity-grid,
.jrrp-grid {
  margin: 18px 0 24px;
}
.template-group .section-title {
  font-size: 14px;
}
@media (max-width: 600px) {
  .dice-rules {
    padding: 8px 16px;
  }
  .rule-command-count {
    display: none;
  }
}
</style>
