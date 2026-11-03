/** 生物节律（纯函数）：作息窗口判定、分时活跃系数、深夜/旧消息提示。 */

export interface RhythmWindow { sleepFrom: number; sleepTo: number }

/** 当前是否在睡眠窗口（小时，支持跨午夜：from 23 to 7） */
export function isSleeping(hour: number, rhythm: RhythmWindow): boolean {
  if (rhythm.sleepFrom < rhythm.sleepTo) return hour >= rhythm.sleepFrom && hour < rhythm.sleepTo
  return hour >= rhythm.sleepFrom || hour < rhythm.sleepTo
}

/** 分时活跃系数（乘在概率触发上）：深夜低、工作时间中、傍晚高——像真人的在线曲线 */
export function activityFactor(hour: number): number {
  if (hour >= 1 && hour < 6) return 0.15
  if (hour >= 6 && hour < 9) return 0.7
  if (hour >= 9 && hour < 12) return 1.0
  if (hour >= 12 && hour < 14) return 0.6
  if (hour >= 14 && hour < 18) return 1.0
  if (hour >= 18 && hour < 23) return 1.2
  return 0.7 // 23-1 收尾时段
}

/** 深夜被强行唤醒（@）时的语气提示；白天返回空 */
export function sleepinessNote(hour: number, rhythm: RhythmWindow): string {
  return isSleeping(hour, rhythm)
    ? `（现在是你的睡眠时间（${rhythm.sleepFrom}:00-${rhythm.sleepTo}:00），你被点名吵醒了——可以回应，但带点困意：话更短、反应更慢，困了就直说想睡）`
    : ''
}

/** 旧消息时间感：最新一条未读距现在已经超过阈值时，提示"你可能刚看到" */
export function staleMessageNote(latestIncomingAt: number, now: number, thresholdMs = 30 * 60_000): string {
  if (!latestIncomingAt) return ''
  const ageMin = Math.floor((now - latestIncomingAt) / 60_000)
  if (ageMin < thresholdMs / 60_000) return ''
  return ageMin >= 60
    ? `（这些消息是一个多小时前的，你才刚看到——回应时自然带出"刚看到/才注意到"，别装作实时在场的样子）`
    : `（这些消息是 ${ageMin} 分钟前的，你才刚看到）`
}
