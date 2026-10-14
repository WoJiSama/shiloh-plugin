import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { runBilibiliBackfillCli } from '../dist/backend/scripts/backfillBilibiliRecords.js'
import { enableExcelWorkbookTool } from '../dist/backend/scripts/enableExcelWorkbookTool.js'

test('Bilibili backfill filters message IDs, preserves malformed archive lines and Redis expiry', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bilibili-backfill-'))
  try {
    const dir = path.join(cwd, 'data/message_archive/group/123')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'sample.ndjson')
    const records = [{ message_id: 1, message: [{ type: 'text', text: 'x', arbitrary: 42 }], raw_message: 'x' }, { message_id: 2, message: [{ type: 'text', text: 'y' }], raw_message: 'y' }]
    fs.writeFileSync(file, `${JSON.stringify(records[0])}\nbroken-json\n${JSON.stringify(records[1])}\n`, { mode: 0o640 })
    const calls = []
    const enrichCalls = []
    const result = await runBilibiliBackfillCli(['--group', '123', '--message', '1'], { cwd, logger: { log() {} }, enrich: async (segments, raw) => {
      enrichCalls.push([segments, raw])
      return [{ type: 'bilibili', title: '视频', bvid: 'BV1234567890', page_url: 'https://www.bilibili.com/video/BV1234567890' }]
    }, redisCli: (args, options) => {
      calls.push([args, options])
      if (args.includes('GET')) return JSON.stringify(records)
      if (args.includes('TTL')) return '30\n'
      return ''
    } })
    assert.deepEqual(result, { groupId: '123', messageId: '1', archiveChanged: 1, redisChanged: 1 })
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(JSON.parse(lines[0]).message[0].type, 'bilibili')
    assert.equal(lines[1], 'broken-json')
    assert.deepEqual(JSON.parse(lines[2]), records[1])
    assert.equal(fs.statSync(file).mode & 0o777, 0o640)
    assert.equal(enrichCalls.length, 2)
    assert.equal(enrichCalls[0][0][0].arbitrary, 42)
    const set = calls.find(([args]) => args[0] === 'SET')[0]
    assert.deepEqual(set.slice(-2), ['EX', '30'])
    const saved = JSON.parse(set[2])
    assert.match(saved[0].content, /bilibili\.com/)
    assert.deepEqual(saved[1], records[1])
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

test('Bilibili backfill does not write Redis on no changes or malformed stored shape', async () => {
  const writes = []
  const ports = { cwd: '/nonexistent-bilibili-test-dir', logger: { log() {} }, enrich: async segments => segments, redisCli: args => {
    if (args.includes('GET')) return '[{"message_id":1,"message":[]}]'
    writes.push(args)
    return ''
  } }
  assert.equal((await runBilibiliBackfillCli(['--group', '1'], ports)).redisChanged, 0)
  assert.deepEqual(writes, [])
  await assert.rejects(runBilibiliBackfillCli(['--group', '1'], { ...ports, redisCli: () => '{}' }), /必须为数组/)
  await assert.rejects(runBilibiliBackfillCli(['--group', 'bad'], ports), /需要 --group/)
})

test('Excel workbook enabling is idempotent and preserves existing tool arguments and YAML comments', () => {
  let source = '# 保留注释\npluginSettings:\n  oneapi_tools:\n    - otherTool\n    - excelWorkbookTool(自定义)\n'
  const writes = []
  const ports = { readFile: file => { assert.equal(file, '/test/message.yaml'); return source }, writeFile: (file, content) => { writes.push([file, content]); source = content }, logger: { log() {} } }
  assert.equal(enableExcelWorkbookTool('/test/message.yaml', ports), true)
  assert.deepEqual(YAML.parse(source).pluginSettings.oneapi_tools, ['otherTool', 'excelWorkbookTool(自定义)'])
  assert.match(source, /保留注释/)
  source = 'pluginSettings:\n  oneapi_tools: [otherTool]\n'
  enableExcelWorkbookTool('/test/message.yaml', ports)
  enableExcelWorkbookTool('/test/message.yaml', ports)
  assert.deepEqual(YAML.parse(source).pluginSettings.oneapi_tools, ['otherTool', 'excelWorkbookTool'])
  source = 'pluginSettings: {}\n'
  enableExcelWorkbookTool('/test/message.yaml', ports)
  assert.deepEqual(YAML.parse(source).pluginSettings.oneapi_tools, ['excelWorkbookTool'])
  source = 'pluginSettings:\n  oneapi_tools: invalid\n'
  const count = writes.length
  assert.throws(() => enableExcelWorkbookTool('/test/message.yaml', ports), /必须为数组/)
  assert.equal(writes.length, count)
})
