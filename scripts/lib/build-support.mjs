import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const hash = data => createHash('sha256').update(data).digest('hex')
export async function filesUnder(directory) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in build output: ${file}`)
    if (entry.isDirectory()) files.push(...await filesUnder(file))
    else if (entry.isFile()) files.push(file)
  }
  return files.sort()
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
  return result
}
export async function digestFiles(base, files) {
  const result = {}
  for (const file of [...files].sort()) result[path.relative(base, file).replaceAll('\\', '/')] = hash(await fs.readFile(file))
  return result
}
export async function sourceHashes() {
  return digestFiles(root, [
    ...await filesUnder(path.join(root, 'src')),
    ...['tsconfig.backend.json', 'package.json', 'package-lock.json', 'scripts/backend-build.mjs', 'scripts/lib/build-support.mjs'].map(name => path.join(root, name))
  ])
}
export async function verifyBackend(directory = path.join(root, 'dist/backend'), { source = false } = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'))
  if (manifest.schema !== 1) throw new Error('Unsupported backend manifest')
  const actual = await digestFiles(directory, (await filesUnder(directory)).filter(file => file !== path.join(directory, 'manifest.json')))
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Backend output differs from manifest; rebuild required')
  if (source && JSON.stringify(await sourceHashes()) !== JSON.stringify(manifest.sources)) throw new Error('Backend source differs from compiled output; rebuild required')
  return manifest
}
