import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { root, run, filesUnder, digestFiles, sourceHashes } from './lib/build-support.mjs'

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Backend build requires Node >= 22')
const temporary = await fs.mkdtemp(path.join(root, '.build-'))
const output = path.join(root, 'dist/backend')
const previous = path.join(root, 'dist/backend.previous')
try {
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.backend.json', '--outDir', temporary])
  const compiler = JSON.parse(await fs.readFile(path.join(root, 'node_modules/typescript/package.json'), 'utf8')).version
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const manifest = { schema: 1, commit: git.status === 0 ? git.stdout.trim() : null, node: process.version, compiler,
    sources: await sourceHashes(), files: await digestFiles(temporary, await filesUnder(temporary)) }
  await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.rm(previous, { recursive: true, force: true })
  const exists = await fs.stat(output).then(() => true, () => false)
  if (exists) await fs.rename(output, previous)
  try { await fs.rename(temporary, output) }
  catch (error) { if (exists) await fs.rename(previous, output); throw error }
  await fs.rm(previous, { recursive: true, force: true })
  console.log(`Backend built: ${Object.keys(manifest.files).length} files, TypeScript ${compiler}`)
} finally { await fs.rm(temporary, { recursive: true, force: true }) }
