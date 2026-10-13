<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { NButton, NAlert } from 'naive-ui'
import { ArrowLeft, ExternalLink } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { imageUrl, api } from '../lib/api'
import PageHeader from '../components/PageHeader.vue'
const router = useRouter(),
  src = ref(imageUrl('/bl-chat/observe/')),
  loading = ref(true),
  failed = ref(false)
let timer: ReturnType<typeof setTimeout>
onMounted(() => {
  timer = setTimeout(() => {
    if (loading.value) failed.value = true
  }, 20000)
})
onBeforeUnmount(() => clearTimeout(timer))
</script>
<template>
  <div class="page-stack">
    <PageHeader title="运行观测明细" description="查看 Yunzai 的完整运行追踪，沿用原有明细工具。"
      ><template #actions
        ><NButton @click="router.push('/observe')"
          ><template #icon><ArrowLeft :size="16" /></template>返回概览</NButton
        ><NButton tag="a" :href="src" target="_blank" rel="noopener"
          ><template #icon><ExternalLink :size="16" /></template>新窗口打开</NButton
        ></template
      ></PageHeader
    ><NAlert v-if="failed" type="warning">明细页面加载较慢，请确认 Yunzai 页面服务是否在线。</NAlert
    ><iframe
      class="embedded-page"
      :src="src + (src.includes('?') ? '&' : '?') + 'embed=1'"
      title="运行观测完整明细"
      @load="loading = false"
    />
  </div>
</template>
<style scoped>
.embedded-page {
  width: 100%;
  min-height: 700px;
  height: calc(100vh - 230px);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  background: var(--c-panel);
}
</style>
