interface Words { plains: string[]; regexes: RegExp[]; size: number }
interface CensorConfig { censorReplaceWords?: unknown; censorBlockWords?: unknown; censorMark?: unknown }
interface Segment { type?: unknown; text?: unknown; data?: Record<string, unknown> }
interface Params { message?: unknown; group_id?: unknown; user_id?: unknown; [key: string]: unknown }
type SendApi = (action: string, params?: Params) => Promise<unknown>
interface Adapter { id?: unknown; uin?: unknown; sendApi?: SendApi }
interface Monitor { notifyCensorBlock?(botId:string,groupId:string,excerpt?:string):void; quietFactor(botId:string):number; detectResponse(botId:string,action:string,result:unknown):void }
interface Logger { warn?(message:string):void;info?(message:string):void }
interface ThrottlePorts { readUserSettings():unknown; getBotRoot(): { bots?: Record<string,Adapter> } | undefined; logger?: Logger; signalMonitor:Monitor;recordCode(botId:string,groupId:string,code:string):void }
function record(value:unknown):Record<string,unknown> {return value&&typeof value==='object'?value as Record<string,unknown>:{} }
export function createOutboundThrottleModule(ports:ThrottlePorts) {
const { readUserSettings, recordCode } = ports
const riskSignalMonitor=ports.signalMonitor
// 出站风控闸门:在 OneBot sendApi 层对"发消息类动作"统一三道工序,
// 对标豹骰(sealdice-core)与青骰(OlivaDiceCore)的行为防护:
//   1. 内容审查(青骰路线,双级词表):拦截级词命中→整条丢弃(失败码 censored_dropped);
//      替换级词命中→替换为脱敏符后照发(失败码 censor_hit)。仅处理文本,CQ 码/媒体段零影响
//   2. 随机延迟(豹骰路线):每条消息发出前随机睡 [下限,上限] ms,模拟打字
//   3. 令牌桶限速:群/私聊独立桶,排队超时丢弃(失败码 throttled_dropped)
// 叠加风控信号感知:每次 send 响应喂给 riskSignalMonitor 识别疑似风控;
// 低调模式期间(被判定疑似风控的号),延迟与令牌间隔自动加倍。
// 非消息类 API(get_group_info/get_credentials 等)零影响直通。
// 配置经控制台"风控管理"页保存,10 秒内热生效,无需重启。

const SEND_ACTIONS = new Set([
  "send_msg",
  "send_group_msg",
  "send_private_msg",
  "send_group_forward_msg",
  "send_private_forward_msg"
])

const SETTINGS_TTL_MS = 10_000
const REPATCH_INTERVAL_MS = 30_000
const ACQUIRE_POLL_MS = 50

function isSendAction(action = "") {
  return SEND_ACTIONS.has(String(action || ""))
}

function computeDelayMs({ delayMinMs = 0, delayMaxMs = 400 } = {}, random = Math.random) {
  const min = Math.max(0, Number(delayMinMs) || 0)
  const max = Math.max(min, Number(delayMaxMs) || 0)
  if (max <= 0) return 0
  return Math.round(min + random() * (max - min))
}

function sleep(ms:number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------- 词表编译(普通词 + /正则/,与 forbiddenWords 同语法) ----------
let wordListCache: {key:string;compiled:Words|null} = { key: "", compiled: null }

function compileWordList(words:unknown) {
  const list = (Array.isArray(words) ? words : [])
    .map(word => String(word || "").trim())
    .filter(Boolean)
  const key = list.join("\n")
  if (wordListCache.key === key && wordListCache.compiled) return wordListCache.compiled
  const plains = []
  const regexes = []
  for (const text of list) {
    if (text.startsWith("/") && text.lastIndexOf("/") > 0) {
      const last = text.lastIndexOf("/")
      try {
        regexes.push(new RegExp(text.slice(1, last), "gi"))
      } catch {
        plains.push(text.toLowerCase())
      }
    } else {
      plains.push(text.toLowerCase())
    }
  }
  const compiled = { plains, regexes, size: list.length }
  wordListCache = { key, compiled }
  return compiled
}

function hitWord(plainText:string, { plains, regexes }:Words) {
  if (!plainText) return false
  const lower = plainText.toLowerCase()
  for (const word of plains) {
    if (lower.includes(word)) return true
  }
  for (const re of regexes) {
    re.lastIndex = 0
    if (re.test(plainText)) return true
  }
  return false
}

function replaceInText(text:unknown, { plains, regexes }:Words, mark:string) {
  let out = String(text || "")
  if (!out) return { text: out, count: 0 }
  let count = 0
  for (const word of plains) {
    // Match against the current text: earlier replacements may change its length.
    const literal = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
    out = out.replace(literal, () => {
      count += 1
      return mark
    })
  }
  for (const re of regexes) {
    re.lastIndex = 0
    out = out.replace(re, () => {
      count += 1
      return mark
    })
  }
  return { text: out, count }
}

// ---------- 文本提取与替换:兼容 CQ 字符串与 segment 数组,只动文本部分 ----------
const CQ_SPLIT = /(\[[^\]]*CQ:[^\]]*\])/g

function censorOutbound({ censorReplaceWords, censorBlockWords, censorMark }:CensorConfig, params:Params = {}) {
  const message = params?.message
  if (message === undefined || message === null) return { dropped: false, replaced: 0, params }
  const blockList = compileWordList(censorBlockWords)
  const replaceList = compileWordList(censorReplaceWords)
  if (!blockList.size && !replaceList.size) return { dropped: false, replaced: 0, params }

  let parts: {kind:string;raw:unknown;seg?:Segment}[] = []
  if (typeof message === "string") {
    parts = message.split(CQ_SPLIT)
      .map(chunk => ({ kind: chunk.startsWith("[") && /CQ:/.test(chunk) ? "cq" : "text", raw: chunk }))
  } else if (Array.isArray(message)) {
    parts = message.map(seg => ({ kind: record(seg).type === "text" ? "text" : "seg", seg: record(seg), raw: record(record(seg).data).text ?? record(seg).text ?? "" }))
  } else if (typeof message === "object" && message) {
    parts = [{ kind: record(message).type === "text" ? "text" : "seg", seg: record(message), raw: record(record(message).data).text ?? record(message).text ?? "" }]
  } else {
    return { dropped: false, replaced: 0, params }
  }

  const fullText = parts.filter(part => part.kind === "text").map(part => part.raw).join("\n")
  if (blockList.size && hitWord(fullText, blockList)) {
    return { dropped: true, replaced: 0, params, excerpt: fullText.replace(/\s+/g, " ").trim().slice(0, 200) }
  }
  if (!replaceList.size) return { dropped: false, replaced: 0, params }

  const mark = String(censorMark || "*")
  let replaced = 0
  const nextParts = parts.map(part => {
    if (part.kind !== "text" || !part.raw) return part
    const result = replaceInText(part.raw, replaceList, mark)
    replaced += result.count
    return { ...part, raw: result.text }
  })
  if (!replaced) return { dropped: false, replaced: 0, params }

  let nextMessage
  if (typeof message === "string") {
    nextMessage = nextParts.map(part => part.raw).join("")
  } else if (Array.isArray(message)) {
    nextMessage = nextParts.map(part => {
      if (part.kind !== "text" || part.seg === undefined) return part.seg !== undefined ? part.seg : part
      return part.seg.data?.text !== undefined
        ? { ...part.seg, data: { ...part.seg.data, text: part.raw } }
        : { ...part.seg, text: part.raw }
    })
  } else {
    nextMessage = nextParts[0]!.seg?.data?.text !== undefined
      ? { ...nextParts[0]!.seg, data: { ...nextParts[0]!.seg.data, text: nextParts[0]!.raw } }
      : { ...nextParts[0]!.seg, text: nextParts[0]!.raw }
  }
  return { dropped: false, replaced, params: { ...params, message: nextMessage } }
}

// ---------- 令牌桶 ----------
/**
 * 纯逻辑令牌桶(惰性补充):acquire 在令牌不足时轮询等待,
 * 超过 maxWaitMs 返回 false(由调用方丢弃并记失败码)。
 */
function createTokenBuckets({ now = () => Date.now() } = {}) {
  const buckets = new Map<string,{tokens:number;burst:number;intervalMs:number;lastRefillAt:number}>()
  const refill = (key:string) => {
    const bucket = buckets.get(key)
    if (!bucket) return null
    const elapsed = now() - bucket.lastRefillAt
    if (elapsed > 0 && bucket.intervalMs > 0) {
      bucket.tokens = Math.min(bucket.burst, bucket.tokens + (elapsed / bucket.intervalMs))
      bucket.lastRefillAt = now()
    }
    return bucket
  }
  return {
    async acquire(key:string, { intervalMs = 3000, burst = 3, maxWaitMs = 8000 } = {}) {
      const deadline = now() + Math.max(0, Number(maxWaitMs) || 0)
      // Refill elapsed time at the previous rate, then apply the new settings.
      // Do this once per caller so an older waiting call cannot revert a hot update.
      let bucket = refill(key)
      const nextBurst = Math.max(1, Number(burst) || 1)
      const nextIntervalMs = Math.max(100, Number(intervalMs) || 3000)
      if (!bucket) {
        bucket = { tokens: nextBurst, burst: nextBurst, intervalMs: nextIntervalMs, lastRefillAt: now() }
        buckets.set(key, bucket)
      } else {
        bucket.burst = nextBurst
        bucket.intervalMs = nextIntervalMs
        bucket.tokens = Math.min(bucket.tokens, nextBurst)
      }
      for (;;) {
        refill(key)
        if (bucket.tokens >= 1) {
          bucket.tokens -= 1
          return true
        }
        if (now() >= deadline) return false
        await sleep(Math.min(ACQUIRE_POLL_MS, Math.max(10, deadline - now())))
      }
    },
    snapshot() {
      const out: Record<string,{tokens:number;burst:number;intervalMs:number}> = {}
      for (const [key, bucket] of buckets) out[key] = { tokens: bucket.tokens, burst: bucket.burst, intervalMs: bucket.intervalMs }
      return out
    }
  }
}

function readRiskControlConfig(getSettings: () => unknown = readUserSettings) {
  const cfg = record(record(getSettings()).riskControl)
  const clampPositive = (value:unknown, fallback:number, max = 60) => {
    const num = Number(value)
    return Number.isFinite(num) && num > 0 ? Math.min(num, max) : fallback
  }
  return {
    enabled: cfg.enabled === true,
    delayMinMs: Math.min(5000, Math.max(0, Number(cfg.delayMinMs) || 0)),
    delayMaxMs: Math.min(10_000, Math.max(Number(cfg.delayMaxMs) || 400, Math.max(0, Number(cfg.delayMinMs) || 0))),
    groupIntervalMs: clampPositive(cfg.groupIntervalSeconds, 3, 600) * 1000,
    groupBurst: Math.min(50, Math.max(1, Math.round(Number(cfg.groupBurst) || 3))),
    privateIntervalMs: clampPositive(cfg.privateIntervalSeconds, 3, 600) * 1000,
    privateBurst: Math.min(50, Math.max(1, Math.round(Number(cfg.privateBurst) || 3))),
    maxWaitMs: clampPositive(cfg.maxWaitSeconds, 8, 300) * 1000,
    censorEnabled: cfg.censorEnabled === true,
    censorMark: String(cfg.censorMark || "*").slice(0, 8) || "*",
    censorReplaceWords: Array.isArray(cfg.censorReplaceWords) ? cfg.censorReplaceWords : [],
    censorBlockWords: Array.isArray(cfg.censorBlockWords) ? cfg.censorBlockWords : []
  }
}

function bucketKeyForHelper(action:string, params:Params = {}, botId = "") {
  const groupId = String(params?.group_id ?? "").trim()
  if (groupId) return `g:${botId}:${groupId}`
  const userId = String(params?.user_id ?? "").trim()
  if (userId) return `p:${botId}:${userId}`
  return ""
}

/**
 * 包装每个 bot 适配器的 sendApi。三道工序互相独立开关:
 * 审查(censorEnabled)不看闸门开关;风控信号检测永远运行(signalMonitorEnabled 控制)。
 * 适配器重连/热重载会重建对象,定时重扫补挂。stop() 只停重扫;
 * 关闭功能用页面开关(热生效),包装器在关闭时零改动直通。
 */
function installOutboundThrottle({
  logger = ports.logger,
  getSettings = readUserSettings,
  getBotRoot = ports.getBotRoot,
  signalMonitor = riskSignalMonitor
} = {}) {
  const patched = new WeakSet()
  const buckets = createTokenBuckets()
  let cachedAt = 0
  let cachedConfig: ReturnType<typeof readRiskControlConfig> | null = null
  let repatchTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  const config = () => {
    if (!cachedConfig || Date.now() - cachedAt > SETTINGS_TTL_MS) {
      cachedConfig = readRiskControlConfig(getSettings)
      cachedAt = Date.now()
    }
    return cachedConfig
  }

  const gate = async (adapter:Adapter, original:SendApi, action:string, params:Params = {}) => {
    if (!isSendAction(action)) {
      return await original.call(adapter, action, params)
    }
    const cfg = config()
    const botId = String(adapter?.id || adapter?.uin || "")
    const groupId = String(params?.group_id || "")

    if (cfg.censorEnabled) {
      const censored = censorOutbound(cfg, params)
      if (censored.dropped) {
        logger?.warn?.(`[出站审查] 拦截级词命中,整条丢弃 bot=${botId} action=${action}（失败码 censored_dropped）`)
        recordCode(botId, groupId, "censored_dropped")
        try { signalMonitor.notifyCensorBlock?.(botId, groupId, censored.excerpt) } catch {}
        return { status: "failed", retcode: 1201, wording: "内容审查:命中拦截词已丢弃" }
      }
      if (censored.replaced > 0) {
        params = censored.params
        logger?.info?.(`[出站审查] 替换级词命中 ${censored.replaced} 处 bot=${botId}（失败码 censor_hit）`)
        recordCode(botId, groupId, "censor_hit")
      }
    }

    if (cfg.enabled) {
      const quiet = signalMonitor.quietFactor(botId)
      const delayMs = computeDelayMs(cfg) * quiet
      if (delayMs > 0) await sleep(delayMs)
      const key = bucketKeyForHelper(action, params, botId)
      if (key) {
        const isGroup = key.startsWith("g:")
        const ok = await buckets.acquire(key, {
          intervalMs: (isGroup ? cfg.groupIntervalMs : cfg.privateIntervalMs) * quiet,
          burst: isGroup ? cfg.groupBurst : cfg.privateBurst,
          maxWaitMs: cfg.maxWaitMs
        })
        if (!ok) {
          logger?.warn?.(`[风控闸门] 令牌耗尽丢弃发送 action=${action} bot=${botId} key=${key}（失败码 throttled_dropped）`)
          recordCode(botId, groupId, "throttled_dropped")
          return { status: "failed", retcode: 1200, wording: "风控限流:本条已丢弃" }
        }
      }
    }

    const result = await original.call(adapter, action, params)
    try {
      signalMonitor.detectResponse(botId, action, result)
    } catch {}
    return result
  }

  const patchAdapter = (adapter:Adapter) => {
    if (!adapter || typeof adapter.sendApi !== "function" || patched.has(adapter)) return false
    const original = adapter.sendApi
    patched.add(adapter)
    adapter.sendApi = function (action, params) {
      return gate(adapter, original, action, params)
    }
    return true
  }

  const patchAll = () => {
    if (stopped) return
    const root = getBotRoot()
    let count = 0
    for (const bot of Object.values(root?.bots || {})) {
      if (patchAdapter(bot)) count++
    }
    if (count) logger?.info?.(`[风控闸门] 已挂载 ${count} 个 bot 适配器（审查/延迟/令牌桶可独立开关,页面配置热生效）`)
  }

  patchAll()
  repatchTimer = setInterval(patchAll, REPATCH_INTERVAL_MS)
  repatchTimer.unref?.()

  return () => {
    stopped = true
    if (repatchTimer) clearInterval(repatchTimer)
  }
}
return { isSendAction, computeDelayMs, compileWordList, censorOutbound, createTokenBuckets, readRiskControlConfig, bucketKeyForHelper, installOutboundThrottle }
}
