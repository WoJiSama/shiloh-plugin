<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { onBeforeRouteUpdate, RouterLink, useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NDataTable, NInput, NSelect, NTag, type DataTableColumns } from 'naive-ui'
import { UserRoundCog, ArrowLeft, Settings2 } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import GroupAdminEditor from '../components/GroupAdminEditor.vue'
import SchemaPage from './SchemaPage.vue'
import { api } from '../lib/api'
import { groupAdminModules, validGroupId } from '../lib/groupAdminState'
import { useOpsResource, type Group } from '../lib/operations'
import { confirmLeave } from '../composables/useUnsavedGuard'

const defaultEditor = ref<InstanceType<typeof SchemaPage> | null>(null)
const route = useRoute()
const router = useRouter()
const resources = useOpsResource(
  (signal) => api<{ groups: Group[] }>('/api/groups', { signal }),
  60000
)
const all = computed(() => resources.data.value?.groups || [])
const groupId = computed(() => (typeof route.query.group === 'string' ? route.query.group : ''))
const defaults = computed(() => route.query.scope === 'defaults' && !groupId.value)
const selectedGroup = computed(() => all.value.find((group) => group.id === groupId.value))
const manualId = ref('')
const inputError = ref('')
const search = ref('')
const groupOptions = computed(() =>
  all.value.map((group) => ({
    value: group.id,
    label: group.name?.trim() ? `${group.name} · ${group.id}` : group.id
  }))
)
const filtered = computed(() => {
  const q = search.value.trim().toLocaleLowerCase()
  return all.value.filter(
    (group) => !q || `${group.id} ${group.name || ''}`.toLocaleLowerCase().includes(q)
  )
})
const configuredCount = computed(
  () =>
    all.value.filter((group) => groupAdminModules.some((module) => group.groupAdmin?.[module.id]))
      .length
)
const customizedCount = computed(
  () => all.value.filter((group) => group.groupAdmin?.customized).length
)
function openGroup(value: string) {
  const id = value.trim()
  if (!validGroupId(id)) {
    inputError.value = '群号需要填写 4 至 12 位数字'
    return
  }
  inputError.value = ''
  void router.push({ path: '/group-admin', query: { group: id } })
}
// The app-level guard covers different paths. Query changes within this page also change drafts.
onBeforeRouteUpdate((to, from) => {
  if (to.path !== from.path) return true
  const next = typeof to.query.group === 'string' ? to.query.group : ''
  const previous = typeof from.query.group === 'string' ? from.query.group : ''
  const nextDefaults = to.query.scope === 'defaults' && !next
  const previousDefaults = from.query.scope === 'defaults' && !previous
  if (next !== previous || nextDefaults !== previousDefaults) return confirmLeave()
  return true
})
const columns: DataTableColumns<Group> = [
  {
    title: '群聊',
    key: 'id',
    minWidth: 220,
    render: (group) =>
      h('div', { class: 'admin-group-name' }, [
        h('strong', group.name?.trim() || '群名未获取'),
        h('span', { class: 'muted' }, group.id)
      ])
  },
  ...groupAdminModules.map((module) => ({
    title: module.label,
    key: module.id,
    width: module.id === 'groupModeration' ? 145 : 125,
    render: (group: Group) =>
      h(
        NTag,
        {
          size: 'small',
          bordered: false,
          type: group.groupAdmin?.[module.id] ? 'success' : 'default'
        },
        { default: () => (group.groupAdmin?.[module.id] ? '已启用' : '未启用') }
      )
  })),
  {
    title: '策略',
    key: 'customized',
    width: 130,
    render: (group) =>
      h('span', { class: 'muted' }, group.groupAdmin?.customized ? '本群自定义' : '默认参数')
  },
  {
    title: '',
    key: 'actions',
    width: 100,
    render: (group) =>
      h(
        NButton,
        { text: true, size: 'small', onClick: () => openGroup(group.id) },
        { default: () => '配置本群 →' }
      )
  }
]
</script>

<template>
  <div class="page-stack group-admin-page">
    <PageHeader
      title="群管理"
      eyebrow="日常运营"
      description="统一管理入群验证、广告与刷屏处理、欢迎与退群通知，为每个群选择合适的策略。"
    >
      <template #actions
        ><NButton
          v-if="defaults"
          secondary
          :disabled="defaultEditor?.saving || defaultEditor?.loading"
          @click="defaultEditor?.reload()"
          >刷新默认策略</NButton
        ><RouterLink to="/groups"><NButton secondary>查看群聊</NButton></RouterLink></template
      >
    </PageHeader>
    <nav class="admin-scope-nav" aria-label="群管理配置范围">
      <RouterLink to="/group-admin" :class="{ active: !defaults }"
        ><UserRoundCog :size="17" />按群配置</RouterLink
      >
      <RouterLink to="/group-admin?scope=defaults" :class="{ active: defaults }"
        ><Settings2 :size="17" />默认策略</RouterLink
      >
    </nav>
    <template v-if="defaults">
      <NAlert type="info" :show-icon="false" title="先设置总开关，再按群启用">
        总开关控制所有群的对应能力；每个群仍需单独启用。修改默认参数会同步用于继承默认的群，本群自定义参数继续保留。
      </NAlert>
      <SchemaPage ref="defaultEditor" kind="groupAdmin" embedded />
    </template>
    <template v-else>
      <section class="panel group-picker-panel">
        <div class="panel-heading">
          <div>
            <h2>选择要管理的群</h2>
            <p>从现有群聊中选择，也可以输入群号，为尚无消息活动的群提前配置。</p>
          </div>
        </div>
        <div class="group-picker-grid">
          <div class="form-field">
            <label for="group-admin-select">现有群聊</label>
            <NSelect
              :value="selectedGroup ? groupId : null"
              :options="groupOptions"
              filterable
              clearable
              placeholder="搜索群名或群号"
              :input-props="{ id: 'group-admin-select' }"
              aria-label="选择群聊"
              @update:value="
                (value) => (value ? openGroup(String(value)) : router.push('/group-admin'))
              "
            />
          </div>
          <form class="form-field" @submit.prevent="openGroup(manualId)">
            <label for="group-admin-id">输入群号</label>
            <div class="manual-group-input">
              <NInput
                v-model:value="manualId"
                :input-props="{ id: 'group-admin-id', inputmode: 'numeric', maxlength: 12 }"
                placeholder="4 至 12 位群号"
                aria-label="输入群号"
                @update:value="inputError = ''"
              /><NButton attr-type="submit" secondary>配置本群</NButton>
            </div>
          </form>
        </div>
        <p v-if="inputError" class="input-error" role="alert">{{ inputError }}</p>
        <p v-if="resources.error.value" class="field-help">
          群聊列表暂时无法刷新：{{ resources.error.value }}。仍可输入群号配置。
        </p>
      </section>
      <template v-if="groupId && validGroupId(groupId)">
        <div class="selected-group-heading">
          <div>
            <span class="eyebrow">正在配置本群</span>
            <h2>{{ selectedGroup?.name?.trim() || `群 ${groupId}` }}</h2>
            <p class="muted">
              {{ groupId
              }}<span v-if="!selectedGroup"> · 尚未出现在群聊列表，保存后会纳入管理</span>
            </p>
          </div>
          <div class="selected-group-actions">
            <RouterLink :to="`/groups?group=${groupId}`"
              ><NButton secondary>查看群聊详情 →</NButton></RouterLink
            ><RouterLink to="/group-admin"
              ><NButton quaternary
                ><template #icon><ArrowLeft :size="16" /></template>返回群列表</NButton
              ></RouterLink
            >
          </div>
        </div>
        <GroupAdminEditor :key="groupId" :group-id="groupId" @saved="resources.refresh" />
      </template>
      <NAlert v-else-if="groupId" type="error" :show-icon="false"
        >群号需要填写 4 至 12 位数字，请重新选择或输入。</NAlert
      >
      <template v-else>
        <div class="admin-overview">
          <div>
            <span>已发现群聊</span><strong>{{ all.length }}</strong>
          </div>
          <div>
            <span>群管已生效</span><strong>{{ configuredCount }}</strong>
          </div>
          <div>
            <span>本群自定义</span><strong>{{ customizedCount }}</strong>
          </div>
          <p>功能状态同时取决于默认策略总开关与本群启用状态。</p>
        </div>
        <section class="panel admin-groups-panel">
          <div class="admin-list-toolbar">
            <NInput
              v-model:value="search"
              clearable
              placeholder="搜索群名或群号"
              aria-label="搜索群管理列表"
            /><NButton :loading="resources.loading.value" @click="resources.refresh"
              >刷新列表</NButton
            >
          </div>
          <PageState
            :loading="resources.loading.value && !resources.data.value"
            :error="!resources.data.value ? resources.error.value : ''"
            :empty="!!resources.data.value && !filtered.length"
            :empty-text="
              all.length ? '没有匹配的群聊，试试其他搜索词。' : '暂无群聊，输入群号即可开始配置。'
            "
            @retry="resources.refresh"
            ><NDataTable
              :columns="columns"
              :data="filtered"
              :row-key="(group: Group) => group.id"
              :bordered="false"
              :single-line="false"
              :scroll-x="845"
              :pagination="filtered.length > 20 ? { pageSize: 20 } : false"
          /></PageState>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.group-admin-page {
  max-width: 1180px;
}
.admin-scope-nav {
  display: flex;
  gap: 5px;
  padding: 5px;
  background: var(--c-soft);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  width: fit-content;
}
.admin-scope-nav a {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 9px 22px;
  border-radius: 7px;
  color: var(--c-muted);
  font-size: 13px;
}
.admin-scope-nav a.active {
  background: var(--c-panel);
  color: var(--c-text);
  box-shadow: 0 1px 4px #0001;
}
.group-picker-panel h2 {
  font-size: 15px;
}
.group-picker-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px 28px;
}
.group-picker-grid label {
  font-size: 12px;
  color: var(--c-muted);
}
.manual-group-input {
  display: flex;
  gap: 10px;
}
.input-error {
  color: var(--c-danger);
  font-size: 12px;
  margin-top: 10px;
}
.group-picker-panel > .field-help {
  margin-top: 12px;
}
.selected-group-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
}
.selected-group-heading .eyebrow {
  display: block;
  margin-bottom: 4px;
}
.selected-group-heading h2 {
  font-size: 21px;
}
.selected-group-heading p {
  font-size: 12px;
  margin-top: 4px;
}
.selected-group-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.admin-overview {
  display: flex;
  align-items: center;
  gap: 36px;
  padding: 2px 0;
}
.admin-overview > div {
  display: grid;
  gap: 4px;
  flex-shrink: 0;
}
.admin-overview span {
  font-size: 12px;
  color: var(--c-muted);
}
.admin-overview strong {
  font-size: 23px;
  font-weight: 550;
}
.admin-overview p {
  font-size: 12px;
  color: var(--c-muted);
  margin-left: auto;
  max-width: 30ch;
}
.admin-groups-panel {
  padding: 0;
  overflow: hidden;
}
.admin-list-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 18px 20px;
}
.admin-list-toolbar > :first-child {
  max-width: 340px;
}
.admin-groups-panel :deep(.n-data-table-th) {
  font-size: 12px;
}
.admin-groups-panel :deep(.admin-group-name) {
  display: grid;
  gap: 3px;
}
.admin-groups-panel :deep(.admin-group-name strong) {
  font-weight: 500;
  font-size: 13px;
}
.admin-groups-panel :deep(.admin-group-name span) {
  font-size: 12px;
}
@media (max-width: 736px) {
  .group-picker-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .admin-overview {
    gap: 24px;
    flex-wrap: wrap;
  }
  .admin-overview p {
    margin-left: 0;
    max-width: none;
    width: 100%;
  }
  .group-picker-panel {
    padding: 18px 16px;
  }
  .admin-scope-nav {
    width: 100%;
  }
  .admin-scope-nav a {
    flex: 1;
    padding: 9px 12px;
  }
}
</style>
