import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { root, digestFiles, filesUnder, verifyBackend } from '../scripts/lib/build-support.mjs'
import { verifyRelease, installRelease, rollbackRelease, safePath, selectRuntimeFiles } from '../scripts/release.mjs'

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shiloh-artifact-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}
async function write(base, name, content) {
  const file = path.join(base, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}
async function release(directory, extra = {}) {
  await fs.mkdir(directory, { recursive: true })
  await fs.cp(path.join(root, 'dist/backend'), path.join(directory, 'dist/backend'), { recursive: true })
  for (const [name, content] of Object.entries({
    'index.js': 'export const fixture = true\n',
    'console/server.js': 'export const server = true\n',
    'console/frontend/dist/index.html': '<html>fixture</html>',
    'package-lock.json': '{}', ...extra
  })) await write(directory, name, content)
  const manifest = { schema: 1, commit: 'a'.repeat(40), files: await digestFiles(directory, await filesUnder(directory)) }
  await write(directory, 'release-manifest.json', JSON.stringify(manifest))
  return manifest
}

test('legacy wrappers expose identical compiled functions', async () => {
  const legacyForward = await import('../utils/forwardBatches.js')
  const compiledForward = await import('../dist/backend/modules/messaging/domain/forwardBatches.js')
  const legacyLoader = await import('../utils/pluginExportLoader.js')
  const compiledLoader = await import('../dist/backend/modules/platform/domain/pluginExportLoader.js')
  assert.equal(legacyForward.sendForwardBatches, compiledForward.sendForwardBatches)
  assert.equal(legacyForward.QQ_FORWARD_NODE_LIMIT, 100)
  assert.equal(legacyLoader.collectPluginExports, compiledLoader.collectPluginExports)
})

test('compiled wrappers load under a host-shaped directory from another cwd; JS module formats remain loadable', async t => {
  const temp = await temporary(t)
  const plugin = path.join(temp, 'host/plugins/shiloh-plugin')
  await fs.cp(path.join(root, 'dist/backend'), path.join(plugin, 'dist/backend'), { recursive: true })
  await write(plugin, 'package.json', '{"type":"module"}')
  for (const name of ['forwardBatches.js', 'pluginExportLoader.js']) await write(plugin, `utils/${name}`, await fs.readFile(path.join(root, 'utils', name)))
  await write(plugin, 'custom/example.js', 'export default "js"')
  await write(plugin, 'custom/example.mjs', 'export default "mjs"')
  await write(plugin, 'custom/example.cjs', 'module.exports = "cjs"')
  await write(plugin, 'smoke.mjs', `
    import assert from 'node:assert/strict'
    import { sendForwardBatches } from './utils/forwardBatches.js'
    import { collectPluginExports } from './utils/pluginExportLoader.js'
    class Base {}; class Plugin extends Base {}
    assert.equal(collectPluginExports({default: Plugin}, Base)[0].PluginClass, Plugin)
    assert.equal(await sendForwardBatches([1], {makeForward: n => n, send: () => ({message_id:1})}), 1)
    for (const format of ['js', 'mjs', 'cjs']) assert.equal((await import('./custom/example.' + format)).default, format)
  `)
  const child = spawnSync(process.execPath, [path.join(plugin, 'smoke.mjs')], { cwd: temp, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
})

test('release includes dice command documents and emitted code resolves them inside the installed package', async t => {
  const temp = await temporary(t)
  const source = path.join(temp, 'source'), target = path.join(temp, 'host/plugins/shiloh-plugin')
  const names = ['JS规则包教程.md', '骰娘自定义规则接入指南.md', 'examples/bishou-zhixin.cjs']
  const runtimeDocuments = (await filesUnder(path.join(root, 'docs/dice-rules')))
    .map(file => path.relative(root, file).replaceAll('\\', '/'))
  assert.deepEqual(selectRuntimeFiles(runtimeDocuments), runtimeDocuments)
  assert.deepEqual(selectRuntimeFiles(['docs/architecture/migrations/phase-7g.md', 'docs/commands.md', 'src/example.ts', 'config/message.yaml']), [])
  const documents = Object.fromEntries(await Promise.all(names.map(async name => [
    `docs/dice-rules/${name}`, await fs.readFile(path.join(root, 'docs/dice-rules', name))
  ])))
  await release(source, { 'package.json': '{"type":"module"}', ...documents })
  await fs.mkdir(target, { recursive: true })
  await installRelease(source, target, path.join(temp, 'backup'))
  const { resolveDiceDocPath } = await import(pathToFileURL(path.join(target, 'dist/backend/modules/dice/infrastructure/diceCommandPolicy.js')))
  for (const name of names) {
    const file = resolveDiceDocPath(name)
    assert.equal(file, await fs.realpath(path.join(target, 'docs/dice-rules', name)))
    assert.deepEqual(await fs.readFile(file), documents[`docs/dice-rules/${name}`])
  }
})

test('backend manifest rejects corrupted output and stale source fingerprints', async t => {
  const temp = await temporary(t)
  const directory = path.join(temp, 'backend')
  await fs.cp(path.join(root, 'dist/backend'), directory, { recursive: true })
  await verifyBackend(directory, { source: true })
  const filename = path.join(directory, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(filename, 'utf8'))
  manifest.sources['src/stale.ts'] = 'stale'
  await fs.writeFile(filename, JSON.stringify(manifest))
  await assert.rejects(verifyBackend(directory, { source: true }), /source differs/)
  await write(directory, 'modules/messaging/domain/forwardBatches.js', 'corrupted')
  await assert.rejects(verifyBackend(directory), /output differs/)
})

test('release install removes only manifest-owned stale files and rollback restores runtime while preserving local state', async t => {
  const temp = await temporary(t)
  const source = path.join(temp, 'source'), target = path.join(temp, 'target'), backup = path.join(temp, 'backup')
  await release(source, { 'new-runtime.js': 'new' })
  await release(target, { 'old-runtime.js': 'old', 'index.js': 'old entry' })
  await write(target, 'config/local.yaml', 'secret config')
  await write(target, 'data/messages.json', 'local messages')
  await write(target, 'unmanaged.js', 'keep me')
  await verifyRelease(source)
  await installRelease(source, target, backup)
  assert.equal(await fs.readFile(path.join(target, 'new-runtime.js'), 'utf8'), 'new')
  await assert.rejects(fs.access(path.join(target, 'old-runtime.js')), { code: 'ENOENT' })
  for (const [name, value] of [['config/local.yaml', 'secret config'], ['data/messages.json', 'local messages'], ['unmanaged.js', 'keep me']]) assert.equal(await fs.readFile(path.join(target, name), 'utf8'), value)
  await rollbackRelease(target, backup)
  assert.equal(await fs.readFile(path.join(target, 'index.js'), 'utf8'), 'old entry')
  assert.equal(await fs.readFile(path.join(target, 'old-runtime.js'), 'utf8'), 'old')
  await assert.rejects(fs.access(path.join(target, 'new-runtime.js')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(target, 'config/local.yaml'), 'utf8'), 'secret config')
  assert.equal(await fs.readFile(path.join(target, 'data/messages.json'), 'utf8'), 'local messages')
})

test('unsafe manifest paths and symbolic-link release contents are rejected', async t => {
  const temp = await temporary(t)
  for (const name of ['../escape', '/absolute', 'config/local.yaml', 'data/local', 'a/../b', 'a\\b']) assert.throws(() => safePath(temp, name), /Unsafe release path/)
  const source = path.join(temp, 'source')
  await release(source)
  await fs.symlink(path.join(temp, 'elsewhere'), path.join(source, 'link'))
  await assert.rejects(verifyRelease(source), /Symlinks/)
})

test('install rejects a symlink parent without changing its external destination', async t => {
  const temp = await temporary(t)
  const source = path.join(temp, 'source'), target = path.join(temp, 'target'), outside = path.join(temp, 'outside')
  await release(source)
  await fs.mkdir(target)
  await write(outside, 'server.js', 'outside original')
  await fs.symlink(outside, path.join(target, 'console'))
  await assert.rejects(installRelease(source, target, path.join(temp, 'backup')), /Unsafe install parent/)
  assert.equal(await fs.readFile(path.join(outside, 'server.js'), 'utf8'), 'outside original')
})

test('first manifestless install cleans stale generated files and rollback restores them', async t => {
  const temp = await temporary(t)
  const source = path.join(temp, 'source'), target = path.join(temp, 'target'), backup = path.join(temp, 'backup')
  await release(source)
  await write(target, 'dist/backend/obsolete.js', 'old compiled module')
  await write(target, 'console/frontend/dist/obsolete.js', 'old frontend module')
  await write(target, 'config/message.yaml', 'keep config')
  await installRelease(source, target, backup)
  await assert.rejects(fs.access(path.join(target, 'dist/backend/obsolete.js')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(target, 'console/frontend/dist/obsolete.js')), { code: 'ENOENT' })
  await rollbackRelease(target, backup)
  assert.equal(await fs.readFile(path.join(target, 'dist/backend/obsolete.js'), 'utf8'), 'old compiled module')
  assert.equal(await fs.readFile(path.join(target, 'config/message.yaml'), 'utf8'), 'keep config')
})

test('phase two session and runtime wrappers execute compiled services', async () => {
  const legacy = await import('../utils/turnSession.js')
  const compiled = await import('../dist/backend/modules/runtime/domain/turnSession.js')
  assert.equal(legacy.createTurnSessionStore, compiled.createTurnSessionStore)
  const store = legacy.createTurnSessionStore({ now: () => 0, ttlMs: 100 })
  store.getOrCreate('artifact', [])
  assert.equal(store.sweep(101), 1)
  const shared = await import('../core/runtime/sharedRuntime.js')
  shared.setSharedRuntime({ getConfig: () => ({ artifact: true }) })
  assert.deepEqual(shared.getSharedConfig(), { artifact: true })
  shared.setSharedRuntime(null)
  const group = await import('../core/runtime/groupRuntime.js')
  assert.equal(group.getSmartRuntimeState('artifact').pendingCount, 0)
  assert.equal(group.deleteSmartRuntimeState('artifact'), true)
})

test('registered pure compatibility entries load the exact emitted exports', async () => {
  const { migrations, verifyCompatibility } = await import('../scripts/migration-report.mjs')
  for (const item of migrations.filter(item => item.kind !== 'composition')) {
    assert.equal(verifyCompatibility(item, await fs.readFile(path.join(root, item.legacy), 'utf8')), true, item.legacy)
    const legacy = await import(new URL('../' + item.legacy, import.meta.url))
    const targets = await Promise.all([item.implementation, ...(item.additionalImplementations || [])].map(source =>
      import(new URL('../' + source.replace(/^src\//, 'dist/backend/').replace(/\.ts$/, '.js'), import.meta.url))))
    for (const [name, value] of Object.entries(legacy)) {
      assert.ok(targets.some(target => Object.hasOwn(target, name) && target[name] === value), `${item.legacy}:${name}`)
    }
  }
})

test('compiled memory factories compose without host globals or network', async () => {
 const { createMemoryCommands } = await import('../dist/backend/modules/memory/infrastructure/memoryCommands.js')
 const { createGlobalStyleLearnerClass } = await import('../dist/backend/modules/memory/infrastructure/globalStyleLearner.js')
 const { createPersonaFeedbackModule } = await import('../dist/backend/modules/memory/infrastructure/personaFeedbackManager.js')
 const Style = createGlobalStyleLearnerClass({ botId:()=>1, buildExpressionObservation:()=>null })
 const Persona = createPersonaFeedbackModule({ isToneCorrectionMessage:()=>false }).PersonaFeedbackManager
 const Commands = createMemoryCommands({ PluginBase:class {}, getSharedMemoryManager:()=>{throw new Error('unexpected memory access')}, getSharedConfig:()=>({}), globalStyleLearnerManager:new Style(), personaFeedbackManager:new Persona(),logger:{warn(){},error(){}},makeForwardMsg:async(_e,messages)=>messages })
 const payloads=[]
 await new Commands().replyMemoryForward({reply:async payload=>{payloads.push(payload)}},'fixture',[{title:'fixture',facts:[]}])
 assert.equal(payloads.length,1)
 assert.match(JSON.stringify(payloads[0]),/暂无记忆/)
})
