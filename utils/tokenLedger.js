// 令牌账本单例：插件 data 目录落盘；三处采集共用（apiClient 全局 / 主回合 / 仿真回合）。
import { createTokenLedger } from '../dist/backend/modules/models/infrastructure/tokenLedger.js'
import path from 'node:path'

const pluginRoot = process.env.CONSOLE_PLUGIN_ROOT || path.resolve('./plugins/shiloh-plugin')

export const tokenLedger = createTokenLedger({
  dataDir: path.join(pluginRoot, 'data'),
  logger: globalThis.logger,
  retentionDays: 90,
})

// 读取 message.yaml 的 pricing.models 覆盖（存在才生效；懒读一次，配置改动重启生效）
try {
  const config = (await import('../model/config.js')).default
  const pricing = config.getConfig('message')?.pluginSettings?.pricing
  if (pricing?.models) {
    const { mergePriceOverrides, DEFAULT_PRICE_TABLE } = await import('../dist/backend/modules/models/domain/modelPrices.js')
    tokenLedger.table = mergePriceOverrides(DEFAULT_PRICE_TABLE, pricing.models)
  }
} catch { /* 配置不可读时用默认价目 */ }

let lastPruneAt = 0
export function recordTokenUsage(entry) {
  const now = Date.now()
  if (now - lastPruneAt > 3_600_000) {
    lastPruneAt = now
    try { tokenLedger.prune() } catch { /* 清扫失败不影响记录 */ }
  }
  tokenLedger.record(entry)
}
