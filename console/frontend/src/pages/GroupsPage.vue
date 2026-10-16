<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import {
  NAlert,
  NButton,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NInput,
  NSelect,
  NTag,
  type DataTableColumns
} from 'naive-ui'
import PageHeader from '../components/PageHeader.vue'
import PageState from '../components/PageState.vue'
import IdentityLabel from '../components/IdentityLabel.vue'
import { botLabel } from '../lib/identities'
import { api } from '../lib/api'
import { count, useOpsResource, type Group } from '../lib/operations'
import { groupAdminModules } from '../lib/groupAdminState'

const groups = useOpsResource(
  (signal) => api<{ groups: Group[] }>('/api/groups', { signal }),
  60000
)
const route = useRoute()
const query = ref(String(route.query.group || ''))
watch(
  () => route.query.group,
  (value) => {
    query.value = String(value || '')
  }
)
const filter = ref('all')
const detailId = ref('')
const drawerOpen = ref(false)
const all = computed(() => groups.data.value?.groups || [])
const filtered = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  return all.value.filter(
    (group) =>
      (!search ||
        `${group.id} ${group.name || ''} ${group.bots.map((qq) => botLabel(qq)).join(' ')}`
          .toLocaleLowerCase()
          .includes(search)) &&
      (filter.value === 'all' ||
        (filter.value === 'allowed' && group.whitelisted) ||
        (filter.value === 'outside' && !group.whitelisted) ||
        (filter.value === 'active' && group.today.recv + group.today.send > 0))
  )
})
const detail = computed(() => all.value.find((group) => group.id === detailId.value))
const activeCount = computed(
  () => all.value.filter((group) => group.today.recv + group.today.send > 0).length
)
const allowedCount = computed(() => all.value.filter((group) => group.whitelisted).length)
function adminLabels(group: Group) {
  return groupAdminModules
    .filter((module) => group.groupAdmin?.[module.id])
    .map((module) => module.label)
}
const columns: DataTableColumns<Group> = [
  {
    title: '群聊',
    key: 'id',
    width: 340,
    render: (group) =>
      h('div', { class: 'group-identity' }, [
        h(
          NButton,
          { text: true, class: 'group-id', onClick: () => openDetail(group) },
          { default: () => group.id }
        ),
        h(
          'span',
          {
            class: ['group-name', { muted: !group.name?.trim() }],
            title: groupName(group)
          },
          groupName(group)
        )
      ])
  },
  {
    title: '白名单',
    key: 'whitelisted',
    width: 125,
    render: (group) =>
      h(
        NTag,
        { type: group.whitelisted ? 'success' : 'warning', size: 'small', bordered: false },
        { default: () => (group.whitelisted ? '已允许' : '白名单外') }
      )
  },
  {
    title: '群管理',
    key: 'groupAdmin',
    width: 190,
    render: (group) =>
      h('div', { class: 'group-admin-status' }, [
        h(
          'span',
          { class: adminLabels(group).length ? '' : 'muted' },
          adminLabels(group).join(' / ') || '未启用'
        ),
        group.groupAdmin?.customized ? h('small', { class: 'muted' }, '本群自定义') : null
      ])
  },
  {
    title: '今日收信',
    key: 'recv',
    width: 110,
    sorter: (a, b) => a.today.recv - b.today.recv,
    render: (group) => count(group.today.recv)
  },
  {
    title: '今日发送',
    key: 'send',
    width: 110,
    sorter: (a, b) => a.today.send - b.today.send,
    render: (group) => count(group.today.send)
  },
  {
    title: '活跃机器人',
    key: 'bots',
    minWidth: 180,
    render: (group) =>
      group.bots.length
        ? h(
            'div',
            { class: 'group-bot-links' },
            group.bots.map((qq) =>
              h(
                RouterLink,
                { to: `/bot/${qq}` },
                { default: () => h(IdentityLabel, { kind: 'bot', id: qq }) }
              )
            )
          )
        : h('span', { class: 'muted' }, '今日无活动记录')
  },
  {
    title: '',
    key: 'actions',
    width: 160,
    render: (group) =>
      h('div', { class: 'group-row-actions' }, [
        h(RouterLink, { to: `/group-admin?group=${group.id}` }, { default: () => '群管理' }),
        h(
          NButton,
          { text: true, size: 'small', onClick: () => openDetail(group) },
          { default: () => '详情 →' }
        )
      ])
  }
]
function groupName(group: Group) {
  return group.name?.trim() || '群名未获取'
}
function openDetail(group: Group) {
  detailId.value = group.id
  drawerOpen.value = true
}
let openedRouteGroup = ''
watch(
  [() => route.query.group, all],
  ([id]) => {
    const requested = String(id || '')
    if (!requested) {
      openedRouteGroup = ''
      return
    }
    if (openedRouteGroup === requested) return
    const group = all.value.find((item) => item.id === requested)
    if (group) {
      openDetail(group)
      openedRouteGroup = requested
    }
  },
  { immediate: true }
)
const filterOptions = [
  { label: '全部群聊', value: 'all' },
  { label: '白名单内', value: 'allowed' },
  { label: '白名单外', value: 'outside' },
  { label: '今日活跃', value: 'active' }
]
</script>

<template>
  <div class="page-stack">
    <PageHeader
      title="群聊"
      eyebrow="日常运营"
      description="检查服务范围与今日活跃情况，沿群聊找到正在工作的机器人。"
      ><template #actions
        ><NButton :loading="groups.loading.value" @click="groups.refresh">刷新群聊</NButton
        ><RouterLink to="/group-admin"><NButton secondary>群管理</NButton></RouterLink
        ><RouterLink to="/conversation"
          ><NButton secondary>管理服务范围</NButton></RouterLink
        ></template
      ></PageHeader
    >
    <div class="group-overview">
      <div>
        <span>已发现群聊</span><strong>{{ groups.data.value ? count(all.length) : '—' }}</strong>
      </div>
      <div>
        <span>白名单内</span><strong>{{ groups.data.value ? count(allowedCount) : '—' }}</strong>
      </div>
      <div>
        <span>今日活跃</span><strong>{{ groups.data.value ? count(activeCount) : '—' }}</strong>
      </div>
      <p class="field-help">
        列表来自白名单、群管理配置与今日消息活动。活跃机器人仅代表今日有收发记录的账号。
      </p>
    </div>
    <section class="panel groups-panel">
      <div class="group-toolbar">
        <div class="group-filters">
          <NInput
            v-model:value="query"
            clearable
            placeholder="搜索群名、群号、机器人昵称或 QQ"
            aria-label="搜索群聊"
          /><NSelect v-model:value="filter" :options="filterOptions" aria-label="按群聊状态筛选" />
        </div>
        <span class="muted"
          >{{ filtered.length }} 个结果<span v-if="groups.updatedAt.value">
            · {{ groups.updatedAt.value }} 更新</span
          ></span
        >
      </div>
      <NAlert v-if="groups.error.value && groups.data.value" type="warning" :bordered="false"
        >刷新失败，当前展示上次同步的数据：{{ groups.error.value }}</NAlert
      ><PageState
        :loading="groups.loading.value && !groups.data.value"
        :error="!groups.data.value ? groups.error.value : null"
        :empty="!!groups.data.value && !filtered.length"
        :empty-text="
          all.length
            ? '没有匹配的群聊，试试其他搜索词或筛选。'
            : '暂无白名单、群管理配置或今日群聊活动记录。'
        "
        @retry="groups.refresh"
        ><NDataTable
          :columns="columns"
          :data="filtered"
          :row-key="(group: Group) => group.id"
          :bordered="false"
          :single-line="false"
          :scroll-x="1215"
          :pagination="filtered.length > 20 ? { pageSize: 20 } : false"
      /></PageState>
    </section>
    <NDrawer v-model:show="drawerOpen" :width="'min(440px, 100vw)'" placement="right"
      ><NDrawerContent :title="`群聊 ${detailId}`" closable
        ><div v-if="detail" class="page-stack">
          <p class="drawer-group-name" :class="{ muted: !detail.name?.trim() }">
            {{ groupName(detail) }}
          </p>
          <NTag :type="detail.whitelisted ? 'success' : 'warning'" size="small">{{
            detail.whitelisted ? '已加入白名单' : '白名单外'
          }}</NTag>
          <section class="drawer-section">
            <h3 class="section-title">今日消息</h3>
            <dl class="group-facts">
              <div>
                <dt>收信</dt>
                <dd>{{ count(detail.today.recv) }}</dd>
              </div>
              <div>
                <dt>发送</dt>
                <dd>{{ count(detail.today.send) }}</dd>
              </div>
            </dl>
          </section>
          <section class="drawer-section">
            <h3 class="section-title">活跃机器人</h3>
            <p class="field-help">以下账号今天在这个群中有消息活动。</p>
            <p v-if="!detail.bots.length" class="muted">暂无今日机器人活动。</p>
            <div class="drawer-bots">
              <RouterLink
                v-for="qq in detail.bots"
                :key="qq"
                :to="`/bot/${qq}`"
                @click="drawerOpen = false"
                ><IdentityLabel kind="bot" :id="qq" /> <span>查看账号 →</span></RouterLink
              >
            </div>
          </section>
          <section class="drawer-section">
            <h3 class="section-title">群聊配置</h3>
            <p class="field-help">入群验证、广告与刷屏、欢迎通知均可在本群管理中配置。</p>
            <div class="drawer-admin-status">
              <NTag
                v-for="module in groupAdminModules"
                :key="module.id"
                :type="detail.groupAdmin?.[module.id] ? 'success' : 'default'"
                size="small"
                :bordered="false"
                >{{ module.label }} ·
                {{ detail.groupAdmin?.[module.id] ? '已启用' : '未启用' }}</NTag
              ><NTag v-if="detail.groupAdmin?.customized" size="small" :bordered="false" type="info"
                >本群自定义</NTag
              >
            </div>
            <div class="drawer-links">
              <RouterLink :to="`/group-admin?group=${detail.id}`" @click="drawerOpen = false"
                >配置本群管理 →</RouterLink
              >
              <RouterLink to="/conversation" @click="drawerOpen = false">管理服务范围 →</RouterLink
              ><RouterLink to="/persona" @click="drawerOpen = false">管理人设覆盖 →</RouterLink>
            </div>
          </section>
        </div>
        <p v-else class="muted">这个群聊已不在当前查询结果中。</p></NDrawerContent
      ></NDrawer
    >
  </div>
</template>

<style scoped>
.group-admin-status {
  display: grid;
  gap: 3px;
  font-size: 12px;
}
.group-row-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
}
.drawer-admin-status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0;
}
.group-overview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(220px, 1.5fr);
  gap: 20px;
  padding: 24px;
  border: 1px solid var(--c-border);
  border-radius: 14px;
  background: var(--c-panel);
  align-items: center;
}
.group-overview > div {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.group-overview span {
  color: var(--c-muted);
  font-size: 12px;
}
.group-overview strong {
  font-size: 27px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.group-overview p {
  margin: 0;
}
.groups-panel {
  padding: 24px;
  overflow: hidden;
}
.group-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
  flex-wrap: wrap;
}
.group-toolbar > .muted {
  font-size: 12px;
}
.group-filters {
  display: flex;
  gap: 10px;
  flex: 1;
  max-width: 520px;
  min-width: 0;
}
.group-filters .n-input {
  flex: 1;
}
.group-filters .n-select {
  width: 150px;
  flex-shrink: 0;
}
:deep(.group-identity) {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
:deep(.group-id) {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
:deep(.group-name) {
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.drawer-group-name {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
:deep(.group-bot-links) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}
:deep(.group-bot-links a) {
  color: var(--c-accent);
  text-decoration: none;
  font-size: 12px;
}
.drawer-section {
  padding: 20px 0;
  border-bottom: 1px solid var(--c-border);
}
.group-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin: 20px 0 0;
}
.group-facts dt {
  color: var(--c-muted);
  font-size: 12px;
}
.group-facts dd {
  margin: 6px 0 0;
  font-size: 28px;
}
.drawer-bots {
  display: grid;
  gap: 8px;
}
.drawer-bots a {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  text-decoration: none;
  font-size: 13px;
  color: var(--c-accent);
}
.drawer-bots a > span:last-child {
  font-size: 12px;
}
.drawer-links {
  display: grid;
  gap: 14px;
}
.drawer-links a {
  color: var(--c-accent);
  font-size: 13px;
  text-decoration: none;
}
@media (max-width: 850px) {
  .group-overview {
    grid-template-columns: repeat(3, 1fr);
  }
  .group-overview p {
    grid-column: 1 / -1;
  }
}
@media (max-width: 500px) {
  .groups-panel,
  .group-overview {
    padding: 18px;
  }
  .group-overview {
    gap: 12px;
  }
  .group-overview strong {
    font-size: 23px;
  }
  .group-filters {
    flex-basis: 100%;
    flex-wrap: wrap;
  }
  .group-filters .n-input {
    flex-basis: 100%;
  }
  .group-filters .n-select {
    width: 100%;
  }
}
</style>
