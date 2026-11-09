// 承诺账本壳:dist 工厂 + Yunzai 全局注入。wakeSim/isSimulationGroup 走动态 import
// 拿仿真运行时单例(静态引用会与 localToolRegistry 形成装载环)。
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {createCommitmentRuntime} from '../../dist/backend/modules/commitments/infrastructure/commitmentTool.js'

function readPluginSettings() {
  const root = process.cwd()
  const candidates = [
    path.join(root, 'plugins/shiloh-plugin/config/message.yaml'),
    path.join(root, 'config/message.yaml'),
    path.join(root, 'plugins/shiloh-plugin/config_default/message.yaml'),
    path.join(root, 'config_default/message.yaml')
  ]
  const configPath = candidates.find(file => fs.existsSync(file))
  if (!configPath) return {}
  const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'))
  return parsed && typeof parsed === 'object' ? parsed.pluginSettings || {} : {}
}

const runtime = createCommitmentRuntime({
  redis: globalThis.redis,
  logger: globalThis.logger || {},
  getBot: id => id ? (String(globalThis.Bot?.uin) === id ? globalThis.Bot : globalThis.Bot?.[id]) : globalThis.Bot,
  isSimulationGroup: async gid => {
    try {
      const { simulationRuntime } = await import('../utils/simulationRuntime.js')
      return Boolean(simulationRuntime?.isGroupActive?.(gid))
    } catch { return false }
  },
  wakeSim: async (gid, card) => {
    const { simulationRuntime } = await import('../utils/simulationRuntime.js')
    await simulationRuntime?.wakeForCommitment?.(gid, card)
  },
  loadConfig: () => readPluginSettings().commitments || {}
})

export const CommitmentTool = runtime.CommitmentTool
export const commitmentTick = runtime.commitmentTick
