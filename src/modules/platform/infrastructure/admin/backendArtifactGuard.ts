const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'


export function createBackendArtifactGuard(defaultRoot:string){
let defaultCheck:Promise<void>|undefined

async function exists(file:string) {
  try { await fs.access(file); return true }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
}

async function checkedFile(root:string, relative:unknown) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe artifact path: ${relative}`)
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Artifact symlink is not allowed: ${relative}`)
  }
  if (!(await fs.stat(current)).isFile()) throw new Error(`Artifact is not a regular file: ${relative}`)
  return current
}

async function sourceFiles(root:string, relative = 'src'):Promise<string[]> {
  const directory = path.join(root, relative)
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error(`Artifact symlink is not allowed: ${relative}`)
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`Artifact symlink is not allowed: ${name}`)
    if (entry.isDirectory()) files.push(...await sourceFiles(root, name))
    else if (entry.isFile()) files.push(name)
  }
  return files.sort()
}

async function validateHashes(root:string, hashes:unknown, label:string) {
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || !Object.keys(hashes).length) throw new Error(`Invalid ${label} hashes`)
  for (const [relative, expected] of Object.entries(hashes)) {
    const file = await checkedFile(root, relative)
    const actual = createHash('sha256').update(await fs.readFile(file)).digest('hex')
    if (actual !== expected) throw new Error(`${label} differs from build manifest: ${relative}`)
  }
}

async function verify(root:string) {
  try {
    const backendRoot = path.join(root, 'dist/backend')
    const manifestFile = await checkedFile(root, 'dist/backend/manifest.json')
    const manifest = record(JSON.parse(await fs.readFile(manifestFile, 'utf8')))
    if (manifest.schema !== 1) throw new Error('Unsupported backend manifest')
    await validateHashes(backendRoot, manifest.files, 'Backend output')
    const actualOutputs = (await sourceFiles(root, 'dist/backend')).map(name => name.slice('dist/backend/'.length))
    const expectedOutputs = [...Object.keys(record(manifest.files)), 'manifest.json'].sort()
    if (JSON.stringify(actualOutputs) !== JSON.stringify(expectedOutputs)) throw new Error('Backend output file set differs from build manifest')
    if (await exists(path.join(root, 'release-manifest.json'))) {
      const releaseFile = await checkedFile(root, 'release-manifest.json')
      const release = record(JSON.parse(await fs.readFile(releaseFile, 'utf8')))
      if (release.schema !== 1 || typeof release.commit !== 'string' || !/^[a-f0-9]{40}$/.test(release.commit)) throw new Error('Invalid release manifest')
      if (!record(release.files)['dist/backend/manifest.json']) throw new Error('Release manifest must include backend manifest')
      await validateHashes(root, release.files, 'Release runtime')
    } else if (await exists(path.join(root, 'src'))) {
      await validateHashes(root, manifest.sources, 'Backend source')
      const recordedSources = Object.keys(record(manifest.sources)).filter(name => name.startsWith('src/')).sort()
      if (JSON.stringify(await sourceFiles(root)) !== JSON.stringify(recordedSources)) throw new Error('Backend source file set differs from build manifest')
    } else {
      throw new Error('Neither source checkout nor release manifest exists')
    }
  } catch (error) {
    throw new Error(`Backend artifacts are missing or stale. Run npm run backend:build in the source checkout or install a verified release. ${error instanceof Error?error.message:String(error)}`, { cause: error })
  }
}

/** Explicit roots are checked afresh; the normal runtime startup shares one successful check. */
function ensureBackendArtifacts(root?:string) {
  if (root !== undefined) return verify(path.resolve(root))
  if (!defaultCheck) defaultCheck = verify(defaultRoot).catch(error => { defaultCheck = undefined; throw error })
  return defaultCheck
}

return {ensureBackendArtifacts}
}
