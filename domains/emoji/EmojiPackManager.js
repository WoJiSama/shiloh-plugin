import fs from "fs"
import { promises as fsp } from "fs"
import path from "path"
import crypto from "crypto"
import YAML from "yaml"
import sharp from "sharp"
import { resolveChatCompletionUrl } from "../../utils/chatCompletionUrl.js"
import { buildEmojiCandidatePool, filterEmojiSelectionCriteriaToCatalog, normalizeEmojiSelectionCriteria, structuredEmojiRelevanceScore } from "./emojiSelection.js"

const _path = process.cwd()
const CONFIG_PATH = path.join(_path, "plugins/shiloh-plugin/config/message.yaml")
const CONFIG_DEFAULT_PATH = path.join(_path, "plugins/shiloh-plugin/config_default/message.yaml")

const DEFAULT_EMOJI_CONFIG = {
  enabled: false,
  dbPath: "plugins/shiloh-plugin/database/emoji-packs.ndjson",
  storeDir: "plugins/shiloh-plugin/database/emoji_files",
  maxItems: 200,
  autoCollect: false,
  visionTagOnAdd: true,
  useEmbedding: true,
  selectionTopK: 5,
  embeddingThreshold: 0.55,
  contentFiltration: true,
  doReplace: false,
  enableMaintenance: false,
  checkIntervalMinutes: 10,
  stalePruneEnabled: false,
  staleDays: 30,
  staleCandidatePoolSize: 20,
  stalePruneCount: 1,
  minItemsToKeep: 50,
  avoidRecentEnabled: true,
  avoidRecentCount: 20,
  avoidRecentTtlMinutes: 30,
  followUpDelayMinMs: 300,
  followUpDelayMaxMs: 1200,
  rateLimitEnabled: true,
  rateLimitWindowMinutes: 1,
  rateLimitMaxPerWindow: 3
}

// 打标完成后命中此黑名单的图片直接 reject（非表情包语义的 tag）
const TAG_BLACKLIST = new Set([
  "截图", "聊天记录", "代码", "文档", "网页",
  "风景", "建筑", "产品", "广告", "海报", "二维码", "logo",
  "插画", "立绘", "美术", "壁纸",
  "真人", "自拍", "明星"
])

const COMMON_QUERY_STOPWORDS = [
  "表情包", "表情", "来个", "发个", "找个", "配个", "一张", "一个",
  "希洛", "帮我", "给我", "想要", "可以", "一下", "这种", "那种", "图片"
]

let instance = null

function logInfo(msg) { globalThis.logger?.info?.(`[EmojiPackManager] ${msg}`) }
function logWarn(msg) { globalThis.logger?.warn?.(`[EmojiPackManager] ${msg}`) }
function logError(msg) { globalThis.logger?.error?.(`[EmojiPackManager] ${msg}`) }

function readPluginConfig() {
  const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_DEFAULT_PATH
  if (!fs.existsSync(file)) return {}
  try {
    return YAML.parse(fs.readFileSync(file, "utf8"))?.pluginSettings || {}
  } catch (err) {
    logWarn(`读取配置失败: ${err.message}`)
    return {}
  }
}

export class EmojiPackManager {
  constructor() {
    this.config = { ...DEFAULT_EMOJI_CONFIG }
    this.analysisAiConfig = {}
    this.embeddingAiConfig = {}
    this.toolsAiConfig = {}
    this.cache = { mtimeMs: 0, items: [], loaded: false }
    this.configMtimeMs = 0
    this.pendingWriteTimer = null
    this.pendingItems = null
    this.maintenanceTimer = null
    this.maintenanceIntervalMs = 0
    this.recentPicksByGroup = new Map()  // groupId → [{ hash, tags, at }]
    this.recentSendsByGroup = new Map()  // groupId → [timestamp, ...]
    this.writeQueue = Promise.resolve()  // addFromBuffer 串行队列，避免并发写竞争
    this.refreshConfig()
  }

  static getInstance() {
    if (!instance) instance = new EmojiPackManager()
    return instance
  }

  refreshConfig() {
    try {
      const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_DEFAULT_PATH
      if (!fs.existsSync(file)) return
      const stat = fs.statSync(file)
      if (stat.mtimeMs === this.configMtimeMs) return
      const settings = readPluginConfig()
      this.config = { ...DEFAULT_EMOJI_CONFIG, ...(settings.emojiSystem || {}) }
      this.analysisAiConfig = settings.analysisAiConfig || {}
      this.embeddingAiConfig = settings.embeddingAiConfig || {}
      this.toolsAiConfig = settings.toolsAiConfig || {}
      this.configMtimeMs = stat.mtimeMs
      this.ensureMaintenanceRunning()
    } catch (err) {
      logWarn(`刷新配置失败: ${err.message}`)
    }
  }

  get dbPath() {
    const p = this.config.dbPath || DEFAULT_EMOJI_CONFIG.dbPath
    return path.isAbsolute(p) ? p : path.join(_path, p)
  }

  get storeDir() {
    const p = this.config.storeDir || DEFAULT_EMOJI_CONFIG.storeDir
    return path.isAbsolute(p) ? p : path.join(_path, p)
  }

  async ensureDirs() {
    await fsp.mkdir(path.dirname(this.dbPath), { recursive: true })
    await fsp.mkdir(this.storeDir, { recursive: true })
  }

  async fileExists(filepath) {
    try { await fsp.access(filepath); return true } catch { return false }
  }

  async loadItems(force = false) {
    this.refreshConfig()
    if (!(await this.fileExists(this.dbPath))) {
      this.cache = { mtimeMs: 0, items: [], loaded: true }
      return []
    }
    const stat = await fsp.stat(this.dbPath)
    if (!force && this.cache.loaded && this.cache.mtimeMs === stat.mtimeMs) {
      return this.cache.items
    }
    const data = await fsp.readFile(this.dbPath, "utf-8")
    let normalized = false
    const items = data.split("\n").map(line => {
      const trimmed = line.trim()
      if (!trimmed) return null
      try {
        const item = JSON.parse(trimmed)
        const changed = this.normalizeItem(item)
        if (changed) normalized = true
        return item
      } catch { return null }
    }).filter(Boolean)
    this.cache = { mtimeMs: stat.mtimeMs, items, loaded: true }
    if (normalized) this.scheduleSave(items)
    return items
  }

  getSelectionVocabularySync() {
    this.refreshConfig()
    let items = this.cache.loaded ? this.cache.items : []
    if (!items.length && fs.existsSync(this.dbPath)) {
      try {
        items = fs.readFileSync(this.dbPath, "utf8")
          .split("\n")
          .map(line => line.trim())
          .filter(Boolean)
          .map(line => JSON.parse(line))
      } catch (error) {
        logWarn(`读取表情词表失败: ${error.message}`)
        items = []
      }
    }

    const countValues = field => {
      const counts = new Map()
      for (const item of items) {
        for (const value of (Array.isArray(item?.[field]) ? item[field] : [])) {
          const text = String(value || "").trim()
          if (text) counts.set(text, (counts.get(text) || 0) + 1)
        }
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
        .map(([value]) => value)
    }

    return { tags: countValues("tags"), useCases: countValues("useCases") }
  }

  normalizeItem(item) {
    if (!item || typeof item !== "object") return false
    let changed = false
    if (!Array.isArray(item.tags)) { item.tags = []; changed = true }
    const normalizedTags = [...new Set(item.tags.map(t => String(t).trim()).filter(Boolean).map(t => t.slice(0, 8)))]
    if (JSON.stringify(normalizedTags) !== JSON.stringify(item.tags)) {
      item.tags = normalizedTags
      changed = true
    }
    if (!Array.isArray(item.useCases)) {
      item.useCases = this.deriveUseCasesFromDescription(item.description)
      changed = true
    } else {
      const normalized = [...new Set(item.useCases.map(t => String(t).trim()).filter(Boolean).map(t => t.slice(0, 16)))].slice(0, 8)
      if (JSON.stringify(normalized) !== JSON.stringify(item.useCases)) {
        item.useCases = normalized
        changed = true
      }
    }
    if (typeof item.description !== "string") { item.description = ""; changed = true }
    if (typeof item.usedCount !== "number") { item.usedCount = Number(item.usedCount) || 0; changed = true }
    if (!("lastUsedAt" in item)) { item.lastUsedAt = null; changed = true }
    if (!item.registeredAt) { item.registeredAt = new Date().toISOString(); changed = true }
    if (!("isBanned" in item)) { item.isBanned = false; changed = true }
    return changed
  }

  deriveUseCasesFromDescription(description = "") {
    const text = String(description || "")
    const matches = []
    const patterns = [
      /(?:使用场景|场合|适合|用于|用来|群聊里)(?:是|：|:)?([^。；;\n]{2,24})/g,
      /(?:看到|听到|被人|对方|群友)([^。；;\n]{2,18})(?:时|的时候)/g
    ]
    for (const pattern of patterns) {
      let match
      while ((match = pattern.exec(text)) && matches.length < 5) {
        matches.push(match[1].replace(/[，,、]$/, "").trim())
      }
    }
    return [...new Set(matches.filter(Boolean))].slice(0, 5)
  }

  async saveItems(items) {
    await this.ensureDirs()
    const data = items.map(item => JSON.stringify(item)).join("\n") + (items.length ? "\n" : "")
    await fsp.writeFile(this.dbPath, data, "utf-8")
    const stat = await fsp.stat(this.dbPath)
    this.cache = { mtimeMs: stat.mtimeMs, items, loaded: true }
  }

  sha256OfBuffer(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex")
  }

  detectExtFromBuffer(buf) {
    const header = [...buf.slice(0, 12)].map(b => b.toString(16).padStart(2, "0").toUpperCase())
    const sig = header.join("")
    if (sig.startsWith("FFD8")) return ".jpg"
    if (sig.startsWith("89504E47")) return ".png"
    if (sig.startsWith("474946")) return ".gif"
    if (sig.startsWith("52494646") && header.slice(8, 12).join("") === "57454250") return ".webp"
    if (sig.startsWith("424D")) return ".bmp"
    return ".bin"
  }

  detectMimeFromExt(ext) {
    return {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".png": "image/png", ".gif": "image/gif",
      ".webp": "image/webp", ".bmp": "image/bmp"
    }[ext.toLowerCase()] || "application/octet-stream"
  }

  async addFromBuffer(buffer, opts = {}) {
    // 串行队列：保证同一时刻只有一个 addFromBuffer 在读-改-写 ndjson，避免并发竞争丢记录
    const task = () => this._addFromBufferInternal(buffer, opts)
    const result = this.writeQueue.then(task, task)  // 不管前一次成败都执行下一次
    this.writeQueue = result.catch(() => {})         // 防 unhandled rejection 且让链不断
    return result
  }

  async _addFromBufferInternal(buffer, { source = "manual", autoTag = true, autoEmbed = true } = {}) {
    this.refreshConfig()
    await this.ensureDirs()

    const hash = this.sha256OfBuffer(buffer)
    const items = await this.loadItems(true)
    const existing = items.find(i => i.hash === hash)
    if (existing) return { added: false, reason: "duplicate", item: existing }

    const ext = this.detectExtFromBuffer(buffer)
    if (ext === ".bin") return { added: false, reason: "unsupported_format" }

    // L0 物理预检查：尺寸 / 纵横比 / 文件大小（零成本，必拦明显非表情包）
    if (buffer.length > 5 * 1024 * 1024) {
      return { added: false, reason: "too_large", size: buffer.length }
    }
    if (buffer.length < 1024) {
      return { added: false, reason: "too_tiny", size: buffer.length }
    }
    try {
      const meta = await sharp(buffer, { failOn: "none" }).metadata()
      const w = meta.width || 0
      const h = meta.height || 0
      if (w && h) {
        if (w < 96 || h < 96) {
          return { added: false, reason: "too_small", width: w, height: h }
        }
        if (w > 1500 || h > 1500) {
          return { added: false, reason: "too_large_dim", width: w, height: h }
        }
        const ratio = Math.max(w, h) / Math.min(w, h)
        if (ratio > 3) {
          return { added: false, reason: "extreme_aspect", ratio: ratio.toFixed(2) }
        }
      }
    } catch (err) {
      // 读 metadata 失败 → 直接拒绝（非标准图片）
      return { added: false, reason: "metadata_failed", error: err.message }
    }

    // 第一道闸：库满且未开 doReplace 时直接拒绝，节省所有后续 AI 调用（content_filtration / VLM 打标 / embedding）
    const maxItems = this.config.maxItems || 200
    if (items.length >= maxItems && !this.config.doReplace) {
      return { added: false, reason: "full" }
    }

    if (this.config.contentFiltration) {
      try {
        const verdict = await this.contentFilterWithVLM(buffer, ext)
        if (!verdict.isEmoji) {
          logInfo(`内容审查未通过 (${hash.slice(0, 8)}): ${verdict.reason}`)
          return { added: false, reason: "content_filtered", filterReason: verdict.reason }
        }
      } catch (err) {
        // fail-closed：审查异常时拒绝入库（避免错收，宁可漏收）
        logWarn(`内容审查异常 (${hash.slice(0, 8)}): ${err.message}，拒绝入库`)
        return { added: false, reason: "content_filter_error", error: err.message }
      }
    }

    // 第二道闸：库仍满（此时 doReplace 必为 true）→ 先按冷门过期策略替换，再兜底 LLM
    if (items.length >= maxItems) {
      try {
        let removedHash = await this.pickStaleLowUsageHash(items)
        if (!removedHash) removedHash = await this.replaceOldestByLLM(items)
        if (removedHash) {
          const removeIdx = items.findIndex(i => i.hash === removedHash)
          if (removeIdx >= 0) {
            const removed = items.splice(removeIdx, 1)[0]
            const removedAbs = path.join(this.storeDir, path.basename(removed.file))
            try { await fsp.unlink(removedAbs) } catch {}
            logInfo(`满额替换：删除 ${removed.hash.slice(0, 8)} 给 ${hash.slice(0, 8)} 让位`)
          }
        } else {
          return { added: false, reason: "full" }
        }
      } catch (err) {
        logWarn(`满额替换决策失败: ${err.message}`)
        return { added: false, reason: "full" }
      }
    }

    const fileName = `${hash}${ext}`
    const file = `emoji_files/${fileName}`
    const absFile = path.join(this.storeDir, fileName)
    await fsp.writeFile(absFile, buffer)

    const record = {
      hash,
      file,
      tags: [],
      useCases: [],
      description: "",
      embedding: null,
      usedCount: 0,
      lastUsedAt: null,
      registeredAt: new Date().toISOString(),
      source,
      isBanned: false
    }

    if (autoTag && this.config.visionTagOnAdd !== false) {
      try {
        const tagResult = await this.tagWithVLM(buffer, ext)
        record.tags = tagResult.tags
        record.useCases = tagResult.useCases
        record.description = tagResult.description
        if (!record.tags.length && !record.description) {
          throw new Error("VLM 未返回有效标签或描述")
        }
      } catch (err) {
        logWarn(`VLM 打标失败 (${hash.slice(0, 8)}): ${err.message}，跳过入库`)
        try { await fsp.unlink(absFile) } catch {}
        return { added: false, reason: "tag_failed", error: err.message }
      }

      // L3 tag 黑名单复查：打标后命中"截图/风景/广告/真人"等明确非表情包 tag → 拒绝
      const hitBlacklist = (record.tags || [])
        .map(t => String(t).toLowerCase().trim())
        .filter(t => TAG_BLACKLIST.has(t))
      if (hitBlacklist.length) {
        try { await fsp.unlink(absFile) } catch {}
        logInfo(`L3 黑名单拦截 (${hash.slice(0, 8)}): 命中 [${hitBlacklist.join(",")}]`)
        return { added: false, reason: "tag_blacklist", hitTags: hitBlacklist }
      }
    }

    if (autoEmbed && this.config.useEmbedding !== false && record.description) {
      try {
        const embeddingText = this.buildSemanticText(record)
        record.embedding = await this.getEmbedding(embeddingText)
      } catch (err) {
        logWarn(`embedding 生成失败 (${hash.slice(0, 8)}): ${err.message}`)
      }
    }

    items.push(record)
    await this.saveItems(items)
    logInfo(`新增表情包: ${hash.slice(0, 8)} tags=[${(record.tags || []).join(",")}]`)
    return { added: true, item: record }
  }

  async gifToStaticPng(buffer) {
    return await sharp(buffer, { animated: false, failOn: "none" }).png().toBuffer()
  }

  async prepareVLMImage(buffer, ext) {
    if (ext.toLowerCase() === ".gif") {
      try {
        const png = await this.gifToStaticPng(buffer)
        return { buffer: png, mime: "image/png" }
      } catch (err) {
        logInfo(`GIF 首帧提取失败已回退原图（不影响功能，VLM 仍可识别）: ${err.message.split(":")[0]}`)
      }
    }
    return { buffer, mime: this.detectMimeFromExt(ext) }
  }

  async callOpenAIChat(cfg, urlField, keyField, modelField, body) {
    const url = cfg?.[urlField]
    const key = cfg?.[keyField]
    if (!url || !key || String(key).includes("sk-xxx")) {
      throw new Error(`${keyField} 未配置`)
    }
    const finalBody = { model: cfg[modelField], ...body }
    // analysisApiUrl 可能配的是 base(/v1)也可能是完整端点,统一规整成 chat completions
    const response = await fetch(resolveChatCompletionUrl(url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(finalBody)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`API ${response.status}: ${text.slice(0, 120)}`)
    }
    return await response.json()
  }

  async tagWithVLM(buffer, ext) {
    const cfg = this.analysisAiConfig
    if (!cfg?.analysisApiUrl || !cfg?.analysisApiKey || cfg.analysisApiKey.includes("sk-xxx")) {
      throw new Error("analysisAiConfig 未配置")
    }
    const prepared = await this.prepareVLMImage(buffer, ext)
    const dataUrl = `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}`

    const prompt = `请观察这张表情包图片，输出严格的 JSON 格式（不要 markdown 代码块），只包含三个字段：

- "description": **详细描述这张表情包**（40-120 字），要覆盖三层信息：
  1. **画面**：图里是什么角色（猫/狗/动漫角色/人物）、在做什么动作（捂脸/翻白眼/竖中指/比心）、有什么文字（如"我谢谢你""绷不住了"）
  2. **情绪**：传达的情绪状态（无奈/吐槽/嘲讽/卖萌/震惊/敷衍/崩溃/得意/委屈/傲娇/社死/躺平/摆烂）
  3. **使用场景**：群聊里什么场合下会发这张（被人说服时、看到离谱发言时、自嘲时、被夸时、装无辜时）
  描述要具体，不要写"一张表情包图片"这种废话。

- "tags": 3-5 个**情绪/反应**标签（每个不超过 4 个字）。例：开心、笑死、无奈、吐槽、惊讶、嘲讽、卖萌、震惊、敷衍、崩溃、得意、委屈、傲娇、社死、摆烂、绝望、心动。**禁止**用画风/物体词（卡通形象、二次元、插画、可爱、动物、猫咪）。

- "use_cases": 3-5 个**使用场景**短标签（每个 2-10 字）。要写“什么时候发”，不要写画面物体。例：看到离谱、群友翻车、被人夸奖、想装无辜、拒绝加班、无言以对、轻微嘲讽、安慰对方、接梗吐槽、认怂求饶。

只输出 JSON，不要任何其他文字。`

    const json = await this.callOpenAIChat(
      cfg, "analysisApiUrl", "analysisApiKey",
      cfg.analysisApiModel ? "analysisApiModel" : null,
      {
        model: cfg.analysisApiModel || "gemini-3-pro-preview",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }]
      }
    )
    const text = json.choices?.[0]?.message?.content || ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("VLM 未返回 JSON")
    const parsed = JSON.parse(match[0])
    return {
      tags: Array.isArray(parsed.tags)
        ? parsed.tags
            .map(t => String(t).trim())
            .filter(Boolean)
            .map(t => t.slice(0, 4))
            .slice(0, 5)
        : [],
      useCases: Array.isArray(parsed.use_cases) || Array.isArray(parsed.useCases)
        ? (parsed.use_cases || parsed.useCases)
            .map(t => String(t).trim())
            .filter(Boolean)
            .map(t => t.slice(0, 10))
            .slice(0, 5)
        : this.deriveUseCasesFromDescription(parsed.description),
      description: String(parsed.description || "").slice(0, 300)
    }
  }

  admissionExtrasText() {
    const allow = (this.config?.admissionExtraAllow || []).map(s => String(s).trim()).filter(Boolean)
    const reject = (this.config?.admissionExtraReject || []).map(s => String(s).trim()).filter(Boolean)
    let extra = ""
    if (allow.length) extra += "\n【站长补充放行】（满足任一同样可判 true）：\n" + allow.map(r => "- " + r).join("\n") + "\n"
    if (reject.length) extra += "\n【站长补充拒绝】（命中任一直接判 false，优先级最高）：\n" + reject.map(r => "- " + r).join("\n") + "\n"
    return extra
  }

  async contentFilterWithVLM(buffer, ext) {
    const cfg = this.analysisAiConfig
    if (!cfg?.analysisApiUrl || !cfg?.analysisApiKey || cfg.analysisApiKey.includes("sk-xxx")) {
      throw new Error("analysisAiConfig 未配置")
    }
    const prepared = await this.prepareVLMImage(buffer, ext)
    const dataUrl = `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}`

    const prompt = `严格判断这张图是否是真正适合 QQ/微信聊天的**表情包**。
判定标准必须从严，宁可漏判不要错收。

【判定为 true 的必要条件】（至少明显具备一项）：
1. 典型表情包/梗图：网络流行梗图、二次元角色表情、ACG 同人表情、emoji 贴纸、QQ/微信官方表情样式
2. 强烈情绪/反应表达：图中主体（人/动物/物体）正在做夸张的表情、动作、姿势（生气、哭泣、惊讶、无语、嘲讽、得意、崩溃、卖萌、震惊等可一眼识别的情绪）
3. 自带梗字/吐槽文字：图片上写有"我也想""绷不住了""我就笑笑""你说啥"等中文梗字 / 二次创作配文
4. 拟人化反应：动物或无生命物体做出明显人类化的搞笑表情/动作

【判定为 false（必拒）】：
- 普通宠物日常照（猫狗坐着、躺着、走路、吃东西等没有夸张表情/动作的）
- 插画、美术作品、艺术绘画、写实画风的角色立绘、CG 截图
- 风景照、建筑、产品图、广告海报、横幅、二维码
- 真人照片、自拍、合照、明星生图
- 文档截图、聊天截图、文字截图、网页截图、代码截图
- 仅"画风不错"或"角色好看"但没有明显情绪/动作/梗的图
- 不确定的图

**关键测试**：把这张图发到群里，群友能立刻明白"这是在表达 XX 情绪/梗"吗？不能就是 false。

仅输出严格 JSON（不要 markdown 代码块）：{"is_emoji": true 或 false, "reason": "简短理由"}${this.admissionExtrasText()}`

    const json = await this.callOpenAIChat(
      cfg, "analysisApiUrl", "analysisApiKey",
      cfg.analysisApiModel ? "analysisApiModel" : null,
      {
        model: cfg.analysisApiModel || "gemini-3-pro-preview",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }]
      }
    )
    const text = json.choices?.[0]?.message?.content || ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("内容审查未返回 JSON")
    const parsed = JSON.parse(match[0])
    return {
      isEmoji: parsed.is_emoji === true,
      reason: String(parsed.reason || "").slice(0, 60)
    }
  }

  async replaceOldestByLLM(items) {
    const cfg = this.toolsAiConfig
    if (!cfg?.toolsAiUrl || !cfg?.toolsAiApikey || String(cfg.toolsAiApikey).includes("sk-xxx")) {
      throw new Error("toolsAiConfig 未配置")
    }
    if (!items.length) return null

    // 按 1/(usedCount+1) 加权抽样最多 20 张候选
    const sample = []
    const weighted = items.map((item, idx) => ({ idx, weight: 1 / ((item.usedCount || 0) + 1) }))
    const total = weighted.reduce((a, b) => a + b.weight, 0)
    const candidatePool = [...weighted]
    const N = Math.min(20, candidatePool.length)
    for (let i = 0; i < N; i++) {
      let r = Math.random() * candidatePool.reduce((s, c) => s + c.weight, 0)
      for (let j = 0; j < candidatePool.length; j++) {
        r -= candidatePool[j].weight
        if (r <= 0) {
          sample.push(items[candidatePool[j].idx])
          candidatePool.splice(j, 1)
          break
        }
      }
    }

    const list = sample.map((item, i) => {
      const tags = (item.tags || []).join(",") || "无标签"
      const desc = (item.description || "").slice(0, 20)
      return `${i}. [${tags}] ${desc} (用过${item.usedCount || 0}次)`
    }).join("\n")

    const prompt = `本地表情包库已满，需要从下列候选中删除一张以腾出空间存新表情。
请优先选择：使用次数少、标签笼统/重复、不易复用的表情包。
候选列表：
${list}

仅输出 JSON（不要 markdown 代码块）：{"index": <候选编号 0-${sample.length - 1}>, "reason": "简短理由"}`

    const response = await fetch(resolveChatCompletionUrl(cfg.toolsAiUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.toolsAiApikey}` },
      body: JSON.stringify({
        model: cfg.toolsAiModel || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      })
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`tools API ${response.status}: ${text.slice(0, 120)}`)
    }
    const json = await response.json()
    const text = json.choices?.[0]?.message?.content || ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("替换决策未返回 JSON")
    const parsed = JSON.parse(match[0])
    const idx = Number(parsed.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= sample.length) {
      throw new Error(`替换决策 index 非法: ${parsed.index}`)
    }
    return sample[idx].hash
  }

  isStaleForPrune(item, now = Date.now()) {
    const staleDays = Math.max(1, Number(this.config.staleDays) || 30)
    const cutoff = now - staleDays * 24 * 60 * 60 * 1000
    if (!item.lastUsedAt) return true
    const t = new Date(item.lastUsedAt).getTime()
    return !Number.isFinite(t) || t < cutoff
  }

  pickStaleLowUsageHash(items) {
    const minKeep = Math.max(0, Number(this.config.minItemsToKeep) || 50)
    if (!Array.isArray(items) || items.length <= minKeep) return null
    const now = Date.now()
    const poolSize = Math.max(1, Number(this.config.staleCandidatePoolSize) || 20)
    const candidates = items
      .filter(item => !item.isBanned && this.isStaleForPrune(item, now))
      .sort((a, b) => {
        const usageDiff = (a.usedCount || 0) - (b.usedCount || 0)
        if (usageDiff !== 0) return usageDiff
        const at = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0
        const bt = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0
        return at - bt
      })
      .slice(0, poolSize)
    if (!candidates.length) return null
    return candidates[Math.floor(Math.random() * candidates.length)].hash
  }

  async pruneStaleLowUsage(items, removeCount = null) {
    const count = Math.max(0, Number(removeCount ?? this.config.stalePruneCount) || 0)
    if (!count) return { removed: 0, removedItems: [] }
    const removedItems = []
    for (let i = 0; i < count; i++) {
      const hash = this.pickStaleLowUsageHash(items)
      if (!hash) break
      const idx = items.findIndex(item => item.hash === hash)
      if (idx < 0) break
      const [removed] = items.splice(idx, 1)
      const abs = path.join(this.storeDir, path.basename(removed.file))
      try { await fsp.unlink(abs) } catch {}
      removedItems.push(removed)
    }
    return { removed: removedItems.length, removedItems }
  }

  async getEmbedding(input) {
    const cfg = this.embeddingAiConfig
    if (!cfg?.embeddingApiUrl || !cfg?.embeddingApiKey || cfg.embeddingApiKey.includes("sk-xxx")) {
      throw new Error("embeddingAiConfig 未配置")
    }
    const response = await fetch(cfg.embeddingApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.embeddingApiKey}` },
      body: JSON.stringify({ model: cfg.embeddingApiModel || "text-embedding-3-small", input })
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`embedding API ${response.status}: ${text.slice(0, 120)}`)
    }
    const json = await response.json()
    return json.data?.[0]?.embedding || null
  }

  buildSemanticText(item) {
    const tags = Array.isArray(item?.tags) ? item.tags.join("，") : ""
    const useCases = Array.isArray(item?.useCases) ? item.useCases.join("，") : ""
    return [
      item?.description ? `描述：${item.description}` : "",
      tags ? `情绪标签：${tags}` : "",
      useCases ? `使用场景：${useCases}` : ""
    ].filter(Boolean).join("\n")
  }

  tokenizeQuery(text) {
    const lower = String(text || "").toLowerCase()
    const cleaned = COMMON_QUERY_STOPWORDS.reduce((acc, word) => acc.replaceAll(word, " "), lower)
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
    const words = cleaned.split(/\s+/).filter(Boolean)
    const chunks = []
    const chineseParts = cleaned.match(/[\p{Script=Han}]{2,}/gu) || []
    for (const part of chineseParts) {
      if (part.length <= 4) {
        chunks.push(part)
        continue
      }
      for (let len = 2; len <= 4; len++) {
        for (let i = 0; i <= part.length - len; i++) chunks.push(part.slice(i, i + len))
      }
    }
    return [...new Set([...words, ...chunks].filter(t => t.length >= 2))]
  }

  localTextRelevanceScore(item, query) {
    const q = String(query || "").toLowerCase().trim()
    if (!q) return 0
    const tokens = this.tokenizeQuery(q)
    if (!tokens.length) return 0
    const tags = Array.isArray(item.tags) ? item.tags.map(t => String(t).toLowerCase()) : []
    const useCases = Array.isArray(item.useCases) ? item.useCases.map(t => String(t).toLowerCase()) : []
    const description = String(item.description || "").toLowerCase()

    let score = 0
    for (const token of tokens) {
      if (tags.some(tag => tag === token || tag.includes(token) || token.includes(tag))) score += 0.32
      if (useCases.some(scene => scene === token || scene.includes(token) || token.includes(scene))) score += 0.24
      if (description.includes(token)) score += 0.08
    }
    const fullText = [...tags, ...useCases, description].join(" ")
    for (const phrase of [...tags, ...useCases]) {
      if (phrase && q.includes(phrase)) score += 0.18
    }
    if (fullText.includes(q)) score += 0.2
    return Math.min(1, score)
  }

  localRelevanceScore(item, input) {
    const criteria = normalizeEmojiSelectionCriteria(input)
    const structuredScore = structuredEmojiRelevanceScore(item, criteria)
    const textScore = this.localTextRelevanceScore(item, criteria.query)

    if (!structuredScore) return textScore
    // query 只用于轻量打破同标签候选的并列，不允许自由文本盖过精确 tag/useCase。
    return Math.min(1, structuredScore + (textScore * 0.06))
  }

  cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
  }

  getRecentExclusions(groupId) {
    if (!groupId) return { hashes: new Set(), tags: new Set() }
    const ttlMs = (Number(this.config.avoidRecentTtlMinutes) || 30) * 60 * 1000
    const cutoff = Date.now() - ttlMs
    const picks = this.recentPicksByGroup.get(String(groupId)) || []
    const fresh = picks.filter(p => p.at >= cutoff)
    if (fresh.length !== picks.length) {
      if (fresh.length) this.recentPicksByGroup.set(String(groupId), fresh)
      else this.recentPicksByGroup.delete(String(groupId))
    }
    const hashes = new Set(fresh.map(p => p.hash))
    const tags = new Set()
    for (const p of fresh) for (const t of (p.tags || [])) tags.add(String(t).toLowerCase())
    return { hashes, tags }
  }

  recordPick(groupId, hash, tags) {
    if (!groupId || !hash) return
    const key = String(groupId)
    const list = this.recentPicksByGroup.get(key) || []
    list.push({ hash, tags: Array.isArray(tags) ? tags.slice() : [], at: Date.now() })
    const max = Number(this.config.avoidRecentCount) || 20
    while (list.length > max) list.shift()
    this.recentPicksByGroup.set(key, list)
    // 顺手清理过期群条目
    const ttlMs = (Number(this.config.avoidRecentTtlMinutes) || 30) * 60 * 1000
    const cutoff = Date.now() - ttlMs
    for (const [gid, picks] of this.recentPicksByGroup) {
      const fresh = picks.filter(p => p.at >= cutoff)
      if (!fresh.length) this.recentPicksByGroup.delete(gid)
      else if (fresh.length !== picks.length) this.recentPicksByGroup.set(gid, fresh)
    }
  }

  checkRateLimit(groupId) {
    if (this.config.rateLimitEnabled === false) return { allowed: true }
    if (!groupId) return { allowed: true }
    const max = Number(this.config.rateLimitMaxPerWindow) || 0
    if (max <= 0) return { allowed: true }
    const windowMinutes = Number(this.config.rateLimitWindowMinutes) || 5
    const windowMs = windowMinutes * 60 * 1000
    const cutoff = Date.now() - windowMs
    const key = String(groupId)
    const all = this.recentSendsByGroup.get(key) || []
    const fresh = all.filter(t => t >= cutoff)
    if (fresh.length !== all.length) {
      if (fresh.length) this.recentSendsByGroup.set(key, fresh)
      else this.recentSendsByGroup.delete(key)
    }
    return fresh.length >= max
      ? { allowed: false, count: fresh.length, max, windowMinutes }
      : { allowed: true, count: fresh.length, max, windowMinutes }
  }

  recordSend(groupId) {
    if (!groupId) return
    const key = String(groupId)
    const list = this.recentSendsByGroup.get(key) || []
    list.push(Date.now())
    this.recentSendsByGroup.set(key, list)
    // 顺手清过期群
    const windowMs = (Number(this.config.rateLimitWindowMinutes) || 5) * 60 * 1000
    const cutoff = Date.now() - windowMs
    for (const [gid, ts] of this.recentSendsByGroup) {
      const fresh = ts.filter(t => t >= cutoff)
      if (!fresh.length) this.recentSendsByGroup.delete(gid)
      else if (fresh.length !== ts.length) this.recentSendsByGroup.set(gid, fresh)
    }
  }

  /**
   * 三层加权抽样：
   * 1) 硬相关性门 —— 只保留与 top score 差距 < 0.1 且 >= 0.6 的候选；候选 <2 时放宽到 top3
   * 2) 长程冷却 —— 按 lastUsedAt 分档（<30min 0.2 / <60min 0.5 / <180min 0.8 / 其他 1.0）打折权重
   * 3) 加权 —— score³ × min(1.5, usageFactor)，让 score 主导，避免冷图碾压热图
   * candidates: [{ item, score }]，score 在 [0,1]
   */
  weightedSampleByUsage(candidates, options = {}) {
    if (!candidates?.length) return null

    const pool = buildEmojiCandidatePool(candidates, options)

    const now = Date.now()
    const cooldownPenalty = (lastUsedAt) => {
      if (!lastUsedAt) return 1
      const t = new Date(lastUsedAt).getTime()
      if (!Number.isFinite(t)) return 1
      const ageMin = (now - t) / 60000
      if (ageMin < 30) return 0.2
      if (ageMin < 60) return 0.5
      if (ageMin < 180) return 0.8
      return 1
    }

    const weights = pool.map(({ item, score }) => {
      const usedCount = item.usedCount || 0
      const usageFactor = Math.min(1.5, (1 / (usedCount + 1)) * (usedCount === 0 ? 2 : 1))
      const baseScore = Math.max(0.01, Number(score) || 0.01)
      return Math.pow(baseScore, 3) * usageFactor * cooldownPenalty(item.lastUsedAt)
    })
    const total = weights.reduce((a, b) => a + b, 0)
    if (total <= 0) return pool[0]
    let r = Math.random() * total
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i]
      if (r <= 0) return pool[i]
    }
    return pool[pool.length - 1]
  }

  /** 订阅 catalog 变化（导入/删除/打标/清空后触发）；返回取消订阅函数 */
  onCatalogChanged(callback) {
    if (typeof callback !== "function") return () => {}
    this.catalogChangedCallbacks ??= new Set()
    this.catalogChangedCallbacks.add(callback)
    return () => this.catalogChangedCallbacks.delete(callback)
  }

  notifyCatalogChanged() {
    if (!this.catalogChangedCallbacks?.size) return
    for (const callback of this.catalogChangedCallbacks) {
      try { callback() } catch (error) { logWarn(`catalog 变更回调失败: ${error?.message || error}`) }
    }
  }

  /** 清空全部数据（ndjson + 图片文件 + 内存缓存 + 反重复/限流状态），返回删除的图片文件数 */
  async clearAllData() {
    let deletedFiles = 0
    // 先取消 pendingWriteTimer，避免清空期间 markUsed 的节流写回脏数据
    if (this.pendingWriteTimer) {
      clearTimeout(this.pendingWriteTimer)
      this.pendingWriteTimer = null
      this.pendingItems = null
    }
    await fs.promises.unlink(this.dbPath).catch(() => {})
    try {
      const files = await fs.promises.readdir(this.storeDir)
      const results = await Promise.allSettled(
        files.map(file => fs.promises.unlink(path.join(this.storeDir, file)))
      )
      deletedFiles = results.filter(result => result.status === "fulfilled").length
    } catch {}
    this.cache = { mtimeMs: 0, items: [], loaded: true }
    this.recentPicksByGroup.clear()
    this.recentSendsByGroup.clear()
    this.notifyCatalogChanged()
    return deletedFiles
  }

  async selectEmoji(input, options = {}) {
    this.refreshConfig()
    const allItems = await this.loadItems()
    const usableAll = allItems.filter(i => {
      if (i.isBanned || i.noFileFlag) return false
      const abs = this.getAbsoluteFilePath(i)
      return fs.existsSync(abs)
    })
    if (!usableAll.length) return { item: null, strategy: "empty" }

    // avoidRecent：只按 hash 排除（不再按 tag —— tag 不准且容易把池清空）
    let items = usableAll
    if (this.config.avoidRecentEnabled !== false && options.groupId) {
      const { hashes: recentHashes } = this.getRecentExclusions(options.groupId)
      if (recentHashes.size) {
        const filtered = usableAll.filter(item => !recentHashes.has(item.hash))
        if (filtered.length) items = filtered
        // 排除后为空（极少见）才退回 usableAll
      }
    }

    const requestedCriteria = normalizeEmojiSelectionCriteria(input)
    const criteria = filterEmojiSelectionCriteriaToCatalog(requestedCriteria, usableAll)
    const q = criteria.query
    const useEmbed = this.config.useEmbedding !== false
    const hasEmbedCfg = !!(this.embeddingAiConfig?.embeddingApiUrl
      && this.embeddingAiConfig?.embeddingApiKey
      && !String(this.embeddingAiConfig.embeddingApiKey).includes("sk-xxx"))
    const embeddedItems = items.filter(i => Array.isArray(i.embedding) && i.embedding.length)

    // L0: 本地标签/使用场景召回。命中明确标签时不需要调用 embedding，省钱且更稳定。
    if (q) {
      const localRanked = items
        .map(item => ({ item, score: this.localRelevanceScore(item, criteria) }))
        .filter(r => r.score >= 0.18)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(3, Number(this.config.selectionTopK) || 5))
      if (localRanked.length) {
        const preserveStrongMatch = criteria.tags.length > 0 || criteria.useCases.length > 0
        const picked = this.weightedSampleByUsage(localRanked, { preserveStrongMatch })
        return { item: picked.item, strategy: "tag_scene", score: picked.score, criteria }
      }
    }

    // L1: embedding 召回（基于 LLM 识别的 description）
    if (q && useEmbed && hasEmbedCfg && embeddedItems.length) {
      try {
        const qEmbed = await this.getEmbedding(q)
        if (Array.isArray(qEmbed)) {
          const threshold = Number(this.config.embeddingThreshold) || 0.55
          const topK = Number(this.config.selectionTopK) || 5
          const ranked = embeddedItems
            .map(item => ({ item, score: this.cosineSimilarity(qEmbed, item.embedding) }))
            .filter(r => r.score >= threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
          if (ranked.length) {
            const picked = this.weightedSampleByUsage(ranked)
            return { item: picked.item, strategy: "embedding", score: picked.score, criteria }
          }
        }
      } catch (err) {
        logWarn(`embedding 选图失败，降级到全库兜底: ${err.message}`)
      }
    }

    // L2 兜底只在"模型没有给出任何具体诉求"时随机；
    // 有明确 tags/useCases/query 却全部未命中时不再随机发图——
    // 发一张不相关的图比不发更伤观感（这是"选错表情"的主要来源）
    const modelAskedSpecifically = requestedCriteria.tags.length > 0 ||
      requestedCriteria.useCases.length > 0 ||
      String(criteria.query || "").trim().length > 0
    if (modelAskedSpecifically) {
      return { item: null, strategy: "no_match", criteria }
    }
    // 给所有图相同的 0.7 分（高于 weightedSampleByUsage 的 0.6 硬门）
    // 让所有候选通过相关性门，由 usageFactor + cooldownPenalty 主导多样性
    const fallback = items.map(item => ({ item, score: 0.7 }))
    const picked = this.weightedSampleByUsage(fallback)
    return { item: picked.item, strategy: "fallback_random", score: picked.score, criteria }
  }

  scheduleSave(items) {
    this.pendingItems = items
    if (this.pendingWriteTimer) clearTimeout(this.pendingWriteTimer)
    this.pendingWriteTimer = setTimeout(() => {
      const toSave = this.pendingItems
      this.pendingItems = null
      this.pendingWriteTimer = null
      this.saveItems(toSave)
        .then(() => this.notifyCatalogChanged())
        .catch(err => logWarn(`节流写入失败: ${err.message}`))
    }, 2000)
  }

  async markUsed(hash) {
    const items = await this.loadItems(true)
    const item = items.find(i => i.hash === hash)
    if (!item) return
    item.usedCount = (item.usedCount || 0) + 1
    item.lastUsedAt = new Date().toISOString()
    this.scheduleSave(items)
  }

  async removeByHashPrefix(hashPrefix) {
    const prefix = String(hashPrefix || "").trim().toLowerCase()
    if (!prefix) return { removed: 0, matched: [] }
    const items = await this.loadItems(true)
    const matched = items.filter(i => i.hash.toLowerCase().startsWith(prefix))
    if (!matched.length) return { removed: 0, matched: [] }
    for (const m of matched) {
      const abs = path.join(this.storeDir, path.basename(m.file))
      try { await fsp.unlink(abs) } catch {}
    }
    const remaining = items.filter(i => !matched.some(m => m.hash === i.hash))
    await this.saveItems(remaining)
    return { removed: matched.length, matched }
  }

  async setBannedByHashPrefix(hashPrefix, banned) {
    const prefix = String(hashPrefix || "").trim().toLowerCase()
    if (!prefix) return { updated: 0 }
    const items = await this.loadItems(true)
    const matched = items.filter(i => i.hash.toLowerCase().startsWith(prefix))
    if (!matched.length) return { updated: 0, matched: [] }
    matched.forEach(item => { item.isBanned = !!banned })
    await this.saveItems(items)
    return { updated: matched.length, matched }
  }

  async retagByHashPrefix(hashPrefix) {
    const prefix = String(hashPrefix || "").trim().toLowerCase()
    if (!prefix) return { updated: 0 }
    const items = await this.loadItems(true)
    const target = items.find(i => i.hash.toLowerCase().startsWith(prefix))
    if (!target) return { updated: 0 }
    const abs = path.join(this.storeDir, path.basename(target.file))
    if (!fs.existsSync(abs)) return { updated: 0, reason: "file_missing" }
    const buffer = await fsp.readFile(abs)
    const ext = path.extname(target.file) || this.detectExtFromBuffer(buffer)
    try {
      const tagResult = await this.tagWithVLM(buffer, ext)
      target.tags = tagResult.tags
      target.useCases = tagResult.useCases
      target.description = tagResult.description
      if (this.config.useEmbedding !== false && target.description) {
        try {
          target.embedding = await this.getEmbedding(this.buildSemanticText(target))
        } catch (err) {
          logWarn(`重新打标 embedding 失败: ${err.message}`)
        }
      }
      await this.saveItems(items)
      return { updated: 1, item: target }
    } catch (err) {
      return { updated: 0, error: err.message }
    }
  }

  getAbsoluteFilePath(item) {
    return path.join(this.storeDir, path.basename(item.file))
  }

  /** 管理页清单：轻字段投影，embedding 等大字段不出网 */
  async listForAdmin() {
    const items = await this.loadItems()
    return items.map(i => ({
      hash: i.hash,
      file: path.basename(String(i.file || "")),
      tags: (i.tags || []).slice(0, 6),
      useCases: (i.useCases || []).slice(0, 4),
      usedCount: Number(i.usedCount) || 0,
      lastUsedAt: i.lastUsedAt || null,
      registeredAt: i.registeredAt || "",
      isBanned: !!i.isBanned
    }))
  }

  /** 管理页删除：记录与文件一起删；文件删失败只记日志（库里不再引用） */
  async removeItem(hash) {
    const wanted = String(hash || "")
    if (!/^[a-f0-9]{6,64}$/.test(wanted)) return { ok: false, error: "invalid_hash" }
    const items = await this.loadItems()
    const target = items.find(i => i.hash === wanted)
    if (!target) return { ok: false, error: "not_found" }
    await this.saveItems(items.filter(i => i.hash !== wanted))
    try {
      await fsp.unlink(this.getAbsoluteFilePath(target))
    } catch (err) {
      logWarn(`删除表情文件失败 (${wanted.slice(0, 8)}): ${err.message}`)
    }
    logInfo(`管理页删除表情包: ${wanted.slice(0, 8)} tags=[${(target.tags || []).join(",")}]`)
    return { ok: true, hash: wanted }
  }

  /** 管理页批量删除：一次读、一次写，逐个清理文件；返回删掉/未找到计数 */
  async removeItems(hashes = []) {
    const wanted = new Set((Array.isArray(hashes) ? hashes : []).map(String).filter(h => /^[a-f0-9]{6,64}$/.test(h)))
    if (!wanted.size) return { removed: 0, missing: 0 }
    const items = await this.loadItems()
    const keep = []
    const targets = []
    for (const item of items) {
      if (wanted.has(item.hash)) targets.push(item)
      else keep.push(item)
    }
    if (targets.length) {
      await this.saveItems(keep)
      for (const target of targets) {
        try {
          await fsp.unlink(this.getAbsoluteFilePath(target))
        } catch (err) {
          logWarn(`删除表情文件失败 (${target.hash.slice(0, 8)}): ${err.message}`)
        }
      }
      logInfo(`管理页批量删除表情包: ${targets.length} 张`)
    }
    return { removed: targets.length, missing: wanted.size - targets.length }
  }

  async stats() {
    const items = await this.loadItems()
    return {
      total: items.length,
      tagged: items.filter(i => Array.isArray(i.tags) && i.tags.length).length,
      useCaseTagged: items.filter(i => Array.isArray(i.useCases) && i.useCases.length).length,
      embedded: items.filter(i => Array.isArray(i.embedding) && i.embedding.length).length,
      banned: items.filter(i => i.isBanned).length,
      maxItems: this.config.maxItems || 200,
      enabled: !!this.config.enabled,
      autoCollect: !!this.config.autoCollect,
      contentFiltration: !!this.config.contentFiltration,
      doReplace: !!this.config.doReplace,
      enableMaintenance: !!this.config.enableMaintenance,
      stalePruneEnabled: this.config.stalePruneEnabled === true
    }
  }

  ensureMaintenanceRunning() {
    const enabled = !!this.config.enabled && !!this.config.enableMaintenance
    const intervalMs = Math.max(1, Number(this.config.checkIntervalMinutes) || 10) * 60 * 1000

    if (!enabled) {
      if (this.maintenanceTimer) {
        clearInterval(this.maintenanceTimer)
        this.maintenanceTimer = null
        this.maintenanceIntervalMs = 0
        logInfo("周期维护已停止")
      }
      return
    }

    if (this.maintenanceTimer && this.maintenanceIntervalMs === intervalMs) return

    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = setInterval(() => {
      this.runMaintenance().catch(err => logWarn(`维护任务异常: ${err.message}`))
    }, intervalMs)
    this.maintenanceIntervalMs = intervalMs
    logInfo(`周期维护已启动 (每 ${this.config.checkIntervalMinutes || 10} 分钟)`)
  }

  async runMaintenance() {
    if (!this.config.enabled) return { skipped: true }
    const items = await this.loadItems(true)
    let changed = false
    const report = { markedMissing: 0, unmarkedRestored: 0, orphanRegistered: 0, cleanedUntagged: 0, prunedStale: 0, prunedHashes: [] }

    // 1. 记录指向的文件不存在 → 标记 noFileFlag
    for (const item of items) {
      const abs = path.join(this.storeDir, path.basename(item.file))
      const exists = fs.existsSync(abs)
      if (!exists && !item.noFileFlag) {
        item.noFileFlag = true
        changed = true
        report.markedMissing++
        logWarn(`维护：${item.hash.slice(0, 8)} 文件缺失，已标记`)
      } else if (exists && item.noFileFlag) {
        item.noFileFlag = false
        changed = true
        report.unmarkedRestored++
      }
    }

    // 2. 目录有图片但 ndjson 没记录 → 补登（仅记录 hash 和 file，不打标）
    try {
      const files = await fsp.readdir(this.storeDir)
      const knownFiles = new Set(items.map(i => path.basename(i.file)))
      for (const f of files) {
        if (knownFiles.has(f)) continue
        const ext = path.extname(f).toLowerCase()
        if (![".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) continue
        const hashFromName = path.basename(f, ext)
        if (!/^[0-9a-f]{64}$/i.test(hashFromName)) continue
        if (items.length >= (this.config.maxItems || 200)) break
        items.push({
          hash: hashFromName.toLowerCase(),
          file: `emoji_files/${f}`,
          tags: [],
          useCases: [],
          description: "",
          embedding: null,
          usedCount: 0,
          lastUsedAt: null,
          registeredAt: new Date().toISOString(),
          source: "maintenance",
          isBanned: false
        })
        changed = true
        report.orphanRegistered++
        logInfo(`维护：补登孤立文件 ${hashFromName.slice(0, 8)}`)
      }
    } catch (err) {
      logWarn(`维护扫描目录失败: ${err.message}`)
    }

    // 3. 清理无标签无向量的「残废」记录（含磁盘文件）
    //    仅在启用 VLM 打标时执行，避免误删用户主动关闭打标时的合法无标签项
    if (this.config.visionTagOnAdd !== false) {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        const hasTag = Array.isArray(item.tags) && item.tags.length > 0
        const hasEmbed = Array.isArray(item.embedding) && item.embedding.length > 0
        if (!hasTag && !hasEmbed) {
          const abs = path.join(this.storeDir, path.basename(item.file))
          try { await fsp.unlink(abs) } catch {}
          items.splice(i, 1)
          report.cleanedUntagged++
          changed = true
        }
      }
      if (report.cleanedUntagged) logInfo(`维护：清理 ${report.cleanedUntagged} 个无标签无向量的残废记录（含磁盘文件）`)
    }

    // 4. 可选：冷门过期淘汰。只在显式开启时执行，避免默认误删用户收藏。
    if (this.config.stalePruneEnabled === true) {
      const pruneResult = await this.pruneStaleLowUsage(items)
      if (pruneResult.removed) {
        report.prunedStale = pruneResult.removed
        report.prunedHashes = pruneResult.removedItems.map(item => item.hash.slice(0, 8))
        changed = true
        logInfo(`维护：淘汰 ${report.prunedStale} 个冷门过期表情 [${report.prunedHashes.join(",")}]`)
      }
    }

    if (changed) await this.saveItems(items)
    report.total = items.length
    return report
  }

  async maybeAutoCollect(e) {
    this.refreshConfig()
    if (!this.config.enabled || !this.config.autoCollect) return
    if (!Array.isArray(e?.message)) return

    const imageSegs = e.message.filter(seg => seg?.type === "image" && seg?.url)
    if (!imageSegs.length) return

    for (const seg of imageSegs) {
      try {
        const response = await fetch(seg.url, { signal: AbortSignal.timeout(10000) })
        if (!response.ok) continue
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length < 1024 || buffer.length > 5 * 1024 * 1024) continue
        await this.addFromBuffer(buffer, { source: "auto" })
      } catch (err) {
        logWarn(`autoCollect 失败: ${err.message}`)
      }
    }
  }
}

export const emojiPackManager = EmojiPackManager.getInstance()
export default emojiPackManager
