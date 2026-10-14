import { fetch as undiciFetch, ProxyAgent } from "undici"
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from "undici"

// 按代理地址复用连接池:同一代理的请求共享 TLS 隧道,避免每个请求
// 都完整握手一轮(多请求场景可省数秒)。
const agentPool = new Map<string, ProxyAgent>()

function getPooledAgent(proxyUrl = "") {
  const proxy = String(proxyUrl || "").trim()
  if (!proxy) return null
  let agent = agentPool.get(proxy)
  if (!agent) {
    agent = new ProxyAgent(proxy)
    agentPool.set(proxy, agent)
  }
  return agent
}

/**
 * 通过代理执行一次 HTTP 请求,并在回调内消费响应体。
 * 代理连接池按地址全局复用,不随单次请求关闭;因此 consume 仍应在
 * 返回前读完 body(json()/text()/流式写盘),不要把响应对象带出去延迟读取。
 * proxyUrl 为空时退化为普通 fetch,行为不变。
 */
export async function fetchWithProxy<T>(url: string | URL, { proxyUrl = "", ...init }: UndiciRequestInit & { proxyUrl?: string } = {}, consume: (response: UndiciResponse) => T | Promise<T>): Promise<T> {
  const agent = getPooledAgent(proxyUrl)
  if (!agent) return await consume(await undiciFetch(url, init))
  const response = await undiciFetch(url, { ...init, dispatcher: agent })
  return await consume(response)
}

/** 测试辅助:清空连接池 */
export function resetProxiedFetchPool() {
  for (const agent of agentPool.values()) agent.close?.().catch?.(() => {})
  agentPool.clear()
}
