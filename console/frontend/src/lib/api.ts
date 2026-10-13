import { ref } from 'vue'
const TOKEN_KEY = 'bl-console-token'
let storedToken = ''
try {
  storedToken = localStorage.getItem(TOKEN_KEY) || ''
} catch {
  /* Token links and cookie sessions also work when storage is blocked. */
}
try {
  const url = new URL(location.href)
  const queryToken = url.searchParams.get('token')
  if (queryToken) {
    storedToken = queryToken
    try {
      localStorage.setItem(TOKEN_KEY, queryToken)
    } catch {}
    url.searchParams.delete('token')
    history.replaceState(history.state, '', url)
  }
} catch {
  /* Cookie sessions work without local storage. */
}
export class ApiError extends Error {
  status: number
  details: Record<string, any>
  constructor(status: number, details: Record<string, any>) {
    super(details.error || `请求失败 (${status})`)
    this.status = status
    this.details = details
  }
}
let sessionCheck: Promise<void> | null = null
async function checkSession(headers: Headers) {
  if (!sessionCheck)
    sessionCheck = (async () => {
      try {
        const response = await fetch('/api/auth/state', { headers, credentials: 'same-origin' })
        if (!response.ok) return
        const state = await response.json()
        if (!state.username && !state.tokenWorks)
          window.dispatchEvent(new CustomEvent('console:unauthorized'))
      } catch {
        /* An unavailable upstream does not establish that the console session expired. */
      }
    })().finally(() => {
      sessionCheck = null
    })
  await sessionCheck
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type'))
    headers.set('content-type', 'application/json')
  if (storedToken) headers.set('x-console-token', storedToken)
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      if (path.startsWith('/bl-chat/')) await checkSession(headers)
      else window.dispatchEvent(new CustomEvent('console:unauthorized'))
    }
    throw new ApiError(response.status, data)
  }
  return data as T
}
export function imageUrl(path: string): string {
  if (!path || /^(data:|blob:)/.test(path)) return path
  const url = new URL(path, location.origin)
  if (url.origin !== location.origin) return path
  if (storedToken && (url.pathname.startsWith('/img/') || url.pathname.startsWith('/bl-chat/')))
    url.searchParams.set('token', storedToken)
  return `${url.pathname}${url.search}${url.hash}`
}
export function clearToken() {
  storedToken = ''
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {}
}
export interface AuthState {
  hasUser: boolean
  username: string | null
  tokenWorks: boolean
  via?: string
}
export const authState = ref<AuthState | null>(null)
