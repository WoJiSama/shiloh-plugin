import { createConfigRepository } from '../dist/backend/modules/config/infrastructure/configRepository.js'
import path from "path"

const _path = process.cwd()
const USER_CONFIG_PATH = path.join(_path, "plugins/shiloh-plugin/config/message.yaml")
const DEFAULT_CONFIG_PATH = path.join(_path, "plugins/shiloh-plugin/config_default/message.yaml")

const repository = createConfigRepository({ file: USER_CONFIG_PATH, defaultFile: DEFAULT_CONFIG_PATH });
export function readUserSettings() {
  try { return repository.read().settings }
  catch (error) { globalThis.logger?.warn?.(`[configWriter] 读取用户配置失败: ${error.message}`); return {} }
}
export function applyFlatUpdates(updates) { return repository.updateFlat(updates || {}) }
