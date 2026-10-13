<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  NGlobalStyle,
  darkTheme,
  zhCN,
  dateZhCN
} from 'naive-ui'
import { api, authState } from './lib/api'
import AppShell from './components/AppShell.vue'
import AuthPage from './pages/AuthPage.vue'
import PageState from './components/PageState.vue'
const loading = ref(true),
  error = ref('')
let savedAppearance = 'dark'
try {
  savedAppearance = localStorage.getItem('bl-console-theme') === 'light' ? 'light' : 'dark'
} catch {}
const appearance = ref(savedAppearance)
const theme = computed(() => (appearance.value === 'dark' ? darkTheme : null))
const overrides = computed(() => ({
  common: {
    primaryColor: appearance.value === 'dark' ? '#86aaf1' : '#3467c0',
    primaryColorHover: appearance.value === 'dark' ? '#a5bff4' : '#4779cf',
    primaryColorPressed: '#507ed3',
    borderRadius: '8px',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    ...(appearance.value === 'dark'
      ? {
          bodyColor: '#11151c',
          cardColor: '#191f29',
          modalColor: '#191f29',
          popoverColor: '#202735',
          inputColor: '#121720',
          borderColor: '#2c3645',
          textColorBase: '#e6ecf4'
        }
      : {})
  }
}))
async function boot() {
  loading.value = true
  error.value = ''
  try {
    authState.value = await api('/api/auth/state')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
function expired() {
  if (authState.value) authState.value = { ...authState.value, username: null, tokenWorks: false }
}
function toggleTheme() {
  appearance.value = appearance.value === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem('bl-console-theme', appearance.value)
  } catch {}
  document.documentElement.dataset.theme = appearance.value
}
onMounted(() => {
  document.documentElement.dataset.theme = appearance.value
  boot()
  window.addEventListener('console:unauthorized', expired)
})
onBeforeUnmount(() => window.removeEventListener('console:unauthorized', expired))
</script>
<template>
  <NConfigProvider
    :theme="theme"
    :theme-overrides="overrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
    ><NGlobalStyle /><NMessageProvider
      ><NNotificationProvider
        ><NDialogProvider>
          <div v-if="loading || error" class="boot-state">
            <PageState :loading="loading" :error="error" @retry="boot" />
          </div>
          <AppShell
            v-else-if="authState?.username || authState?.tokenWorks"
            :appearance="appearance"
            @theme="toggleTheme"
            @logout="expired"
          />
          <AuthPage
            v-else
            :setup="!authState?.hasUser"
            @authenticated="boot"
          /> </NDialogProvider></NNotificationProvider></NMessageProvider
  ></NConfigProvider>
</template>
