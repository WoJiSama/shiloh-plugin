// Legacy config, proxy and logger wiring; diagnosis behavior is typed.
import { readUserSettings } from './configWriter.js'
import { createChatFailureDiagnosis } from '../dist/backend/modules/models/application/chatFailureDiagnosis.js'
async function resolveFetch(proxyUrl) {
  if (!proxyUrl) return globalThis.fetch
  try {
    const { fetch: undiciFetch, ProxyAgent } = await import("undici")
    const agent = new ProxyAgent(proxyUrl)
    return (url, init) => undiciFetch(url, { ...init, dispatcher: agent })
  } catch {
    return globalThis.fetch
  }
}

const diagnosis = createChatFailureDiagnosis({
 fetch: (url, init) => globalThis.fetch(url, init), readSettings: readUserSettings, resolveFetch,
 logger: { info: message => globalThis.logger?.info?.(message), warn: message => globalThis.logger?.warn?.(message) }
})

export const probeChatBackend = diagnosis.probeChatBackend
export const runChatFailureDiagnosis = diagnosis.runChatFailureDiagnosis
export const getCachedDiagnosisLine = diagnosis.getCachedDiagnosisLine
export const triggerChatFailureDiagnosis = diagnosis.triggerChatFailureDiagnosis
