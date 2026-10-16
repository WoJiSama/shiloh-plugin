import type { ConfigSchemaItem } from '../../../contracts/configSchema.js'
export interface PanelResult {
 ok(data: unknown, message: string): unknown
 error(message: string): unknown
}
export interface ConfigPanelPorts {
 schemas: ConfigSchemaItem[]
 readSettings(): unknown
 applyUpdates(updates: Record<string, unknown>): unknown
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
export function createConfigPanel(ports: ConfigPanelPorts) {
 const fields = new Set(ports.schemas.flatMap(item => item.field ? [item.field] : []))
 function getConfigData() {
  const settings = record(ports.readSettings())
  const result: Record<string, unknown> = {}
  for (const field of fields) {
   const keys = field.split('.')
   let value: unknown = settings
   for (const key of keys) value = record(value)[key]
   if (value === undefined) continue
   let target = result
   for (const key of keys.slice(0, -1)) {
    const child = record(target[key])
    target[key] = child
    target = child
   }
   target[keys.at(-1)!] = structuredClone(value)
  }
  return result
 }
 function setConfigData(data: unknown, { Result }: { Result: PanelResult }) {
  try {
   if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('配置需为字段对象')
   const updates = record(data)
   const unknown = Object.keys(updates).filter(field => !fields.has(field))
   if (unknown.length) throw new Error(`以下配置已转至控制台或不在当前锅巴页面，请刷新后到控制台修改：${unknown.join('、')}`)
   ports.applyUpdates(updates)
   return Result.ok({}, '保存成功 (´。• ᵕ •。`)')
  }
  catch (error) { return Result.error(`保存失败: ${message(error)}`) }
 }
 return { getConfigData, setConfigData }
}
