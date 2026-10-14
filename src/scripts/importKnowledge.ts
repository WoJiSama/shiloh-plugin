import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import KnowledgeExpander from '../modules/knowledge/infrastructure/KnowledgeExpander.js'
import type { KnowledgeConfig } from '../modules/knowledge/domain/knowledgeData.js'

export interface KnowledgeImportLog { log(message: string): void; error(message: string): void }
export interface KnowledgeImportExpander { expand(texts: string[]): Promise<{ added: number }> }
export interface KnowledgeImportPorts {
  cwd?: string
  logger?: KnowledgeImportLog
  sleep?: (ms: number) => Promise<void>
  createExpander?: (config: KnowledgeConfig) => KnowledgeImportExpander
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}

export function parseKnowledgeImport(raw: string, extension: string): string[] {
  const ext = extension.toLowerCase()
  if (ext === '.txt') return raw.split('\n').map(line => line.trim()).filter(Boolean)
  if (ext !== '.json') throw new Error(`不支持的文件格式: ${ext}（支持 .txt 和 .json）`)
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error('JSON 文件必须是数组格式')
  if (!data.length) throw new Error('JSON 数组为空')
  if (typeof data[0] === 'string') {
    const items: unknown[] = data
    if (items.some(item => Boolean(item) && typeof item !== 'string')) {
      throw new Error('JSON 字符串数组包含非字符串条目')
    }
    return items.filter((item): item is string => typeof item === 'string' && Boolean(item))
  }
  if (!record(data[0]).meme) throw new Error('JSON 格式不支持，需要字符串数组或 CHIME 格式对象数组')
  return (data as unknown[]).map(value => {
    const item = record(value)
    const parts = [`「${String(item.meme)}」`]
    if (item.meaning) parts.push(String(item.meaning))
    if (item.origin) parts.push(`来源：${String(item.origin)}`)
    if (item.type_cn) parts.push(`类型：${String(item.type_cn)}`)
    return parts.join(' ')
  })
}

export async function importKnowledgeBatches(
  texts: string[], expander: KnowledgeImportExpander,
  { logger = console, sleep: wait = sleep }: Pick<KnowledgeImportPorts, 'logger' | 'sleep'> = {}
): Promise<{ added: number; skipped: number }> {
  const batchSize = 50
  let added = 0
  let skipped = 0
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const batchNum = Math.floor(i / batchSize) + 1
    logger.log(`[${batchNum}/${Math.ceil(texts.length / batchSize)}] 正在导入第 ${i + 1}-${i + batch.length} 条...`)
    try {
      const result = await expander.expand(batch)
      added += result.added
      skipped += batch.length - result.added
      logger.log(`  新增 ${result.added} 条，跳过重复 ${batch.length - result.added} 条`)
    } catch (error) {
      logger.error(`  批次 ${batchNum} 导入失败: ${errorMessage(error)}`)
      logger.log('  等待 5 秒后重试...')
      await wait(5000)
      try {
        const result = await expander.expand(batch)
        added += result.added
        skipped += batch.length - result.added
        logger.log(`  重试成功：新增 ${result.added} 条`)
      } catch (retryError) {
        logger.error(`  重试也失败: ${errorMessage(retryError)}，跳过该批次`)
      }
    }
    if (i + batchSize < texts.length) await wait(1000)
  }
  return { added, skipped }
}

export async function runKnowledgeImportCli(argv: string[], ports: KnowledgeImportPorts = {}): Promise<number> {
  const logger = ports.logger ?? console
  const inputFile = argv[0]
  if (!inputFile) {
    logger.log(`知识库批量导入脚本

用法: node plugins/shiloh-plugin/scripts/import-knowledge.js <文件路径>

支持格式:
  .txt  - 每行一条知识（空行自动跳过）
  .json - 字符串数组 或 CHIME 格式对象数组

示例:
  node plugins/shiloh-plugin/scripts/import-knowledge.js ./my-knowledge.txt
  node plugins/shiloh-plugin/scripts/import-knowledge.js C:/bot/chime/data/chime_full.json`)
    return 0
  }
  const cwd = ports.cwd ?? process.cwd()
  const filePath = path.resolve(cwd, inputFile)
  if (!fs.existsSync(filePath)) {
    logger.error(`文件不存在: ${filePath}`)
    return 1
  }
  const pluginRoot = path.join(cwd, 'plugins/shiloh-plugin')
  const configPath = path.join(pluginRoot, 'config/message.yaml')
  const defaultPath = path.join(pluginRoot, 'config_default/message.yaml')
  const settings = record(record(YAML.parse(fs.readFileSync(fs.existsSync(configPath) ? configPath : defaultPath, 'utf8'))).pluginSettings)
  const embedding = record(settings.embeddingAiConfig)
  if (typeof embedding.embeddingApiUrl !== 'string' || !embedding.embeddingApiUrl ||
      typeof embedding.embeddingApiKey !== 'string' || !embedding.embeddingApiKey) {
    logger.error('请先在 config/message.yaml 中配置 embeddingAiConfig（embeddingApiUrl 和 embeddingApiKey）')
    return 1
  }
  let texts: string[]
  try {
    texts = parseKnowledgeImport(await readFile(filePath, 'utf8'), path.extname(filePath))
  } catch (error) {
    if (error instanceof SyntaxError) throw error
    logger.error(errorMessage(error))
    return 1
  }
  logger.log(`文件: ${filePath}`)
  logger.log(`共 ${texts.length} 条，开始导入...\n`)
  const dataDir = path.join(pluginRoot, 'database')
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'knowledge-db.ndjson')
  const createExpander = ports.createExpander ?? (config => new KnowledgeExpander(config))
  const expander = createExpander({
    apiKey: embedding.embeddingApiKey,
    apiUrl: embedding.embeddingApiUrl,
    dbPath,
    model: typeof embedding.embeddingApiModel === 'string' && embedding.embeddingApiModel
      ? embedding.embeddingApiModel : 'text-embedding-3-small'
  })
  const result = await importKnowledgeBatches(texts, expander, {
    logger, ...(ports.sleep ? { sleep: ports.sleep } : {})
  })
  logger.log('\n导入完成！')
  logger.log(`新增：${result.added} 条`)
  logger.log(`跳过重复：${result.skipped} 条`)
  logger.log(`知识库文件：${dbPath}`)
  return 0
}
