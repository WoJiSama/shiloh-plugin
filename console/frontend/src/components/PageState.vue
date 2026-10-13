<script setup lang="ts">
import { NAlert, NButton, NEmpty, NSkeleton } from 'naive-ui'
defineProps<{ loading?: boolean; error?: string | null; empty?: boolean; emptyText?: string }>()
defineEmits<{ retry: [] }>()
</script>
<template>
  <div v-if="loading" class="page-loading" aria-busy="true" aria-label="正在加载">
    <NSkeleton text :repeat="2" /><NSkeleton height="160px" :sharp="false" /><NSkeleton
      height="120px"
      :sharp="false"
    />
  </div>
  <NAlert v-else-if="error" type="error" title="加载失败"
    ><span>{{ error }}</span>
    <div style="margin-top: 12px">
      <NButton size="small" @click="$emit('retry')">重试</NButton>
    </div></NAlert
  >
  <NEmpty v-else-if="empty" :description="emptyText || '暂无数据'" class="page-empty" />
  <slot v-else />
</template>
