import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { root, run, filesUnder, digestFiles, verifyBackend } from './lib/build-support.mjs'

const protectedRoots = new Set(['.git', 'node_modules', 'config', 'data', 'database', 'logs', 'backups', 'custom_tools'])
export function safePath(base, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.split('/').some(p => p === '..' || p === '.') || path.isAbsolute(relative) || protectedRoots.has(relative.split('/')[0])) throw new Error(`Unsafe release path: ${relative}`)
  return path.join(base, relative)
}
export async function verifyRelease(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'release-manifest.json'), 'utf8'))
  if (manifest.schema !== 1 || typeof manifest.commit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.commit)) throw new Error('Invalid release manifest')
  for (const name of Object.keys(manifest.files)) safePath(directory, name)
  const contentFiles = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'release-manifest.json') continue
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in release contents')
    if (entry.isDirectory()) contentFiles.push(...await filesUnder(file))
    else contentFiles.push(file)
  }
  const actual = await digestFiles(directory, contentFiles)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Release contents differ from manifest')
  await verifyBackend(path.join(directory, 'dist/backend'))
  for (const file of ['index.js', 'console/server.js', 'console/frontend/dist/index.html', 'package-lock.json']) {
    if (!manifest.files[file]) throw new Error(`Missing release entry: ${file}`)
  }
  return manifest
}
async function checkedDestination(target, name) {
  const destination = safePath(target, name)
  let current = target
  for (const part of ['', ...name.split('/').slice(0, -1)]) {
    if (part) current = path.join(current, part)
    const stat = await fs.lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Unsafe install parent: ${current}`)
  }
  const stat = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  if (stat && !stat.isFile()) throw new Error(`Install target must be a regular file: ${name}`)
  return { destination, stat }
}
export async function installRelease(source, target, backup) {
  source = path.resolve(source); target = path.resolve(target); backup = path.resolve(backup)
  if ([source, backup].some(p => p === target || p.startsWith(target + path.sep)) || backup === source) throw new Error('Release and backup must be outside install target')
  const manifest = await verifyRelease(source)
  await fs.mkdir(backup, { recursive: false })
  let previous = { files: {} }
  try { previous = JSON.parse(await fs.readFile(path.join(target, 'release-manifest.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const generated = []
  for (const folder of ['dist/backend', 'console/frontend/dist']) {
    const directory = path.join(target, folder)
    const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (stat) {
      await checkedDestination(target, folder + '/manifest-placeholder')
      generated.push(...(await filesUnder(directory)).map(file => path.relative(target, file).replaceAll('\\', '/')))
    }
  }
  const names = [...new Set([...Object.keys(previous.files), ...Object.keys(manifest.files), ...generated, 'release-manifest.json'])].sort()
  const journal = []
  try {
    for (const name of names) {
      const { destination, stat } = await checkedDestination(target, name)
      const saved = path.join(backup, name)
      if (stat) { await fs.mkdir(path.dirname(saved), { recursive: true }); await fs.copyFile(destination, saved) }
      journal.push({ name, existed: Boolean(stat) })
      const from = path.join(source, name)
      if (name === 'release-manifest.json' || manifest.files[name]) {
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.copyFile(from, destination)
      } else await fs.rm(destination, { force: true })
    }
    await fs.writeFile(path.join(backup, 'rollback-journal.json'), JSON.stringify(journal, null, 2))
  } catch (error) {
    await restoreJournal(target, backup, journal)
    throw error
  }
  return manifest
}
async function restoreJournal(target, backup, journal) {
  for (const { name, existed } of [...journal].reverse()) {
    const { destination } = await checkedDestination(target, name)
    if (existed) await fs.copyFile(path.join(backup, name), destination)
    else await fs.rm(destination, { force: true })
  }
}
export async function rollbackRelease(target, backup) {
  const journal = JSON.parse(await fs.readFile(path.join(backup, 'rollback-journal.json'), 'utf8'))
  await restoreJournal(path.resolve(target), path.resolve(backup), journal)
}
async function pack() {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' })
  if (status.status !== 0 || status.stdout.trim()) throw new Error('Release requires a clean checkout; commit source first or use an isolated checkout')
  run('npm', ['run', 'backend:build'])
  run('npm', ['run', 'console:build'])
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const output = path.join(root, '.release', commit)
  await fs.rm(output, { recursive: true, force: true }); await fs.mkdir(output, { recursive: true })
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).stdout.split('\0').filter(Boolean)
  const runtime = tracked.filter(name => !/^(?:tests|docs|src|\.github)\//.test(name) && !['task_plan.md','progress.md','findings.md'].includes(name) && !name.startsWith('console/frontend/') && !protectedRoots.has(name.split('/')[0]))
  for (const name of runtime) {
    const from = path.join(root, name), to = safePath(output, name)
    const stat = await fs.lstat(from)
    if (!stat.isFile()) throw new Error(`Unsupported release input: ${name}`)
    await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to)
  }
  for (const name of ['dist/backend', 'console/frontend/dist']) await fs.cp(path.join(root, name), path.join(output, name), { recursive: true })
  const backend = await verifyBackend(path.join(output, 'dist/backend'))
  const manifest = { schema: 1, commit, node: process.version, compiler: backend.compiler, files: await digestFiles(output, await filesUnder(output)) }
  await fs.writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await verifyRelease(output)
  console.log(output)
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command, first, second, third] = process.argv.slice(2)
  if (command === 'pack') await pack()
  else if (command === 'verify' && first) { await verifyRelease(path.resolve(first)); console.log('Release verified') }
  else if (command === 'install' && first && second && third) { await installRelease(first, second, third); console.log('Installed; service health must be verified before acceptance') }
  else if (command === 'rollback' && first && second) { await rollbackRelease(first, second); console.log('Rolled back runtime files') }
  else throw new Error('Usage: release.mjs pack | verify <artifact> | install <artifact> <stopped-target> <backup> | rollback <stopped-target> <backup>')
}
