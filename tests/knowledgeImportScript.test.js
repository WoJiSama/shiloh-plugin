import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importKnowledgeBatches, parseKnowledgeImport, runKnowledgeImportCli } from '../dist/backend/scripts/importKnowledge.js'

test('knowledge import supports text, string arrays and CHIME fields', () => {
  assert.deepEqual(parseKnowledgeImport('  第一条\n\n第二条\r\n', '.txt'), ['第一条', '第二条'])
  assert.deepEqual(parseKnowledgeImport('["第一条", "", "第二条"]', '.json'), ['第一条', '第二条'])
  assert.deepEqual(parseKnowledgeImport(JSON.stringify([{ meme: '梗', meaning: '含义', origin: '出处', type_cn: '分类' }]), '.JSON'), ['「梗」 含义 来源：出处 类型：分类'])
  assert.throws(() => parseKnowledgeImport('{}', '.json'), /JSON 文件必须是数组格式/)
  assert.throws(() => parseKnowledgeImport('[]', '.json'), /JSON 数组为空/)
  assert.throws(() => parseKnowledgeImport('["有效", {}]', '.json'), /非字符串/)
  assert.throws(() => parseKnowledgeImport('x', '.csv'), /不支持的文件格式/)
})

test('knowledge import retries only failed batches and tracks added/duplicate totals', async () => {
  const texts = Array.from({ length: 51 }, (_, i) => `知识${i}`)
  const sizes = []
  const waits = []
  const logs = []
  const result = await importKnowledgeBatches(texts, { async expand(batch) {
    sizes.push(batch.length)
    if (sizes.length === 1) throw Error('临时失败')
    return { added: batch.length - 1 }
  } }, { logger: { log: x => logs.push(x), error: x => logs.push(x) }, sleep: async ms => waits.push(ms) })
  assert.deepEqual(sizes, [50, 50, 1])
  assert.deepEqual(waits, [5000, 1000])
  assert.deepEqual(result, { added: 49, skipped: 2 })
  assert.ok(logs.some(line => line.includes('重试成功')))
})

test('knowledge import CLI loads configured credentials and database path without model calls', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-import-'))
  const configDir = path.join(cwd, 'plugins/shiloh-plugin/config_default')
  const logs = []
  try {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'message.yaml'), 'pluginSettings:\n  embeddingAiConfig:\n    embeddingApiUrl: https://example.invalid/embeddings\n    embeddingApiKey: test-key\n')
    fs.writeFileSync(path.join(cwd, 'input.txt'), '第一条\n第二条\n')
    let passedConfig
    const code = await runKnowledgeImportCli(['input.txt'], { cwd, logger: { log: x => logs.push(x), error: x => logs.push(x) }, createExpander: config => {
      passedConfig = config
      return { expand: async batch => ({ added: batch.length }) }
    } })
    assert.equal(code, 0)
    assert.deepEqual(passedConfig, { apiKey: 'test-key', apiUrl: 'https://example.invalid/embeddings', dbPath: path.join(cwd, 'plugins/shiloh-plugin/database/knowledge-db.ndjson'), model: 'text-embedding-3-small' })
    assert.ok(logs.includes('新增：2 条'))
    assert.equal(await runKnowledgeImportCli(['missing.txt'], { cwd, logger: { log() {}, error() {} } }), 1)
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})
