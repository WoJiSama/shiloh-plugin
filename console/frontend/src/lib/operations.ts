import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { useDialog } from 'naive-ui'
import { api } from './api'
import { containerLabel } from './identities'

export interface Account {
  container: string
  account: string
  nickname?: string
  status: string
  running: boolean
  loginState: string
  qrAvailable: boolean
  memory?: string
  exitIp?: string | null
  sidecar?: string | null
  webui?: string | null
  fingerprint?: { stable: boolean; changes: number; firstSeen: string } | null
}
export interface Traffic {
  recv: number
  send: number
  fail: number
}
export interface OverviewStats {
  total: Traffic
  week: Array<Traffic & { day: string }>
  todayGroups: Record<string, { recv: number; send: number }>
}
export interface AccountResult {
  container: string
  ok: boolean
  error?: string
  note?: string
}
export interface Group {
  id: string
  name?: string
  whitelisted: boolean
  today: { recv: number; send: number }
  bots: string[]
  groupAdmin?: {
    groupGuard: boolean
    groupModeration: boolean
    groupNotice: boolean
    customized: boolean
  }
}
export interface PersonaLibrary {
  revision?: string
  personas: Array<{ id: string; name: string; [key: string]: unknown }>
  accountBindings: Record<string, string>
  groupBindings: Record<string, string>
  privateBinding: string | null
}

export function accountStatus(account: Account) {
  if (!account.running)
    return { label: account.status === 'created' ? '待启动' : '已停止', type: 'default' as const }
  if (account.loginState === '已登录') return { label: '在线', type: 'success' as const }
  if (account.loginState === '待扫码') return { label: '待扫码', type: 'warning' as const }
  if (account.loginState === '掉线') return { label: '已掉线', type: 'error' as const }
  return { label: '状态检测中', type: 'warning' as const }
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
export function count(value: number | undefined) {
  return (value ?? 0).toLocaleString('zh-CN')
}

/** Each module owns its request and polling lifecycle; refresh never touches local drafts. */
export function useOpsResource<T>(fetcher: (signal: AbortSignal) => Promise<T>, intervalMs = 0) {
  const data = shallowRef<T | null>(null)
  const loading = ref(false)
  const error = ref('')
  const updatedAt = ref('')
  let mounted = false
  let active = true
  let controller: AbortController | null = null
  let interval: ReturnType<typeof setInterval> | undefined
  let sequence = 0
  async function refresh() {
    if (!mounted || !active || document.hidden || loading.value) return
    const ticket = ++sequence
    controller = new AbortController()
    loading.value = true
    try {
      const result = await fetcher(controller.signal)
      if (!mounted || !active || ticket !== sequence) return
      data.value = result
      error.value = ''
      updatedAt.value = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch (cause) {
      if (mounted && active && ticket === sequence && !controller?.signal.aborted)
        error.value = errorText(cause)
    } finally {
      if (mounted && active && ticket === sequence) loading.value = false
    }
  }
  function cancel() {
    ++sequence
    controller?.abort()
    loading.value = false
  }
  function visibility() {
    if (document.hidden) cancel()
    else void refresh()
  }
  onMounted(() => {
    mounted = true
    void refresh()
    document.addEventListener('visibilitychange', visibility)
    if (intervalMs)
      interval = setInterval(() => {
        if (!document.hidden) void refresh()
      }, intervalMs)
  })
  onActivated(() => {
    active = true
    if (mounted) void refresh()
  })
  onDeactivated(() => {
    active = false
    cancel()
  })
  onUnmounted(() => {
    mounted = false
    cancel()
    clearInterval(interval)
    document.removeEventListener('visibilitychange', visibility)
  })
  function reset() {
    cancel()
    data.value = null
    error.value = ''
    updatedAt.value = ''
    void refresh()
  }
  return { data, loading, error, updatedAt, refresh, reset }
}

export function useAccountActions(
  afterAction: () => Promise<unknown>,
  accounts: () => Account[] = () => []
) {
  const dialog = useDialog()
  const busy = ref(false)
  const results = ref<AccountResult[]>([])
  const error = ref('')
  let active = true
  const refreshTimers = new Set<ReturnType<typeof setTimeout>>()
  onUnmounted(() => {
    active = false
    refreshTimers.forEach(clearTimeout)
    refreshTimers.clear()
  })
  const hasFailures = computed(() => results.value.some((result) => !result.ok))
  function confirmAction(containers: string[], action: 'start' | 'stop' | 'restart') {
    if (busy.value) return
    if (!containers.length) {
      error.value = '没有符合条件的机器人。'
      return
    }
    if (containers.length > 10) {
      error.value = '一次最多操作 10 个机器人，请缩小选择范围。'
      return
    }
    const label = { start: '启动', stop: '停止', restart: '重启' }[action]
    dialog.warning({
      title: `确认${label} ${containers.length} 个机器人`,
      content: `${containers.map((container) => containerLabel(container, accounts())).join('、')}。${action === 'stop' ? '停止后将暂停这些账号的消息服务，并停止对应出口服务。' : action === 'restart' ? '操作期间消息服务会短暂中断，部分账号可能需要重新扫码。' : '启动后请关注登录状态，需要时扫码登录。'}`,
      positiveText: `确认${label}`,
      negativeText: '取消',
      onPositiveClick: async () => {
        if (!active || busy.value) return
        busy.value = true
        error.value = ''
        results.value = []
        try {
          const result = await api<{ results: AccountResult[] }>('/api/accounts/action', {
            method: 'POST',
            body: JSON.stringify({ containers, action })
          })
          if (!active) return
          results.value = result.results || []
          await afterAction()
          if (action === 'start')
            for (const delay of [4000, 10000]) {
              const timer = setTimeout(() => {
                refreshTimers.delete(timer)
                if (active) void afterAction()
              }, delay)
              refreshTimers.add(timer)
            }
        } catch (cause) {
          if (active) error.value = errorText(cause)
        } finally {
          if (active) busy.value = false
        }
      }
    })
  }
  return { busy, results, error, hasFailures, confirmAction }
}
