// 风控信号感知:疑似风控信号的三级响应(L1记录 / L2加急告警 / L3自动低调模式)。
// 信号源:
//   1. send 响应特征(retcode=100 / wording 命中"风控/频率/禁言/冻结")——由出站闸门逐条喂入
//   2. notice 事件(机器人被禁言)——被动监听,不参与消息捕获/持久化
// 响应:
//   L1 log warn + 失败码 suspected_risk_control(健康报告可见)
//   L2 立即向管理群(健康报告同群)推送加急告警,同一号 10 分钟冷却
//   L3 该号进入"低调模式"(quietMinutes,默认30分钟):闸门的延迟与令牌间隔自动加倍,
//      期满自动恢复;期间再有新信号则续期
// 特征表刻意硬编码:它跟随协议端变化,不属于常改配置;页面只做开关与时长。
import { readUserSettings } from "../configWriter.js"

const ALERT_COOLDOWN_MS = 10 * 60_000
const QUIET_DEFAULT_MINUTES = 30

// send 响应中的疑似风控特征(按命中即记)
const RESPONSE_PATTERNS = [
  { re: /风控/, label: "账号可能被风控" },
  { re: /频率过高|发送过快|操作过于频繁|too\s*fast/i, label: "发送频率限制" },
  { re: /被禁言|禁言中/, label: "处于禁言状态" },
  { re: /frozen|冻结|账号异常/i, label: "账号状态异常" }
]

export function matchRiskResponse(result = {}) {
  const retcode = Number(result?.retcode)
  const wording = String(result?.wording || result?.msg || "")
  if (retcode === 100) return "发送失败码100(经典风控码)"
  for (const item of RESPONSE_PATTERNS) {
    if (item.re.test(wording)) return item.label
  }
  return ""
}

export function createRiskSignalMonitor({
  logger = globalThis.logger,
  getSettings = readUserSettings,
  now = () => Date.now()
} = {}) {
  const bots = new Map()
  const notifyLastAt = new Map()
  const notifySuppressed = new Map()

  const settings = () => {
    const cfg = (getSettings && getSettings()) || {}
    return {
      enabled: cfg?.riskControl?.signalMonitorEnabled !== false,
      quietMinutes: Math.min(720, Math.max(1, Number(cfg?.riskControl?.signalQuietMinutes) || QUIET_DEFAULT_MINUTES)),
      alertGroupId: String(cfg?.mediaRelayAdminReport?.groupId || "").trim()
    }
  }

  const stateOf = botId => {
    let state = bots.get(botId)
    if (!state) {
      state = { count: 0, lastSignalAt: 0, lastAlertAt: 0, quietUntil: 0, lastLabel: "" }
      bots.set(botId, state)
    }
    return state
  }

  const recordFailureSafe = (botId, groupId) => {
    try {
      const runtime = globalThis[Symbol.for("shiloh-plugin.message-pipeline.runtime")]
      runtime?.stats?.recordFailure?.({ botId, groupId, channel: "risk_signal", code: "suspected_risk_control" })
    } catch {}
  }

  const pushToAlertGroup = async text => {
    const { alertGroupId } = settings()
    if (!alertGroupId) return
    const root = globalThis.Bot
    let bot = null
    if (root?.bots) {
      for (const candidate of Object.values(root.bots)) {
        if (typeof candidate?.sendApi === "function") { bot = candidate; break }
      }
    }
    if (typeof bot?.sendApi !== "function") return
    try {
      await bot.sendApi("send_group_msg", { group_id: Number(alertGroupId), message: text })
    } catch (error) {
      logger?.warn?.(`[风控信号] 告警推送失败: ${error?.message || error}`)
    }
  }

  const noteSignal = (botId, label, groupId = "") => {
    const cfg = settings()
    if (!cfg.enabled) return
    const state = stateOf(String(botId || "unknown"))
    state.count += 1
    state.lastSignalAt = now()
    state.lastLabel = label
    state.quietUntil = Math.max(state.quietUntil, now() + cfg.quietMinutes * 60_000)
    logger?.warn?.(`[风控信号] bot=${botId} 特征=${label}（累计${state.count}次，进入低调模式至 ${new Date(state.quietUntil).toLocaleTimeString()}）`)
    recordFailureSafe(botId, groupId)
    if (now() - state.lastAlertAt >= ALERT_COOLDOWN_MS) {
      state.lastAlertAt = now()
      const minutes = cfg.quietMinutes
      void pushToAlertGroup(`⚠️ 疑似风控信号\n机器人：${botId}\n特征：${label}\n已进入低调模式 ${minutes} 分钟（发送延迟与限速间隔加倍），期满自动恢复`)
    }
  }

  /**
   * 出站内容拦截通知:管理群即时可见"什么被拦了"。
   * 同号 10 分钟冷却,冷却期内的拦截聚合计数,下次通知时一并报出。
   */
  const notifyCensorBlock = (botId, groupId = "", excerpt = "") => {
    const { alertGroupId } = settings()
    if (!alertGroupId) return
    const key = `censor:${botId}`
    if (now() - (notifyLastAt.get(key) || 0) < ALERT_COOLDOWN_MS) {
      notifySuppressed.set(key, (notifySuppressed.get(key) || 0) + 1)
      return
    }
    const suppressed = notifySuppressed.get(key) || 0
    notifySuppressed.set(key, 0)
    notifyLastAt.set(key, now())
    const lines = [`🚫 出站内容拦截`, `机器人：${botId}`, `群：${groupId || "-"}`]
    if (excerpt) lines.push(`命中内容：${excerpt}`)
    if (suppressed) lines.push(`（冷却期内另有 ${suppressed} 条被拦截，未逐一通知）`)
    void pushToAlertGroup(lines.join("\n"))
  }

  return {
    /** 出站闸门在每次 send 响应后调用 */
    detectResponse(botId, action, result) {
      if (result && typeof result === "object" && Number(result.retcode) === 0) return
      const label = matchRiskResponse(result)
      if (label) noteSignal(botId, label, String(result?.__groupId || ""))
    },
    /** notice 事件被动监听入口(仅识别机器人被禁言) */
    handleNotice(notice = {}) {
      if (String(notice?.notice_type) !== "group_ban") return
      if (String(notice?.sub_type) !== "ban") return
      const botId = String(notice?.self_id || notice?.botId || "")
      if (notice?.user_id !== undefined && String(notice.user_id) !== botId) return
      noteSignal(botId, `群${notice?.group_id || "?"}中被禁言`, String(notice?.group_id || ""))
    },
    /** 低调模式倍率:正常 1,低调期 2(供闸门放大延迟与令牌间隔) */
    quietFactor(botId = "") {
      const state = bots.get(String(botId || ""))
      if (!state) return 1
      return state.quietUntil > now() ? 2 : 1
    },
    snapshot() {
      const out = {}
      for (const [botId, state] of bots) {
        out[botId] = { ...state, quiet: state.quietUntil > now() }
      }
      return out
    },
    noteSignal,
    notifyCensorBlock
  }
}

// 默认单例:出站闸门直接引用;index.js 安装 notice 监听
const defaultMonitor = createRiskSignalMonitor()
export { defaultMonitor }
export default defaultMonitor

let noticeListener = null
export function installRiskSignalNoticeListener(bot = globalThis.Bot, logger = globalThis.logger) {
  if (noticeListener || typeof bot?.on !== "function") return () => {}
  // 被动观察型监听:只读事件做信号识别,不参与消息捕获/持久化(管道仍是唯一捕获者)
  noticeListener = notice => {
    try { defaultMonitor.handleNotice(notice) } catch (error) {
      logger?.warn?.(`[风控信号] notice 处理异常: ${error?.message || error}`)
    }
  }
  bot.on("notice", noticeListener)
  return () => {
    if (noticeListener) bot.removeListener?.("notice", noticeListener)
    noticeListener = null
  }
}
