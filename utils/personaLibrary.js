// 多人设库:支持保存多套人设并按群绑定切换。
// 存储:config/persona-library.yaml { personas: [...], groupBindings: { 群号: 人设id }, privateBinding: "" }
// - personas 只存"与默认人设的差异"以外的完整字段,缺省字段回退 message.yaml 的 persona(和 configStore 深合并同思路);
// - 默认人设(id=default)永远可用且不可删,来源是 message.yaml,随主配置热更新;
// - 读取走 mtime 缓存,手动编辑 yaml 下一轮对话即生效,无需重启。
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

// 人设条目可写字段(与 message.yaml pluginSettings.persona 对齐)
export const PERSONA_ENTRY_FIELDS = [
  "name",
  "identity",
  "tone",
  "speechStyle",
  "preferences",
  "boundaries",
  "notes",
  "moods"
]

const PRIVATE_BINDING_KEY = "__private__"

function normalizeListValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || "").trim()).filter(Boolean)
  }
  const text = String(value || "").trim()
  if (!text) return []
  return text.split(/[,\n，]/).map(item => item.trim()).filter(Boolean)
}

// 只保留人设合法字段;列表字段规整为字符串数组,文本字段规整为 trim 后的字符串
export function normalizePersonaEntry(entry = {}) {
  const normalized = {}
  for (const field of PERSONA_ENTRY_FIELDS) {
    if (entry == null || !(field in entry)) continue
    const value = entry[field]
    if (["speechStyle", "preferences", "boundaries"].includes(field)) {
      normalized[field] = normalizeListValue(value)
    } else if (field === "moods") {
      // 调皮情绪时刻: [{name, hint, probability}],结构体数组原样透传(掷骰侧再归一)
      if (Array.isArray(value)) normalized.moods = value
    } else {
      normalized[field] = String(value ?? "").trim()
    }
  }
  return normalized
}

function randomId() {
  return `p${Math.random().toString(36).slice(2, 8)}`
}

function sameName(a = "", b = "") {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase()
}

// 空状态必须是每次新建的:模块级共享常量会被多个实例的 upsert 交叉污染
function emptyState() {
  return { personas: [], groupBindings: {}, privateBinding: "" }
}

export function createPersonaLibrary({
  libraryPath,
  getBasePersona = () => ({}),
  logger = globalThis.logger
} = {}) {
  const file = String(libraryPath || "")
  let cache = null
  let lastStat = ""

  function logError(...args) {
    try { logger?.error?.(...args) } catch {}
  }

  function statKey() {
    try {
      const stat = fs.statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return "missing"
    }
  }

  function loadState() {
    const key = statKey()
    if (cache && key === lastStat) return cache
    let state = emptyState()
    if (key !== "missing") {
      try {
        const parsed = YAML.parse(fs.readFileSync(file, "utf8")) || {}
        const personas = Array.isArray(parsed.personas)
          ? parsed.personas
              .map(item => (item && typeof item === "object" ? { id: String(item.id || "").trim() || randomId(), ...normalizePersonaEntry(item) } : null))
              .filter(item => item && String(item.name || "").trim())
          : []
        const groupBindings = {}
        if (parsed.groupBindings && typeof parsed.groupBindings === "object") {
          for (const [groupId, personaId] of Object.entries(parsed.groupBindings)) {
            const groupKey = String(groupId || "").trim()
            const id = String(personaId || "").trim()
            if (groupKey && id) groupBindings[groupKey] = id
          }
        }
        state = {
          personas,
          groupBindings,
          privateBinding: String(parsed.privateBinding || "").trim()
        }
      } catch (err) {
        // yaml 手改坏了:沿用上一份好状态,不让人设库拖垮聊天
        logError(`[人设库] 读取失败(${file}),沿用缓存:`, err?.message || err)
        if (cache) return cache
      }
    }
    cache = state
    lastStat = key
    return state
  }

  function saveState(state) {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const header = [
      "# 多人设库:每套人设一个条目,未写的字段回退 message.yaml 默认人设",
      "# 群绑定:groupBindings 填 { 群号: 人设id };privateBinding 为私聊用人设id(留空=默认人设)",
      "# 手动编辑保存后自动生效;也可用 #人设列表/#人设详情/#切换人设/#保存人设/#删除人设 指令管理",
      ""
    ].join("\n")
    fs.writeFileSync(file, header + YAML.stringify(state), "utf8")
    cache = state
    lastStat = statKey()
  }

  function find(idOrName) {
    const key = String(idOrName || "").trim()
    if (!key || key === "default") return null
    const state = loadState()
    return state.personas.find(p => p.id === key) ||
      state.personas.find(p => sameName(p.name, key)) || null
  }

  // 群绑定的人设被删时回退默认,不报错
  function findBound(id) {
    const key = String(id || "").trim()
    if (!key || key === "default") return null
    return loadState().personas.find(p => p.id === key) || null
  }

  function mergePersona(base = {}, entry = {}) {
    const merged = { ...base }
    const normalized = normalizePersonaEntry(entry)
    for (const field of Object.keys(normalized)) merged[field] = normalized[field]
    return merged
  }

  return {
    file,

    // 列表:默认人设 + 库内人设
    list() {
      return [
        { id: "default", name: String(getBasePersona()?.name || "").trim() || "默认", source: "default" },
        ...loadState().personas.map(p => ({ id: p.id, name: p.name, source: "library" }))
      ]
    },

    detail(idOrName) {
      if (!idOrName || idOrName === "default") {
        return { id: "default", source: "default", persona: { ...getBasePersona() } }
      }
      const entry = find(idOrName)
      if (!entry) return null
      return { id: entry.id, source: "library", persona: mergePersona(getBasePersona(), entry) }
    },

    // 以名字为准 upsert:重名覆盖旧条目(保留原 id,绑定关系不断)
    upsert(persona, { preferId = "" } = {}) {
      const name = String(persona?.name || "").trim()
      if (!name) throw new Error("人设名字不能为空")
      const state = loadState()
      const normalized = normalizePersonaEntry(persona)
      normalized.name = name
      const existing = state.personas.find(p => sameName(p.name, name))
      let saved
      if (existing) {
        existing.id = String(preferId || "").trim() || existing.id
        Object.assign(existing, normalized)
        saved = existing
      } else {
        saved = { id: String(preferId || "").trim() || randomId(), ...normalized }
        state.personas.push(saved)
      }
      saveState(state)
      return saved
    },

    remove(idOrName) {
      const entry = find(idOrName)
      if (!entry) return null
      const state = loadState()
      state.personas = state.personas.filter(p => p.id !== entry.id)
      for (const [groupId, personaId] of Object.entries(state.groupBindings)) {
        if (personaId === entry.id) delete state.groupBindings[groupId]
      }
      if (state.privateBinding === entry.id) state.privateBinding = ""
      saveState(state)
      return entry
    },

    // 网页管理页整库读写:导出深拷贝快照,replaceAll 校验后整体落盘
    exportState() {
      const state = loadState()
      return JSON.parse(JSON.stringify({
        personas: state.personas,
        groupBindings: state.groupBindings,
        privateBinding: state.privateBinding
      }))
    },

    replaceAll({ personas = [], groupBindings = {}, privateBinding = "" } = {}) {
      if (!Array.isArray(personas)) throw new Error("personas 必须是数组")
      const seenNames = new Set()
      const seenIds = new Set()
      const cleaned = []
      for (const raw of personas) {
        if (!raw || typeof raw !== "object") continue
        const normalized = normalizePersonaEntry(raw)
        const name = String(normalized.name || "").trim()
        if (!name) throw new Error("有人设没填名字")
        const nameKey = name.toLowerCase()
        if (seenNames.has(nameKey)) throw new Error(`人设名字重复：「${name}」`)
        seenNames.add(nameKey)
        let id = String(raw.id || "").trim()
        if (!id || id === "default" || seenIds.has(id)) id = randomId()
        seenIds.add(id)
        cleaned.push({ id, ...normalized, name })
      }
      const idSet = new Set(cleaned.map(p => p.id))
      const cleanedBindings = {}
      for (const [groupId, personaId] of Object.entries(groupBindings || {})) {
        const groupKey = String(groupId || "").trim()
        const id = String(personaId || "").trim()
        // 指向已删人设的绑定直接丢弃(回默认),不让人设库进入坏状态
        if (groupKey && id && idSet.has(id)) cleanedBindings[groupKey] = id
      }
      const cleanedPrivate = idSet.has(String(privateBinding || "").trim())
        ? String(privateBinding).trim()
        : ""
      const state = { personas: cleaned, groupBindings: cleanedBindings, privateBinding: cleanedPrivate }
      saveState(state)
      return state
    },

    bindings() {
      return { ...loadState().groupBindings, [PRIVATE_BINDING_KEY]: loadState().privateBinding }
    },

    setGroupBinding(groupId, personaId) {
      const key = String(groupId || "").trim()
      if (!key) throw new Error("群号不能为空")
      const state = loadState()
      if (!personaId || personaId === "default") {
        delete state.groupBindings[key]
      } else {
        const entry = findBound(personaId) || find(personaId)
        if (!entry) throw new Error(`没有找到人设「${personaId}」`)
        state.groupBindings[key] = entry.id
      }
      saveState(state)
      return state.groupBindings[key] || "default"
    },

    setPrivateBinding(personaId) {
      const state = loadState()
      if (!personaId || personaId === "default") {
        state.privateBinding = ""
      } else {
        const entry = findBound(personaId) || find(personaId)
        if (!entry) throw new Error(`没有找到人设「${personaId}」`)
        state.privateBinding = entry.id
      }
      saveState(state)
      return state.privateBinding || "default"
    },

    // 当前会话生效人设:群按群绑定,私聊按 privateBinding,否则默认
    resolve({ messageType = "", groupId = "" } = {}) {
      const base = getBasePersona() || {}
      const state = loadState()
      if (messageType === "group" && groupId) {
        const entry = findBound(state.groupBindings[String(groupId)] || "")
        if (entry) {
          return { id: entry.id, source: "library", persona: mergePersona(base, entry) }
        }
      } else if (messageType === "private") {
        const entry = findBound(state.privateBinding)
        if (entry) {
          return { id: entry.id, source: "library", persona: mergePersona(base, entry) }
        }
      }
      return { id: "default", source: "default", persona: { ...base } }
    },

    reload() {
      cache = null
      lastStat = ""
      return loadState()
    }
  }
}
