import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { root, digestFiles, filesUnder, verifyBackend } from '../scripts/lib/build-support.mjs'
import { verifyRelease, installRelease, rollbackRelease, safePath } from '../scripts/release.mjs'

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
    assert.equal(await sendForwardBatches([1], {makeForward: n => n, send: () => true}), 1)
    for (const format of ['js', 'mjs', 'cjs']) assert.equal((await import('./custom/example.' + format)).default, format)
  `)
  const child = spawnSync(process.execPath, [path.join(plugin, 'smoke.mjs')], { cwd: temp, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
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
