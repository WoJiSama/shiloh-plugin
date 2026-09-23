import { fetch as undiciFetch, ProxyAgent } from "undici"

/**
 * 通过代理执行一次 HTTP 请求,并在回调内消费响应体。
 * 代理连接池的生命周期绑定在本次调用上:consume 结束(或抛错)后立即关闭,
 * 因此 consume 必须在返回前读完 body(json()/text()/流式写盘),不能把响应对象带出去延迟读取。
 * proxyUrl 为空时退化为普通 fetch,行为不变。
 */
export async function fetchWithProxy(url, { proxyUrl = "", ...init } = {}, consume) {
  const proxy = String(proxyUrl || "").trim()
  if (!proxy) return await consume(await fetch(url, init))
  const agent = new ProxyAgent(proxy)
  try {
    const response = await undiciFetch(url, { ...init, dispatcher: agent })
    return await consume(response)
  } finally {
    await agent.close().catch(() => {})
  }
}
