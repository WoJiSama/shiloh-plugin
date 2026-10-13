import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNamedConfig } from '../../src/modules/config/infrastructure/namedConfig.js'
import { canManageThinkingForward, handleThinkingForwardCommand } from '../../src/modules/config/infrastructure/thinkingForwardSettings.js'

test('named configs share repository atomic save, backup, update, delete and watcher lifecycle', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'named-config-'))
 let closed = 0
 const config = createNamedConfig({ configPath: dir, equal: (a,b) => JSON.stringify(a) === JSON.stringify(b), isEmpty: value => value !== null && typeof value === 'object' && Object.keys(value).length === 0,
  logger: { mark() {}, error() {} }, watch: () => ({ on() {}, async close() { closed++ } }) })
 try {
  config.saveAllConfig('test', { a: 1, b: 2 })
  config.updateField('test', 'a', 3)
  assert.deepEqual(config.getConfig('test'), { a: 3, b: 2 })
  assert.equal(fs.existsSync(path.join(dir, 'test.yaml.bak')), true)
  config.deleteField('test', 'b')
  assert.equal(config.getField('test', 'a'), 3)
  config.saveAllConfig('test', {})
  assert.equal(fs.existsSync(path.join(dir, 'test.yaml')), false)
  assert.throws(() => config.getFilePath('../escape'), /无效配置/)
  await config.closeWatchers()
  assert.equal(closed, 1)
 } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('every thinking command permits master or owner and rejects admin/member', async () => {
 for (const action of ['开启','关闭','状态']) for (const role of ['admin','member']) {
  const replies: string[] = []
  await handleThinkingForwardCommand({ msg: '#思考过程'+action, group_id: 1, sender: { role }, reply: text => { replies.push(text) } }, { isEnabled: () => assert.fail('unauthorized read'), setEnabled: () => assert.fail('unauthorized write') })
  assert.match(replies[0]!, /仅机器人主人或群主/)
 }
 assert.equal(canManageThinkingForward({ isMaster: true }), true)
 assert.equal(canManageThinkingForward({ sender: { role: 'owner' } }), true)
})

test('separate processes merge concurrent thinking settings without losing groups', async () => {
 const { spawn } = await import('node:child_process')
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-concurrent-'))
 const file = path.join(dir, 'thinking-forward.json')
 const moduleUrl = new URL('../../src/modules/config/infrastructure/thinkingForwardSettings.js', import.meta.url).href
 try {
  await Promise.all(['100', '200'].map(group => new Promise<void>((resolve, reject) => {
   const source = `import { createThinkingForwardSettings } from ${JSON.stringify(moduleUrl)}; const store=createThinkingForwardSettings(${JSON.stringify(file)}); for(let n=0;n<20;n++) store.setEnabled(${JSON.stringify(group)},true)`
   const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] })
   let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk) })
   child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)))
  })))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).groups, { '100': true, '200': true })
 } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
