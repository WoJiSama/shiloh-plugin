import { createRiskSignalMonitor, matchRiskResponse } from '../modules/messaging/application/riskSignalMonitor.js'
import type { RiskMonitorPorts } from '../modules/messaging/application/riskSignalMonitor.js'
interface Bot { sendApi?(action: string, params: Record<string, unknown>): Promise<unknown>; bots?: Record<string, Bot>; on?(event: string, listener: (notice: unknown) => void): void; removeListener?(event: string, listener: (notice: unknown) => void): void }
interface Logger { warn?(message: string): void }
interface Runtime { stats?: { recordFailure?(input: Record<string, unknown>): void } }
interface Ports { getBot(): Bot | undefined; getLogger(): Logger | undefined; getRuntime(): Runtime | undefined; getSettings(): unknown }
export function createLegacyRiskMonitor(ports: Ports) {
  const create = (options: RiskMonitorPorts = {}) => createRiskSignalMonitor({
    logger: { warn: message => ports.getLogger()?.warn?.(message) },
    getSettings: ports.getSettings,
    recordFailure: (botId, groupId) => ports.getRuntime()?.stats?.recordFailure?.({ botId, groupId, channel: 'risk_signal', code: 'suspected_risk_control' }),
    sendAlert: async (groupId, text) => {
      const bot = Object.values(ports.getBot()?.bots || {}).find(item => typeof item.sendApi === 'function')
      return bot?.sendApi?.('send_group_msg', { group_id: Number(groupId), message: text })
    }, ...options
  })
  const defaultMonitor = create()
  let listener: ((notice: unknown) => void) | null = null
  function installRiskSignalNoticeListener(bot = ports.getBot(), logger = ports.getLogger()) {
    if (listener || typeof bot?.on !== 'function') return () => {}
    const attached = (notice: unknown) => { try { defaultMonitor.handleNotice(notice) } catch (error) { logger?.warn?.(`[风控信号] notice 处理异常: ${error instanceof Error ? error.message : String(error)}`) } }
    listener = attached
    bot.on('notice', attached)
    return () => { if (listener === attached) { bot.removeListener?.('notice', attached); listener = null } }
  }
  return { createRiskSignalMonitor: create, matchRiskResponse, defaultMonitor, installRiskSignalNoticeListener }
}
