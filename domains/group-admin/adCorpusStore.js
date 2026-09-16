import fs from "fs"
import path from "path"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"

const DEFAULT_MAX_ENTRIES = 1000
const MAX_ENTRY_CHARS = 600

function normalizeCorpusText(text = "") {
  return safeTruncateUnicode(String(text || "").replace(/\s+/g, " ").trim(), MAX_ENTRY_CHARS)
}

function normalizeCorpusList(templates = []) {
  const seen = new Set()
  const output = []
  for (const template of Array.isArray(templates) ? templates : [templates]) {
    const normalized = normalizeCorpusText(template)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    output.push(normalized)
  }
  return output
}

function newEntryId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 广告样本库：群主/管理员在群里引用广告消息执行 .广告入库 后持久化到
 * data/group_moderation/ad_corpus.jsonl，与配置里的 adTemplates 种子一起
 * 参与判重相似度。JSONL 追加为主，超过上限时整文件重写并淘汰最旧条目。
 */
export class AdCorpusStore {
  constructor({
    filePath = path.join(process.cwd(), "plugins/shiloh-plugin/data/group_moderation/ad_corpus.jsonl"),
    maxEntries = DEFAULT_MAX_ENTRIES,
    logger = globalThis.logger
  } = {}) {
    this.filePath = filePath
    this.maxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES)
    this.logger = logger
    this.cache = null
    this.cacheAt = 0
  }

  readEntries() {
    try {
      const stat = fs.statSync(this.filePath)
      if (this.cache && this.cacheAt === stat.mtimeMs) return this.cache
      const entries = []
      for (const line of fs.readFileSync(this.filePath, "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry?.id && entry?.text) entries.push(entry)
        } catch {}
      }
      this.cache = entries
      this.cacheAt = stat.mtimeMs
      return entries
    } catch {
      this.cache = []
      this.cacheAt = 0
      return this.cache
    }
  }

  getTemplateTexts() {
    return this.readEntries().map(entry => entry.text)
  }

  findByText(text = "") {
    const normalized = normalizeCorpusText(text)
    if (!normalized) return null
    return this.readEntries().find(entry => entry.text === normalized) || null
  }

  addEntry({ text = "", groupId = "", userId = "", addedBy = "", source = "manual" } = {}) {
    const normalized = normalizeCorpusText(text)
    if (normalized.length < 6) return { ok: false, error: "text_too_short" }

    const existing = this.findByText(normalized)
    if (existing) return { ok: false, duplicate: true, entry: existing }

    const entry = {
      id: newEntryId(),
      text: normalized,
      groupId: String(groupId || ""),
      userId: String(userId || ""),
      addedBy: String(addedBy || ""),
      source: String(source || "manual"),
      addedAt: new Date().toISOString()
    }
    const entries = [...this.readEntries(), entry]
    let droppedCount = 0
    while (entries.length > this.maxEntries) {
      entries.shift()
      droppedCount++
    }
    this.writeEntries(entries)
    if (droppedCount > 0) {
      this.logger?.info?.(`[广告样本库] 达到上限 ${this.maxEntries}，淘汰最旧 ${droppedCount} 条`)
    }
    return { ok: true, entry, droppedCount }
  }

  removeEntry(id = "") {
    const target = String(id || "").trim().replace(/^#/, "")
    if (!target) return { ok: false, error: "missing_id" }
    const entries = this.readEntries()
    const index = entries.findIndex(entry => entry.id === target)
    if (index < 0) return { ok: false, error: "not_found" }
    const [removed] = entries.splice(index, 1)
    this.writeEntries(entries)
    return { ok: true, entry: removed }
  }

  // 启动时把配置 adTemplates 种子导入样本库（幂等：已存在同文本的跳过），
  // 让全部样本在 .广告样本 里可见、可统一管理
  importSeedTemplates(templates = [], { addedBy = "system" } = {}) {
    let imported = 0
    for (const template of normalizeCorpusList(templates)) {
      const result = this.addEntry({ text: template, addedBy, source: "seed" })
      if (result.ok) imported++
    }
    return imported
  }

  getStats({ previewCount = 5, previewChars = 40 } = {}) {
    const entries = this.readEntries()
    return {
      total: entries.length,
      maxEntries: this.maxEntries,
      latest: entries.slice(-previewCount).reverse().map(entry => ({
        id: entry.id,
        preview: safeTruncateUnicode(entry.text, previewChars),
        source: entry.source || "manual",
        addedAt: entry.addedAt
      }))
    }
  }

  writeEntries(entries = []) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, entries.map(entry => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), "utf8")
    this.cache = null
    this.cacheAt = 0
  }
}

export const adCorpusStore = new AdCorpusStore()
