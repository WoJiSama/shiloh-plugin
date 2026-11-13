<script setup lang="ts">
import type { CharacterProfile } from '../../../../../src/contracts/characterProfile'
defineProps<{ refs: string[]; evidence?: CharacterProfile['evidence'] }>()

const kinds = { message: '本群消息', memory: '角色记录', receipt: '行动回执' }
const statuses: Record<string, string> = { succeeded: '已确认', failed: '失败', unknown: '结果未知', pending: '待确认' }
const date = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false })
</script>

<template>
  <details v-if="refs.length" class="evidence">
    <summary>查看 {{ refs.length }} 条依据</summary>
    <ul>
      <li v-for="ref in refs" :key="ref">
        <template v-if="evidence?.[ref]">
          <small>{{ kinds[evidence[ref]!.kind] }} · {{ date(evidence[ref]!.at) }}<template v-if="evidence[ref]?.kind === 'receipt'"> · {{ statuses[evidence[ref]!.status] }}</template></small>
          <div>{{ evidence[ref]!.text || '这条消息没有文字内容' }}</div>
        </template>
        <small v-else>{{ ref.startsWith('message:') ? `消息 #${ref.slice(8)} 已不在近期记录中` : '这条依据已不可查看' }}</small>
      </li>
    </ul>
  </details>
</template>

<style scoped>
.evidence { margin-top: 8px; font-size: 13px; }
.evidence summary { cursor: pointer; width: fit-content; }
.evidence ul { list-style: none; padding: 0 0 0 12px; border-inline-start: 2px solid currentColor; margin: 8px 0 0; }
.evidence li + li { margin-top: 8px; }
.evidence small { opacity: .72; }
.evidence li { overflow-wrap: anywhere; }
</style>
