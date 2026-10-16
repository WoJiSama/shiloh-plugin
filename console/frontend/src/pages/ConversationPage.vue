<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NTag } from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import SchemaPage from './SchemaPage.vue'

const tab = ref('conversation')
const trackingVisited = ref(false)
const conversation = ref<InstanceType<typeof SchemaPage> | null>(null)
const tracking = ref<InstanceType<typeof SchemaPage> | null>(null)
const editor = computed(() => (tab.value === 'tracking' ? tracking.value : conversation.value))
const tabs = [
  { id: 'conversation', label: '对话配置' },
  { id: 'tracking', label: '对话追踪' }
]
function selectTab(id: string) {
  if (id === 'tracking') trackingVisited.value = true
  tab.value = id
}
</script>

<template>
  <div class="page-stack conversation-page">
    <PageHeader
      title="对话设置"
      eyebrow="配置中心"
      description="设置触发、访问权限与回复方式，调整追踪和群聊参与策略。"
      ><template #actions
        ><NButton :disabled="editor?.saving || editor?.loading" @click="editor?.reload()"
          >刷新配置</NButton
        ></template
      ></PageHeader
    >
    <nav class="task-tabs" role="tablist" aria-label="对话设置任务分区">
      <button
        v-for="item in tabs"
        :key="item.id"
        role="tab"
        :aria-selected="tab === item.id"
        @click="selectTab(item.id)"
      >
        {{ item.label }}
        <NTag
          v-if="item.id === 'tracking' ? tracking?.dirty : conversation?.dirty"
          type="warning"
          size="small"
          >{{ item.id === 'tracking' ? tracking?.dirty : conversation?.dirty }}</NTag
        >
      </button>
    </nav>
    <SchemaPage v-show="tab === 'conversation'" ref="conversation" kind="conversation" embedded />
    <SchemaPage
      v-if="trackingVisited"
      v-show="tab === 'tracking'"
      ref="tracking"
      kind="tracking"
      embedded
    />
  </div>
</template>

<style scoped>
.conversation-page {
  max-width: 1120px;
}
.task-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 9px;
}
</style>
