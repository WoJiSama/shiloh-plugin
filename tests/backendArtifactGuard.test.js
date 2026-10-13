import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ensureBackendArtifacts } from '../utils/backendArtifactGuard.js'

const hash = value => createHash('sha256').update(value).digest('hex')
async function write(root, name, value) {
  const file = path.join(root, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, value)
}
async function fixture(t, release = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-guard-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = 'export const value: number = 1\n', output = 'export const value = 1\n'
  const manifest = JSON.stringify({ schema: 1, sources: { 'src/module.ts': hash(source) }, files: { 'module.js': hash(output) } })
  await write(root, 'dist/backend/module.js', output)
  await write(root, 'dist/backend/manifest.json', manifest)
  if (!release) await write(root, 'src/module.ts', source)
  else {
    await write(root, 'index.js', 'runtime')
    await write(root, 'release-manifest.json', JSON.stringify({ schema: 1, commit: 'a'.repeat(40), files: {
      'dist/backend/module.js': hash(output), 'dist/backend/manifest.json': hash(manifest), 'index.js': hash('runtime')
    } }))
  }
  return root
}

test('source checkout validates each call and rejects a source-only update', async t => {
  const root = await fixture(t)
  await ensureBackendArtifacts(root)
  await write(root, 'src/module.ts', 'changed source')
  await assert.rejects(ensureBackendArtifacts(root), /Backend source differs/)
})

test('corrupted and missing compiled outputs stop startup', async t => {
  const root = await fixture(t)
  await write(root, 'dist/backend/module.js', 'corrupted')
  await assert.rejects(ensureBackendArtifacts(root), /Backend output differs/)
  await fs.rm(path.join(root, 'dist/backend/module.js'))
  await assert.rejects(ensureBackendArtifacts(root), /missing or stale/)
})

test('release checkout verifies listed runtime and ignores mutable local state', async t => {
  const root = await fixture(t, true)
  for (const name of ['config/local.yaml', 'data/messages', 'node_modules/fixture/index.js', 'unmanaged.js']) await write(root, name, 'local')
  await ensureBackendArtifacts(root)
  await write(root, 'index.js', 'changed runtime')
  await assert.rejects(ensureBackendArtifacts(root), /Release runtime differs/)
})

test('checkout without source or release manifest is rejected', async t => {
  const root = await fixture(t)
  await fs.rm(path.join(root, 'src'), { recursive: true })
  await assert.rejects(ensureBackendArtifacts(root), /missing or stale/)
})

test('manifest traversal and symlink outputs are rejected', async t => {
  const root = await fixture(t)
  await fs.rm(path.join(root, 'dist/backend/module.js'))
  await fs.symlink(path.join(root, 'src/module.ts'), path.join(root, 'dist/backend/module.js'))
  await assert.rejects(ensureBackendArtifacts(root), /symlink/)
  await write(root, 'dist/backend/manifest.json', JSON.stringify({ schema: 1, files: { '../outside': 'hash' } }))
  await assert.rejects(ensureBackendArtifacts(root), /Unsafe artifact path/)
})


test('new source file invalidates an otherwise matching build', async t => {
  const root = await fixture(t)
  await write(root, 'src/new-module.ts', 'export const next = true')
  await assert.rejects(ensureBackendArtifacts(root), /source file set differs/)
})


test('verified release takes precedence over retained stale source but rejects runtime tampering', async t => {
  const root = await fixture(t, true)
  await write(root, 'src/module.ts', 'stale source from previous checkout')
  await write(root, 'src/old-module.ts', 'old source')
  await ensureBackendArtifacts(root)
  await write(root, 'index.js', 'tampered runtime')
  await assert.rejects(ensureBackendArtifacts(root), /Release runtime differs/)
})

test('extra stale generated output is rejected even when recorded hashes match', async t => {
  const root = await fixture(t, true)
  await write(root, 'dist/backend/old-module.js', 'stale generated file')
  await assert.rejects(ensureBackendArtifacts(root), /Backend output file set differs/)
})
