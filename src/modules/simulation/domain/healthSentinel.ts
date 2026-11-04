/**
 * 健康哨兵（纯函数）：检测后台组件的连环失败与过期，生成结构化告警。
 * 设计原则：不需要每个组件自己报——哨兵主动读它们的状态文件/Redis，统一判定。
 */

export interface HealthAlert {
  component: string
  severity: 'error' | 'warning'
  message: string
  /** 连续失败次数 / 过期小时数 */
  metric: number
  detectedAt: number
}

export interface HealthCheckInput {
  now: number
  /** 全局风格学习记忆（读 style_memory.json） */
  styleMemory?: { aiSummary?: { autoFailureCount?: number; lastAutoAt?: string; lastAutoFailureAt?: string } } | null
  /** 表达学习近期错误（从日志或状态提取） */
  expressionErrors?: number | null
}

const FAILURE_STREAK_THRESHOLD = 10
const STALENESS_HOURS = 48

export function checkHealth(input: HealthCheckInput): HealthAlert[] {
  const alerts: HealthAlert[] = []
  const { now } = input

  // 1. 风格学习自动总结：连环失败
  const summary = input.styleMemory?.aiSummary
  if (summary && Number(summary.autoFailureCount) >= FAILURE_STREAK_THRESHOLD) {
    const lastSuccess = summary.lastAutoAt ? new Date(summary.lastAutoAt).getTime() : 0
    const daysSinceSuccess = lastSuccess > 0 ? Math.floor((now - lastSuccess) / 86400_000) : -1
    alerts.push({
      component: '风格学习·自动总结',
      severity: 'error',
      message: `连续失败 ${summary.autoFailureCount} 次${daysSinceSuccess > 0 ? `，上次成功在 ${daysSinceSuccess} 天前` : '，从未成功过'}——大概率是模型接口配置或网络问题`,
      metric: Number(summary.autoFailureCount),
      detectedAt: now,
    })
  }

  // 2. 风格学习自动总结：过期（成功过但太久没跑）
  if (summary?.lastAutoAt && !alerts.some(a => a.component === '风格学习·自动总结')) {
    const lastAt = new Date(summary.lastAutoAt).getTime()
    if (Number.isFinite(lastAt) && (now - lastAt) > STALENESS_HOURS * 3600_000) {
      const hours = Math.floor((now - lastAt) / 3600_000)
      alerts.push({
        component: '风格学习·自动总结',
        severity: 'warning',
        message: `已 ${hours} 小时未成功运行（正常应每 12 小时总结一次）——可能条件不满足或静默失败`,
        metric: hours,
        detectedAt: now,
      })
    }
  }

  // 3. 表达学习：连环失败
  if (input.expressionErrors !== null && input.expressionErrors !== undefined && input.expressionErrors >= FAILURE_STREAK_THRESHOLD) {
    alerts.push({
      component: '群表达学习·AI 提取',
      severity: 'error',
      message: `连续失败 ${input.expressionErrors} 次——大概率是模型接口配置问题`,
      metric: input.expressionErrors,
      detectedAt: now,
    })
  }

  return alerts
}

export function formatAlerts(alerts: HealthAlert[]): string {
  if (!alerts.length) return ''
  const lines = alerts.map(a =>
    `${a.severity === 'error' ? '🔴' : '🟡'} [${a.component}] ${a.message}`
  )
  return ['⚠️ 后台组件健康告警：', ...lines].join('\n')
}
