<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter, RouterView } from 'vue-router'
import { NButton, NInput, NModal, NDrawer, NDrawerContent, NAlert, useMessage } from 'naive-ui'
import {
  MessagesSquare,
  Search,
  Menu,
  Moon,
  Sun,
  LogOut,
  KeyRound,
  ChevronRight,
  ArrowUpRight,
  X
} from 'lucide-vue-next'
import { api, authState, clearToken } from '../lib/api'
import { useOpsResource } from '../lib/operations'
import {
  identities,
  refreshIdentities,
  clearIdentities,
  botLabel,
  groupLabel
} from '../lib/identities'
import { navigation, pages } from '../lib/navigation'
import { confirmLeave, installUnsavedDialog } from '../composables/useUnsavedGuard'
useOpsResource(refreshIdentities, 60000)
const props = defineProps<{ appearance: string }>()
const build = __CONSOLE_BUILD__
const emit = defineEmits<{ theme: []; logout: [] }>()
const route = useRoute(),
  router = useRouter(),
  message = useMessage()
installUnsavedDialog()
const menuOpen = ref(false),
  searchOpen = ref(false),
  query = ref(''),
  searchInput = ref<InstanceType<typeof NInput> | null>(null)
const accounts = ref<any[]>([]),
  passwordOpen = ref(false),
  passwordBusy = ref(false),
  oldPassword = ref(''),
  newPassword = ref(''),
  passwordError = ref('')
const active = computed(() =>
  pages.find(
    (item) =>
      route.path === item.path ||
      (item.path === '/' && route.path.startsWith('/bot/')) ||
      (item.path === '/observe' && route.path.startsWith('/observe/'))
  )
)
const results = computed(() => {
  const choices = [
    ...pages.map((page) => ({ ...page, hint: page.group })),
    ...accounts.value
      .filter((item) => item.account)
      .map((item) => ({
        path: `/bot/${item.account}`,
        label: botLabel(item.account, item.nickname),
        hint: '机器人账号',
        icon: MessagesSquare
      })),
    ...identities.value.groups.map((group) => ({
      path: '/groups?group=' + group.id,
      label: groupLabel(group.id),
      hint: '群聊',
      icon: MessagesSquare
    }))
  ]
  const q = query.value.trim().toLowerCase()
  return choices.filter((item) => !q || `${item.label} ${item.hint}`.toLowerCase().includes(q))
})
function search() {
  query.value = ''
  searchOpen.value = true
  api('/api/overview/accounts')
    .then((data) => {
      accounts.value = data.accounts || []
    })
    .catch(() => {})
}
function keydown(event: KeyboardEvent) {
  const editing = (event.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"]')
  if (
    ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') ||
    (event.key === '/' && !editing)
  ) {
    event.preventDefault()
    search()
  }
}
async function logout() {
  if (!(await confirmLeave())) return
  try {
    await api('/api/auth/logout', { method: 'POST' })
    clearToken()
    emit('logout')
  } catch (e) {
    message.error((e as Error).message)
  }
}
async function changePassword() {
  if (passwordBusy.value) return
  passwordError.value = ''
  if (newPassword.value.length < 8) {
    passwordError.value = '新密码至少 8 位'
    return
  }
  passwordBusy.value = true
  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: oldPassword.value, newPassword: newPassword.value })
    })
    passwordOpen.value = false
    oldPassword.value = ''
    newPassword.value = ''
    message.success('密码已修改')
  } catch (e) {
    passwordError.value = (e as Error).message
  } finally {
    passwordBusy.value = false
  }
}
function choose(path: string) {
  searchOpen.value = false
  router.push(path)
}
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false
    document.title = `${route.path.startsWith('/bot/') ? '机器人详情' : active.value?.label || '控制台'} · bl-chat`
  },
  { immediate: true }
)
onMounted(() => window.addEventListener('keydown', keydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', keydown)
  clearIdentities()
})
</script>
<template>
  <div class="console-shell">
    <aside class="desktop-sidebar">
      <RouterLink to="/" class="brand"
        ><span class="brand-mark"><MessagesSquare :size="21" /></span
        ><span>bl-chat<small>控制台</small></span></RouterLink
      >
      <nav class="navigation" aria-label="主导航">
        <section v-for="group in navigation" :key="group.label">
          <div class="nav-section">{{ group.label }}</div>
          <RouterLink
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="nav-item"
            :class="{ active: active?.path === item.path }"
            :aria-current="active?.path === item.path ? 'page' : undefined"
            ><component :is="item.icon" :size="18" /><span>{{ item.label }}</span></RouterLink
          >
        </section>
      </nav>
      <div class="sidebar-user">
        <span class="avatar">{{ (authState?.username || 'T').slice(0, 1).toUpperCase() }}</span>
        <div>
          <strong>{{ authState?.username || '令牌模式' }}</strong
          ><small>{{ authState?.username ? '管理员' : '自动化令牌登录' }}</small>
        </div>
        <NButton quaternary circle aria-label="退出登录" @click="logout"
          ><template #icon><LogOut :size="17" /></template
        ></NButton>
      </div>
      <small class="build-info" :title="`构建于 ${build.at}`"
        >构建 {{ build.revision }} · {{ build.at.slice(0, 10) }}</small
      >
    </aside>
    <div class="workspace">
      <header class="workspace-topbar">
        <NButton
          class="mobile-menu-button"
          quaternary
          circle
          aria-label="打开导航"
          @click="menuOpen = true"
          ><template #icon><Menu :size="21" /></template
        ></NButton>
        <div class="breadcrumbs">
          <span>{{ active?.group || '日常运营' }}</span
          ><ChevronRight :size="13" /><strong>{{
            route.path.startsWith('/bot/') ? '机器人详情' : active?.label
          }}</strong>
        </div>
        <div class="topbar-tools">
          <button class="search-trigger" @click="search">
            <Search :size="15" /><span>搜索页面、机器人或群聊</span><kbd>⌘ K</kbd></button
          ><NButton
            quaternary
            circle
            :aria-label="appearance === 'dark' ? '切换浅色主题' : '切换深色主题'"
            @click="emit('theme')"
            ><template #icon
              ><Sun v-if="appearance === 'dark'" :size="17" /><Moon
                v-else
                :size="17" /></template></NButton
          ><NButton
            v-if="authState?.username"
            quaternary
            circle
            aria-label="修改密码"
            @click="passwordOpen = true"
            ><template #icon><KeyRound :size="17" /></template
          ></NButton>
        </div>
      </header>
      <main class="workspace-content" id="main-content">
        <RouterView v-slot="{ Component, route: current }"
          ><component :is="Component" :key="current.path"
        /></RouterView>
      </main>
    </div>
    <NDrawer v-model:show="menuOpen" placement="left" :width="260"
      ><NDrawerContent title="bl-chat 控制台" closable
        ><nav class="navigation" aria-label="移动主导航">
          <section v-for="group in navigation" :key="group.label">
            <div class="nav-section">{{ group.label }}</div>
            <RouterLink
              v-for="item in group.items"
              :key="item.path"
              :to="item.path"
              class="nav-item"
              :class="{ active: active?.path === item.path }"
              @click="menuOpen = false"
              ><component :is="item.icon" :size="18" />{{ item.label }}</RouterLink
            >
          </section>
        </nav>
        <NButton @click="logout">退出登录</NButton></NDrawerContent
      ></NDrawer
    >
    <NModal
      v-model:show="searchOpen"
      preset="card"
      title="快速查找"
      class="search-modal"
      @after-enter="searchInput?.focus()"
      ><NInput
        ref="searchInput"
        v-model:value="query"
        placeholder="搜索页面、机器人或群聊账号…"
        clearable
        ><template #prefix><Search :size="16" /></template
      ></NInput>
      <div class="search-results">
        <button v-for="result in results" :key="result.path" @click="choose(result.path)">
          <component :is="result.icon" :size="17" /><span
            >{{ result.label }}<small>{{ result.hint }}</small></span
          ><ArrowUpRight :size="15" />
        </button>
        <p v-if="!results.length" class="muted">没有匹配结果</p>
      </div></NModal
    >
    <NModal v-model:show="passwordOpen" preset="card" title="修改密码" class="dialog-card"
      ><form class="page-stack" @submit.prevent="changePassword">
        <label class="form-field"
          ><span>当前密码</span
          ><NInput
            v-model:value="oldPassword"
            type="password"
            autocomplete="current-password" /></label
        ><label class="form-field"
          ><span>新密码</span
          ><NInput
            v-model:value="newPassword"
            type="password"
            autocomplete="new-password"
            placeholder="至少 8 位" /></label
        ><NAlert v-if="passwordError" type="error">{{ passwordError }}</NAlert
        ><NButton type="primary" attr-type="submit" :loading="passwordBusy">修改密码</NButton>
      </form></NModal
    >
  </div>
</template>
