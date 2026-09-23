// 输出侧人设守卫统一管线:把原本分散在 apps/test.js 两条发送路径上的
// 润色 + 语气边界 + 坏模式清理收敛为一个有序链,消除两处调用的漂移。
// 两条路径的既有差异在此显式化(而非悄悄分叉):
// - 主回复路径(handleTextResponse):polish=true 且携带 toolName;
// - 通用发送路径(sendSegmentedMessage 的未守卫分支):只做语气边界 + 坏模式清理。
//
// 触发统计:每个阶段记录"是否改动/删了多少字符",坏模式逐条记录命中次数,
// 每 200 次应用输出一行汇总日志——长期零命中的规则就是上下文污染,应退役
// (getOutputGuardStats 可随时取数)。
import { enforcePersonaToneBoundary } from "./personaTonePolicy.js"
import { polishHumanReplyText } from "./replySanitizer.js"
import { personaFeedbackManager } from "../domains/memory/PersonaFeedbackManager.js"

const STATS_SUMMARY_INTERVAL = 200

const guardStats = {
  applications: 0,
  stageHits: { polish: 0, toneBoundary: 0, guardReply: 0 },
  charsRemoved: { polish: 0, toneBoundary: 0, guardReply: 0 },
  patternHits: new Map()
}

export function getOutputGuardStats() {
  return {
    applications: guardStats.applications,
    stageHits: { ...guardStats.stageHits },
    charsRemoved: { ...guardStats.charsRemoved },
    patternHits: Object.fromEntries(guardStats.patternHits)
  }
}

export function resetOutputGuardStats() {
  guardStats.applications = 0
  for (const key of Object.keys(guardStats.stageHits)) guardStats.stageHits[key] = 0
  for (const key of Object.keys(guardStats.charsRemoved)) guardStats.charsRemoved[key] = 0
  guardStats.patternHits.clear()
}

function recordStage(stage, before, after) {
  const removed = Math.max(0, before.length - after.length)
  if (removed > 0) {
    guardStats.stageHits[stage] += 1
    guardStats.charsRemoved[stage] += removed
  }
}

function recordPatternHit(pattern) {
  guardStats.patternHits.set(pattern, (guardStats.patternHits.get(pattern) || 0) + 1)
}

function maybeLogSummary() {
  if (guardStats.applications % STATS_SUMMARY_INTERVAL !== 0) return
  const { stageHits, charsRemoved } = guardStats
  const topPatterns = [...guardStats.patternHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => `${pattern}×${count}`)
    .join("、")
  globalThis.logger?.info?.(
    `[输出守卫] 近${STATS_SUMMARY_INTERVAL}次: 润色${stageHits.polish}次/-${charsRemoved.polish}c ` +
    `语气边界${stageHits.toneBoundary}次/-${charsRemoved.toneBoundary}c ` +
    `坏模式清理${stageHits.guardReply}次/-${charsRemoved.guardReply}c` +
    (topPatterns ? ` 高频命中: ${topPatterns}` : "")
  )
}

/**
 * @param {string} text 模型生成的回复文本
 * @param {object} options
 * @param {string} options.userText      触发本轮的用户原文(用于语气模式判定)
 * @param {string} options.toolName      本轮工具名(工具交付场景收紧语气)
 * @param {string[]} options.botNames    bot 称呼列表(身份追问守卫用)
 * @param {object} options.personaGuard  personaGuard 配置(坏模式表)
 * @param {boolean} options.polish       是否先做拟人化润色(主回复路径为 true)
 * @param {object} options.personaFeedbackManager 可注入替换,测试用
 * @returns {string} 守卫后的文本
 */
export function applyOutputPersonaGuards(text = "", {
  userText = "",
  toolName = "",
  botNames = [],
  personaGuard,
  polish = false,
  personaFeedbackManager: manager = personaFeedbackManager
} = {}) {
  let output = String(text || "")
  guardStats.applications += 1

  if (polish) {
    const polished = polishHumanReplyText(output)
    recordStage("polish", output, polished)
    output = polished
  }
  const bounded = enforcePersonaToneBoundary(output, { userText, toolName })
  recordStage("toneBoundary", output, bounded)
  output = bounded

  const guarded = manager.guardReply(output, personaGuard, {
    userText,
    botNames,
    onPatternHit: recordPatternHit
  })
  recordStage("guardReply", output, guarded)
  output = guarded

  maybeLogSummary()
  return output
}
