<script setup lang="ts">
import { computed } from 'vue'
import { entityName } from '../lib/identities'
const props = defineProps<{ kind: 'bot' | 'group'; id: string | number; name?: string }>()
const name = computed(() => entityName(props.kind, props.id, props.name))
</script>
<template>
  <span v-if="id" class="identity-label" :data-kind="kind" :data-id="id" :title="id + ' · ' + name">
    <span class="identity-id">{{ id }}</span
    ><span class="identity-name">{{ name }}</span>
  </span>
  <span v-else>—</span>
</template>
<style scoped>
.identity-label {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 8px;
  min-width: 0;
  max-width: 100%;
  text-align: left;
  vertical-align: middle;
}
.identity-id {
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.identity-name {
  color: var(--c-muted);
  font-size: 0.9em;
  overflow-wrap: anywhere;
  min-width: 0;
}
</style>
