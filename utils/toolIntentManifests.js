import { classifyEmojiToolExposure } from "./emojiToolPolicy.js"
import { getAllRegisteredIntentManifests, registerToolManifests } from "./toolManifestRegistry.js"
import { BUILTIN_TOOL_MANIFESTS } from "./builtinToolManifests.js"

// 内置工具 manifest 自注册:本模块的合并视图由此获得全部触发词/披露/快路解析器。
// (历史条目已整体迁移到 utils/builtinToolManifests.js,行为逐字保真)
registerToolManifests(BUILTIN_TOOL_MANIFESTS)

function normalizeText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    // TRSS strips a configured bot alias before this layer. Preserve the request
    // while removing the punctuation left by forms such as "希洛，查一下...".
    .replace(/^\s*[，,、。:：;；!?！？]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
}


export function selectToolIntentCandidates(text = "", availableToolNames = [], context = {}) {
  const content = normalizeText(text)
  if (!content) return []
  const available = new Set(availableToolNames)
  const candidates = []
  for (const [toolName, manifest] of Object.entries(allIntentManifests())) {
    if (!available.has(toolName)) continue
    if (toolName === "sendLocalEmojiTool") {
      if (classifyEmojiToolExposure(content) !== "none") candidates.push(toolName)
      continue
    }
    if (manifest.triggers.some(pattern => pattern.test(content))) candidates.push(toolName)
  }
  return resolveCandidateConflicts(candidates, content, context)
}

function resolveCandidateConflicts(candidates = [], content = "", context = {}) {
  let resolved = [...candidates]

  // A reaction image must never turn an explicit operational request back into
  // a free-form chat turn. Explicitly asking for an emoji remains an override.
  if (resolved.includes("sendLocalEmojiTool") && classifyEmojiToolExposure(content) !== "explicit") {
    const hasOperationalTool = resolved.some(name => name !== "sendLocalEmojiTool")
    if (hasOperationalTool) {
      resolved = resolved.filter(name => name !== "sendLocalEmojiTool")
    }
  }

  // 「下载 N」在磁链选择与 Pixiv 列表之间有歧义:
  // - 磁链或多选编号始终归磁链工具;
  // - 5 位以上纯数字更像 Pixiv 作品ID;
  // - 短序号看哪边有活跃会话( Pixiv 侧用进程内存同步检查)。
  if (resolved.includes("pixivDownloadTool") && resolved.includes("torrentDownloadTool")) {
    const looksTorrent = /magnet:\?|磁链|磁力链接/.test(content) || /(?:下载|下|选择|选)\s*(?:第\s*)?\d+(?:\s*(?:,|，|、)\s*(?:第\s*)?\d+)+/.test(content)
    const looksPixivId = /(?:下载|下|搬运)\s*(?:id|ID)?\s*\d{5,12}/i.test(content)
    const preferPixiv = !looksTorrent && (looksPixivId || context.hasPixivSearchSession === true)
    resolved = resolved.filter(name => (preferPixiv ? name !== "torrentDownloadTool" : name !== "pixivDownloadTool"))
  }

  if (resolved.includes("githubRepoTool")) {
    resolved = resolved.filter(name => name !== "webParserTool" && name !== "searchInformationTool")
  }
  if (resolved.includes("modrinthTool")) {
    resolved = resolved.filter(name => name !== "webParserTool" && name !== "searchInformationTool")
  }
  if (resolved.includes("mentionAdminsTool")) {
    resolved = resolved.filter(name => name !== "mentionMembersTool")
  }

  const specificTools = resolved.filter(name => !["searchInformationTool", "webParserTool"].includes(name))
  if (specificTools.length) {
    resolved = resolved.filter(name => name !== "searchInformationTool")
  }

  return resolved
}

export function buildToolIntentDisclosure(toolNames = []) {
  const parts = []
  for (const name of toolNames) {
    const text = allIntentManifests()[name]?.disclosure
    if (text) parts.push(text)
  }
  return parts.join("\n\n")
}

export function hasToolIntentManifest(toolName = "") {
  return Boolean(allIntentManifests()[toolName])
}

function allIntentManifests() {
  return getAllRegisteredIntentManifests()
}



export function resolveDeterministicToolIntent(text = "", availableToolNames = [], context = {}) {
  const candidates = selectToolIntentCandidates(text, availableToolNames, context)
  if (candidates.length !== 1) return null
  const toolName = candidates[0]
  const resolver = getAllRegisteredIntentManifests()[toolName]?.deterministicResolver
  if (!resolver) return null
  const params = resolver(normalizeText(text), context)
  if (!params || typeof params !== "object") return null
  return { intent: "tool", toolName, params, reason: "deterministic_manifest" }
}

export function resolveToolRequestMergeMs(text = "", availableToolNames = [], options = {}) {
  const defaultValue = Number(options.defaultMs)
  const defaultMs = Number.isFinite(defaultValue) ? Math.max(0, defaultValue) : 3000
  const fastValue = Number(options.fastMs)
  const fastMs = Number.isFinite(fastValue) ? Math.max(0, fastValue) : 600
  return resolveDeterministicToolIntent(text, availableToolNames, options) ? fastMs : defaultMs
}
