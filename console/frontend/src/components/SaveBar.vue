<script setup lang="ts">
import { NButton } from 'naive-ui'
import { Check, Save } from 'lucide-vue-next'
defineProps<{ dirty: number; saving?: boolean; disabled?: boolean; saved?: string }>()
defineEmits<{ save: []; discard: [] }>()
</script>
<template>
  <footer v-if="dirty || saving || saved" class="save-bar">
    <div class="save-bar-status" aria-live="polite">
      <span v-if="dirty" class="draft-dot" /><Check v-else :size="15" aria-hidden="true" />
      <div>
        <strong>{{ dirty ? `${dirty} 项未保存修改` : '无未保存修改' }}</strong
        ><small v-if="saved">{{ saved }}</small
        ><small v-else>修改仅在保存后写入配置</small>
      </div>
    </div>
    <div class="save-bar-actions">
      <NButton :disabled="!dirty || saving" @click="$emit('discard')">放弃修改</NButton
      ><NButton
        type="primary"
        :loading="saving"
        :disabled="!dirty || disabled"
        @click="$emit('save')"
        ><template #icon><Save :size="16" /></template>保存修改</NButton
      >
    </div>
  </footer>
</template>
