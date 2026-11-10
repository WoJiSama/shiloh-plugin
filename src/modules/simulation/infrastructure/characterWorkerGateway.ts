import type { CharacterScope } from '../../../contracts/character.js'
import type { CharacterWorkerTask, CharacterWorkerResult } from './characterWorker.js'

/** Trusted administrator configured bridge, not the stock OpenClaw API. */
export function createCharacterWorkerGateway({ endpoint, token = '', fetch: request = globalThis.fetch }: { endpoint: string; token?: string; fetch?: typeof fetch }) {
  const base = new URL(endpoint)
  if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(base.hostname)))) throw new Error('工作器网关须为HTTPS或本机HTTP，不接受URL凭据')
  base.search = ''; base.hash = ''
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return async function run(task: CharacterWorkerTask, scope: CharacterScope, signal: AbortSignal): Promise<CharacterWorkerResult> {
    signal.throwIfAborted()
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    const cancel = () => {
      void request(new URL(`tasks/${encodeURIComponent(task.taskId)}`,base), { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => undefined)
    }
    signal.addEventListener('abort',cancel,{ once:true })
    try {
      const response = await request(new URL('tasks',base), { method: 'POST', headers: { ...headers, 'Idempotency-Key': task.taskId }, redirect: 'error', signal, body: JSON.stringify({ schemaVersion: 1, scope, task }) })
      if (!response.ok) return { status: [400,401,403,404,422].includes(response.status) ? 'failed' : 'unknown', summary: `工作器HTTP ${response.status}，未确认任务完成` }
      if (!response.body) throw new Error('工作器响应为空')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const {value,done} = await reader.read()
          if (done) break
          size += value.length
          if (size > 128*1024) throw new Error('工作器响应过大')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => undefined) }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as CharacterWorkerResult
    } finally { signal.removeEventListener('abort',cancel) }
  }
}
