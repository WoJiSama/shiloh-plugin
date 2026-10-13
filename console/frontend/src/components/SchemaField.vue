<script setup lang="ts">
import { clientId as newClientId } from '../lib/clientId'

import { computed, toRaw } from 'vue'
import IdentityLabel from './IdentityLabel.vue'
import { fieldIdentityKind } from '../lib/identities'
import {
  NSelect,
  NInput,
  NInputNumber,
  NSwitch,
  NDynamicTags,
  NButton,
  NRadioGroup,
  NRadioButton,
  NAlert
} from 'naive-ui'
import {
  defaultValue,
  describeUnit,
  type SchemaFieldDefinition,
  type SecretDraft
} from '../lib/schemaState'

defineOptions({ name: 'SchemaField' })
const props = defineProps<{ field: SchemaFieldDefinition; modelValue: any; applyHint?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: any] }>()
const id = computed(() => `field-${props.field.field.replace(/[^a-zA-Z0-9_-]/g, '-')}`)
const identityKind = computed(() => fieldIdentityKind(props.field.field))
const identityValues = computed(() =>
  (Array.isArray(props.modelValue) ? props.modelValue : [props.modelValue])
    .map((value) => String(value ?? '').trim())
    .filter((value) => /^\d+$/.test(value))
)
const rows = computed<Record<string, any>[]>(() =>
  Array.isArray(props.modelValue) ? props.modelValue : []
)
const tags = computed<string[]>(() => (Array.isArray(props.modelValue) ? props.modelValue : []))
const secret = computed<SecretDraft>(() =>
  props.modelValue?.action ? props.modelValue : { action: 'keep', value: '' }
)
const unit = computed(() => describeUnit(props.field))
const isSecret = computed(() => props.field.secret || props.field.component === 'InputPassword')
const supported = [
  'Select',
  'Switch',
  'Input',
  'InputNumber',
  'InputTextArea',
  'InputPassword',
  'GTags',
  'GSubForm'
]
const constraints = computed(() => {
  const values: string[] = []
  if (props.field.props?.min !== undefined) values.push(`最小 ${props.field.props.min}`)
  if (props.field.props?.max !== undefined) values.push(`最大 ${props.field.props.max}`)
  if (props.field.props?.step !== undefined) values.push(`步长 ${props.field.props.step}`)
  return values.join(' · ')
})
const rowIds = new WeakMap<object, string>()
function rowKey(row: object) {
  const raw = toRaw(row)
  if (!rowIds.has(raw)) rowIds.set(raw, newClientId())
  return rowIds.get(raw)!
}
function updateRow(index: number, field: string, value: any) {
  const next = [...rows.value]
  const row = { ...next[index], [field]: value }
  rowIds.set(row, rowKey(next[index]))
  next[index] = row
  emit('update:modelValue', next)
}
function addRow() {
  const next = Object.fromEntries(
    (props.field.subFields || []).map((sub) => [sub.field, defaultValue(sub.component)])
  )
  emit('update:modelValue', [...rows.value, next])
}
function updateSecretAction(action: SecretDraft['action']) {
  emit('update:modelValue', { action, value: action === 'replace' ? secret.value.value : '' })
}
</script>

<template>
  <div
    class="form-field schema-field"
    :class="{
      'field-full':
        field.component === 'GSubForm' || field.component === 'InputTextArea' || isSecret,
      'switch-field': field.component === 'Switch'
    }"
  >
    <div class="field-label">
      <label :for="id"
        >{{ field.label }}<span v-if="field.required" class="required"> *</span></label
      ><span v-if="unit" class="unit">{{ unit }}</span>
    </div>
    <NSelect
      v-if="field.component === 'Select'"
      :value="modelValue"
      :options="field.props?.options || []"
      :input-props="{ id }"
      :aria-label="field.label"
      @update:value="emit('update:modelValue', $event)"
    />
    <template v-else-if="isSecret">
      <div class="credential-status">
        {{ field.configured ? '已配置凭据 · 内容不会回显' : '尚未配置凭据' }}
      </div>
      <NRadioGroup
        :value="secret.action"
        size="small"
        :name="id"
        :aria-label="field.label + '处理方式'"
        @update:value="updateSecretAction"
      >
        <NRadioButton value="keep">保持现有</NRadioButton
        ><NRadioButton value="replace">替换凭据</NRadioButton
        ><NRadioButton value="clear">清除凭据</NRadioButton>
      </NRadioGroup>
      <NInput
        v-if="secret.action === 'replace'"
        :input-props="{ id, autocomplete: 'new-password', 'aria-describedby': id + '-help' }"
        type="password"
        show-password-on="click"
        :value="secret.value"
        :placeholder="field.props?.placeholder || '输入新的凭据'"
        @update:value="(value) => emit('update:modelValue', { action: 'replace', value })"
      />
      <p v-else-if="secret.action === 'clear'" class="secret-warning">
        保存时将删除现有凭据。平台访问会回退到匿名状态。
      </p>
    </template>
    <NSwitch
      v-else-if="field.component === 'Switch'"
      :value="modelValue === true"
      :aria-label="field.label"
      :id="id"
      @update:value="(value) => emit('update:modelValue', value)"
    />
    <NInputNumber
      v-else-if="field.component === 'InputNumber'"
      :value="modelValue === null || modelValue === '' ? null : Number(modelValue)"
      :min="field.props?.min"
      :max="field.props?.max"
      :step="field.props?.step || 1"
      :placeholder="field.props?.placeholder"
      :input-props="{ id, 'aria-describedby': id + '-help' }"
      @update:value="(value) => emit('update:modelValue', value)"
    />
    <NInput
      v-else-if="field.component === 'Input' || field.component === 'InputTextArea'"
      :type="field.component === 'InputTextArea' ? 'textarea' : 'text'"
      :autosize="field.component === 'InputTextArea' ? { minRows: 3, maxRows: 8 } : undefined"
      :value="String(modelValue ?? '')"
      :placeholder="field.props?.placeholder"
      :input-props="{ id, 'aria-describedby': id + '-help' }"
      @update:value="(value) => emit('update:modelValue', value)"
    />
    <NDynamicTags
      v-else-if="field.component === 'GTags'"
      :value="tags"
      :input-props="{ placeholder: '输入后按回车' }"
      :aria-label="field.label"
      @update:value="(value: string[]) => emit('update:modelValue', value)"
    />
    <div v-else-if="field.component === 'GSubForm'" class="subform">
      <div v-for="(row, index) in rows" :key="rowKey(row)" class="subform-row">
        <div class="subform-row-heading">
          <span>第 {{ index + 1 }} 项</span
          ><NButton
            size="tiny"
            quaternary
            type="error"
            :aria-label="`删除${field.label}第${index + 1}项`"
            @click="
              emit(
                'update:modelValue',
                rows.filter((_, i) => i !== index)
              )
            "
            >删除</NButton
          >
        </div>
        <div class="field-grid">
          <SchemaField
            v-for="sub in field.subFields || []"
            :key="sub.field"
            :field="{ ...sub, field: `${field.field}-${index}-${sub.field}` }"
            :model-value="row[sub.field]"
            @update:model-value="(value) => updateRow(index, sub.field, value)"
          />
        </div>
      </div>
      <p v-if="!rows.length" class="muted empty-rows">还没有条目</p>
      <NButton size="small" secondary @click="addRow">添加{{ field.label }}</NButton>
    </div>
    <NAlert v-else-if="!supported.includes(field.component)" type="error" :show-icon="false"
      >不支持的字段组件：{{ field.component }}，请更新控制台。</NAlert
    >
    <div v-if="identityKind && identityValues.length" class="identity-hints">
      <IdentityLabel
        v-for="value in identityValues"
        :key="value"
        :kind="identityKind"
        :id="value"
      />
    </div>
    <div :id="id + '-help'" class="field-help">
      <p v-if="field.help">{{ field.help }}</p>
      <span v-if="constraints">{{ constraints }}</span
      ><span v-if="applyHint" class="apply-hint">{{ applyHint }}</span>
    </div>
  </div>
</template>

<style scoped>
.identity-hints {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.schema-field {
  min-width: 0;
  gap: 9px;
  display: flex;
  flex-direction: column;
}
.schema-field :deep(.n-space > div) {
  min-width: 0;
  max-width: 100%;
}
.schema-field :deep(.n-tag) {
  max-width: 100%;
  height: auto;
  min-height: var(--n-height);
  white-space: normal;
  line-height: 1.6;
  padding-top: 4px;
  padding-bottom: 4px;
}
.schema-field :deep(.n-tag__content) {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
.field-full {
  grid-column: 1 / -1;
}
.field-label {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  font-weight: 550;
}
.required,
.secret-warning {
  color: var(--c-danger);
}
.unit {
  color: var(--c-muted);
  font-size: 11px;
  font-weight: 400;
}
.switch-field {
  position: relative;
  padding: 0 58px 0 0;
}
.switch-field :deep(.n-switch) {
  position: absolute;
  right: 0;
  top: 0;
}
.field-help {
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-muted);
}
.field-help p {
  margin: 0;
}
.apply-hint {
  display: block;
  margin-top: 3px;
  color: var(--c-muted);
  font-size: 11px;
}
.credential-status {
  color: var(--c-muted);
  font-size: 12px;
}
.secret-warning {
  margin: 0;
  font-size: 12px;
}
.subform {
  display: grid;
  gap: 12px;
  justify-items: start;
}
.subform-row {
  width: 100%;
  box-sizing: border-box;
  padding: 16px;
  border: 1px solid var(--c-border);
  background: rgba(255, 255, 255, 0.015);
  border-radius: 10px;
}
.subform-row-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  color: var(--c-muted);
  font-size: 12px;
}
.empty-rows {
  font-size: 12px;
  margin: 0;
}
@media (max-width: 560px) {
  .subform-row {
    padding: 12px;
  }
  .schema-field :deep(.n-radio-group) {
    display: flex;
    flex-wrap: wrap;
  }
}
</style>
