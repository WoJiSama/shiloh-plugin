export function createFetchWithTimeout(fetcher: typeof fetch) {
  return async function fetchWithTimeout(url: string | URL | Request, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
    const controller = new AbortController()
    const external = options.signal
    let timedOut = false
    const onAbort = () => controller.abort(external?.reason)
    if (external?.aborted) { external.throwIfAborted() }
    external?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      const response = await fetcher(url, { ...options, signal: controller.signal })
      const body = await new Promise<ArrayBuffer>((resolve, reject) => {
        const abortBody = () => { void response.body?.cancel().catch(() => {}); reject(controller.signal.reason) }
        if (controller.signal.aborted) { abortBody(); return }
        controller.signal.addEventListener('abort', abortBody, { once: true })
        response.arrayBuffer().then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abortBody))
      })
      return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) {
      if (external?.aborted) throw external.reason
      if (timedOut) throw new Error(`请求超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`)
      throw error
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }
}
export const fetchWithTimeout = createFetchWithTimeout((...args) => fetch(...args))
