import { extractValidBtihMagnetUri } from "./torrentDownload.js"

// 磁链下载 / B站、抖音视频解析等分钟级长任务：有自己的完成回执流程，
// 进入时提前释放 smart 锁，避免一个任务把整个群的触发挂住
const LONG_RUNNING_TASK_LINK_PATTERN = /b23\.tv|bilibili\.com\/video\/|bilibili\.com\/bangumi\/play\/|v\.douyin\.com|douyin\.com\/video\//i

export function isLongRunningTaskLinkRequest(text = "") {
  const content = String(text || "")
  if (!content) return false
  if (extractValidBtihMagnetUri(content)) return true
  return LONG_RUNNING_TASK_LINK_PATTERN.test(content)
}

/**
 * smart 会话锁看门狗：一轮对话若因模型请求/redis/工具挂死而永不返回，
 * inFlight 会卡死该群所有后续触发（全部只进 [SmartQueue] 排队）。
 * 超时后回调 onForceRelease(watchedToken) 强制释放并补跑排队消息，
 * 把"整群永久静默"降级为"这一轮丢失"。
 *
 * 状态挂在 state 上：inFlight / inFlightToken / inFlightSince / inFlightWatchdog。
 * token 轮转保证：看门狗释放后新轮次拿到的锁，不会被旧轮次迟到的 finally 误释放。
 */
export function armSmartLockWatchdog(state, { timeoutMs, logger, onForceRelease }) {
  if (!state) return
  if (state.inFlightWatchdog) clearTimeout(state.inFlightWatchdog)
  const budget = Math.max(0, Number(timeoutMs) || 0)
  if (budget <= 0) {
    state.inFlightWatchdog = null
    return
  }
  const watchedToken = state.inFlightToken
  state.inFlightWatchdog = setTimeout(() => {
    state.inFlightWatchdog = null
    if (!state.inFlight || state.inFlightToken !== watchedToken) return
    const heldMs = Date.now() - (state.inFlightSince || Date.now())
    logger?.error?.(`[SmartLock] 会话锁持有 ${Math.round(heldMs / 1000)}s 未释放（疑似挂死），强制释放并补跑排队消息 queued=${state.queuedWhileInFlight || 0} needsRerun=${!!state.needsRerun}`)
    onForceRelease?.(watchedToken)
  }, budget)
}

export function clearSmartLockWatchdog(state) {
  if (!state?.inFlightWatchdog) return
  clearTimeout(state.inFlightWatchdog)
  state.inFlightWatchdog = null
}
