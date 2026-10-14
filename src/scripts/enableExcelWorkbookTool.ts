import fs from 'node:fs'
import YAML from 'yaml'

export const defaultExcelWorkbookConfigPath = '/opt/trss-yunzai/plugins/shiloh-plugin/config/message.yaml'
export interface ExcelWorkbookEnablePorts {
  readFile?: (file: string) => string
  writeFile?: (file: string, content: string) => void
  logger?: { log(message: string): void }
}
const toolName = (value: unknown) => String(value).replace(/\(.*\)$/, '')

export function enableExcelWorkbookTool(configPath = defaultExcelWorkbookConfigPath, ports: ExcelWorkbookEnablePorts = {}): boolean {
  const readFile = ports.readFile ?? (file => fs.readFileSync(file, 'utf8'))
  const writeFile = ports.writeFile ?? ((file, content) => fs.writeFileSync(file, content, 'utf8'))
  const document = YAML.parseDocument(readFile(configPath))
  if (document.errors.length) throw new Error(`配置 YAML 解析失败: ${document.errors[0]?.message}`)
  let tools: unknown = document.getIn(['pluginSettings', 'oneapi_tools'], true)
  if (!tools) {
    document.setIn(['pluginSettings', 'oneapi_tools'], document.createNode(['excelWorkbookTool']))
    tools = document.getIn(['pluginSettings', 'oneapi_tools'], true)
  }
  if (!YAML.isSeq(tools)) throw new Error('pluginSettings.oneapi_tools 必须为数组')
  const existing = (tools.items as unknown[]).map(item => YAML.isScalar(item) ? item.value as unknown : item)
  if (!existing.some(item => toolName(item) === 'excelWorkbookTool')) tools.add('excelWorkbookTool')
  writeFile(configPath, document.toString())
  const enabled = (tools.items as unknown[]).some(item => toolName(YAML.isScalar(item) ? item.value as unknown : item) === 'excelWorkbookTool')
  ;(ports.logger ?? console).log(`excelWorkbookTool enabled=${enabled}`)
  return enabled
}
