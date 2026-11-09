// 委托记忆壳:dist 工厂 + Yunzai redis 注入。store 单例同时供仿真唤醒注入端口读取。
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {createDelegateMemoryRuntime} from '../../dist/backend/modules/memory/infrastructure/delegateMemoryTool.js'

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

const runtime = createDelegateMemoryRuntime({
  redis: globalThis.redis,
  logger: globalThis.logger || {},
  loadConfig: () => readPluginSettings().delegatedMemory || {}
})

export const DelegateMemoryTool = runtime.DelegateMemoryTool
export const delegatedMemoryStore = runtime.store
