import crypto from "node:crypto"

const error = (message, status = 400) => Object.assign(new Error(message), { status })
const revisionSalt = crypto.randomBytes(32)
export function providerRevision(configKey, providers) {
  return crypto.createHmac("sha256", revisionSalt).update(JSON.stringify({ configKey, providers })).digest("hex")
}
export function maskApiKey(key = "") {
  const value = String(key || "")
  if (!value) return ""
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : "****"
}

function identity(provider) {
  return JSON.stringify([provider.name || "", provider.apiUrl || "", provider.model || ""])
}

// Identity never includes apiKey, priority, or another credential. Stored IDs survive edits and reorderings.
export function identifiableProviders(configKey, normalized = [], raw = []) {
  const duplicates = new Map()
  return normalized.map((provider, index) => {
    const signature = identity(provider)
    const occurrence = duplicates.get(signature) || 0
    duplicates.set(signature, occurrence + 1)
    const savedId = raw[index]?._consoleId
    const id = typeof savedId === "string" && /^c-[a-f0-9]{24}$/.test(savedId)
      ? savedId
      : `c-${crypto.createHash("sha256").update(`${configKey}:${signature}:${occurrence}`).digest("hex").slice(0, 24)}`
    return { ...provider, _consoleId: id }
  })
}

export function maskProvider(provider) {
  return { ...provider, apiKey: maskApiKey(provider.apiKey), apiKeyConfigured: Boolean(provider.apiKey) }
}

export function restoreProviderCredentials(submitted, current, { allowNew = true } = {}) {
  if (!Array.isArray(submitted)) throw error("渠道需为列表")
  const byId = new Map(current.map(provider => [provider._consoleId, provider]))
  const seen = new Set()
  return submitted.map((provider, index) => {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw error(`渠道 ${index + 1} 格式无效`)
    let existing
    if (provider._consoleId) {
      if (seen.has(provider._consoleId)) throw error("渠道标识重复，请重新加载配置")
      seen.add(provider._consoleId)
      existing = byId.get(provider._consoleId)
      if (!existing) throw error("渠道已被其他页面修改，请重新加载后保存", 409)
    } else if (provider.apiKeyAction === undefined) {
      // Legacy clients without IDs still retain their old position based editing contract.
      const candidates = current.filter(item => identity(item) === identity(provider))
      existing = candidates.length === 1 ? candidates[0] : current[index]
    }
    if (!allowNew && !existing && provider.apiKeyAction === "keep") throw error("该渠道没有已保存的凭据")
    const action = provider.apiKeyAction
    let apiKey = String(provider.apiKey ?? "")
    if (action !== undefined && !["keep", "replace", "clear"].includes(action)) throw error("API Key 操作无效")
    if (action === "keep") apiKey = existing?.apiKey || ""
    else if (action === "clear") apiKey = ""
    else if (action === "replace") {
      if (!apiKey.trim()) throw error("替换 API Key 不能为空；清除请使用清除操作")
      if (apiKey.includes("…") || /^\*{3,}$/.test(apiKey)) throw error("不能用脱敏占位符替换 API Key")
    } else if (existing && apiKey === maskApiKey(existing.apiKey)) apiKey = existing.apiKey
    else if (apiKey.includes("…") || /^\*{3,}$/.test(apiKey)) throw error("脱敏 API Key 无法匹配原渠道，请重新加载或明确替换")
    const { apiKeyAction, apiKeyConfigured, _consoleId, ...fields } = provider
    return { ...fields, apiKey, _consoleId: existing?._consoleId || `c-${crypto.randomBytes(12).toString("hex")}` }
  })
}
