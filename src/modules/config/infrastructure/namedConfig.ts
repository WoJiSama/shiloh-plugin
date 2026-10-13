import path from 'node:path'
import { createConfigRepository } from './configRepository.js'
export interface ConfigWatcher { on(event: string, callback: (...args: unknown[]) => void): unknown; close(): Promise<unknown> }
export interface NamedConfigPorts {
 configPath: string
 watch(file: string): ConfigWatcher
 logger: { mark(message: string): void; error(message: string, error: unknown): void }
 equal(a: unknown, b: unknown): boolean
 isEmpty(value: unknown): boolean
}
function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须为对象')
 return value as Record<string, unknown>
}
export function createNamedConfig(ports: NamedConfigPorts) {
 const previousContent = new Map<string, unknown>()
 const watchers = new Map<string, ConfigWatcher>()
 function getFilePath(name: string) {
  if (!name || name.includes('/') || name.includes('\\') || name === '..') throw new Error('无效配置名称')
  return path.resolve(ports.configPath, `${name}.yaml`)
 }
 const repository = (name: string) => createConfigRepository({ file: getFilePath(name) })
 function watch(file: string, name: string) {
  if (watchers.has(name)) return
  const watcher = ports.watch(file)
  watcher.on('change', () => {
   try {
    const current = repository(name).read().document.toJS() as unknown
    if (!ports.equal(previousContent.get(name), current)) {
     ports.logger.mark(`[shiloh-plugin][配置文件]：${name}已被重新加载`)
     previousContent.set(name, current)
    }
   } catch (error) { ports.logger.error(`[shiloh-plugin][配置文件]：${name}读取失败`, error) }
  })
  watcher.on('unlink', () => { previousContent.delete(name) })
  watcher.on('error', error => { ports.logger.error(`[shiloh-plugin][配置文件]：${name}监听失败`, error) })
  watchers.set(name, watcher)
 }
 function getYaml(name: string, isWatch = true): unknown {
  const value: unknown = repository(name).read().document.toJS()
  previousContent.set(name, value)
  if (isWatch) watch(getFilePath(name), name)
  return value
 }
 function saveAllConfig(name: string, data: unknown) {
  if (ports.isEmpty(data)) { repository(name).remove(); previousContent.delete(name) }
  else { repository(name).update(doc => { doc.setIn([], data) }); previousContent.set(name, data) }
  watch(getFilePath(name), name)
 }
 function updateField(name: string, field: string, value: unknown) {
  repository(name).update(doc => { doc.set(field, value) })
  ports.logger.mark(`[shiloh-plugin][修改配置项][${name}][${field}]已更新`)
  getYaml(name)
 }
 function deleteField(name: string, field: string) {
  const repo = repository(name)
  const snapshot = repo.update(doc => { doc.delete(field) })
  const data: unknown = snapshot.document.toJS()
  if (ports.isEmpty(data)) repo.remove({ expectedRevision: snapshot.revision })
  previousContent.set(name, data)
  watch(getFilePath(name), name)
 }
 async function closeWatchers() { for (const watcher of watchers.values()) await watcher.close().catch(() => {}); watchers.clear() }
 return { configPath: ports.configPath, previousContent, watchers, getConfig: getYaml, getYaml, getField: (name: string, field: string) => object(getYaml(name))[field], updateField, deleteField, getFilePath, watch, saveAllConfig, closeWatchers }
}
