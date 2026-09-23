import fs from "node:fs"
import path from "node:path"

/**
 * 插件观测日志:把关键 info 级日志(工具调用/路由决策/模型耗时/媒体链路)
 * 复制一份到独立文件,解决 Yunzai logger.info 只走 stdout 不落盘、
 * 线上排障全靠 Redis/NapCat 反推的问题。
 *
 * 设计约束:
 * - 不碰 Yunzai 核心(log4js.configure 是全局重置,插件侧不能调)
 * - 只 tee,不吞:包装 logger.info,匹配标签才落盘,原行为不变
 * - 按天分文件,启动时清理超期文件,自带轮转
 */

const DEFAULT_TAG_PATTERN = /^\[(?:工具调用|工具选择|工具兜底|工具漏调|工具快路|执行计划|模型耗时|模型简报|语义工具分类|语义规划|路由|快路|TimingGate|MediaOutbox|MediaTiming|MediaArtifactStore|MessagePipeline|MessageArchive|消息合并|卡面呈现|回复失败|抖音|YouTube|Pixiv|B站|磁链|表情包|EmojiPack|LocalToolRegistry|红色表情包|群工作流|记忆|生图|识图|修图|forward|OutboundArbiter|观测)/
const ANSI_PATTERN = /^[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/
const DEFAULT_RETENTION_DAYS = 14

const state = {
  installed: false,
  dir: "",
  retentionDays: DEFAULT_RETENTION_DAYS,
  tagPattern: DEFAULT_TAG_PATTERN,
  queue: [],
  flushing: false,
  writeCount: 0
}

function dayStamp(now = new Date()) {
  const pad = n => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function currentFile(now = new Date()) {
  return path.join(state.dir, `${dayStamp(now)}.log`)
}

function cleanText(value) {
  return String(value)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function enqueue(line) {
  state.queue.push(line)
  state.writeCount += 1
  if (state.queue.length > 200) state.queue.splice(0, state.queue.length - 200)
  scheduleFlush()
}

function scheduleFlush() {
  if (state.flushing) return
  state.flushing = true
  setTimeout(() => {
    state.flushing = false
    flush().catch(() => {})
  }, 500).unref?.()
}

async function flush() {
  if (!state.queue.length) return
  const lines = state.queue.splice(0, state.queue.length)
  try {
    await fs.promises.appendFile(currentFile(), lines.join("\n") + "\n", "utf8")
  } catch {}
}

/** 提取标签后的可读内容:跳过彩色的 [TRSSYz] 前缀参数 */
function extractTeedLine(args = []) {
  const parts = []
  for (const arg of args) {
    if (typeof arg !== "string") continue
    if (ANSI_PATTERN.test(arg)) continue
    parts.push(cleanText(arg))
  }
  const text = parts.join(" ")
  return text ? `[${dayStamp(new Date())} ${new Date().toTimeString().slice(0, 8)}] ${text}`.replace(`[${dayStamp(new Date())} `, "[") : ""
}

function teeInfo(args = []) {
  try {
    if (!state.installed) return
    for (const arg of args) {
      if (typeof arg !== "string" || ANSI_PATTERN.test(arg)) continue
      if (state.tagPattern.test(arg)) {
        const line = extractTeedLine(args)
        if (line) enqueue(line)
        return
      }
    }
  } catch {}
}

async function pruneExpiredFiles() {
  try {
    const files = await fs.promises.readdir(state.dir).catch(() => [])
    const cutoff = Date.now() - Math.max(1, state.retentionDays) * 86400_000
    for (const file of files) {
      const match = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/)
      if (!match) continue
      const date = new Date(`${match[1]}T23:59:59+08:00`)
      if (Number.isFinite(date.getTime()) && date.getTime() < cutoff) {
        await fs.promises.unlink(path.join(state.dir, file)).catch(() => {})
      }
    }
  } catch {}
}

/**
 * 安装观测日志:包装 global.logger.info,匹配标签的调用复制到
 * logs/shiloh-obs/<日期>.log。幂等,重复调用无副作用。
 */
export function installObservabilityLog({
  cwd = process.cwd(),
  enabled = true,
  retentionDays = DEFAULT_RETENTION_DAYS,
  tagPattern = null,
  logger = globalThis.logger
} = {}) {
  if (state.installed || !enabled) return state
  if (!logger || typeof logger.info !== "function") return state

  state.dir = path.join(cwd, "logs", "shiloh-obs")
  state.retentionDays = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS)
  if (tagPattern instanceof RegExp) state.tagPattern = tagPattern

  fs.promises.mkdir(state.dir, { recursive: true }).catch(() => {})
  pruneExpiredFiles().catch(() => {})

  const originalInfo = logger.info.bind(logger)
  logger.info = (...args) => {
    teeInfo(args)
    return originalInfo(...args)
  }
  state.installed = true
  originalInfo(`[观测] 观测日志已启用: ${state.dir} (保留 ${state.retentionDays} 天)`)
  return state
}

/** 读最近 N 行(查询命令用) */
export async function readObservabilityTail(lines = 80) {
  await flush().catch(() => {})
  const files = (await fs.promises.readdir(state.dir).catch(() => [])).filter(f => f.endsWith(".log")).sort()
  const wanted = Math.max(1, Math.min(500, Number(lines) || 80))
  const collected = []
  for (const file of files.reverse()) {
    if (collected.length >= wanted) break
    const text = await fs.promises.readFile(path.join(state.dir, file), "utf8").catch(() => "")
    const rows = text.split("\n").filter(Boolean)
    collected.unshift(...rows.slice(-wanted))
  }
  return collected.slice(-wanted)
}

export function getObservabilityState() {
  return { installed: state.installed, dir: state.dir, retentionDays: state.retentionDays, writeCount: state.writeCount }
}

/** 测试辅助 */
export function resetObservabilityForTest() {
  state.installed = false
  state.queue.length = 0
  state.writeCount = 0
  state.tagPattern = DEFAULT_TAG_PATTERN
  state.retentionDays = DEFAULT_RETENTION_DAYS
}
