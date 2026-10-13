import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { withConfigFileLock, atomicWriteConfigFile } from './filePersistence.js'
export function createJsonConfigRepository<T>(filePath: string, parse: (value: unknown) => T, defaults: () => T) {
 const file = path.resolve(filePath)
 function source() { try { return fs.readFileSync(file, 'utf8') } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return JSON.stringify(defaults()); throw error } }
 const revision = (text: string) => createHash('sha256').update(text).digest('hex')
 function read() { const text = source(); return { revision: revision(text), value: parse(JSON.parse(text)) } }
 function update(mutator: (value: T) => void, expectedRevision?: string) {
  return withConfigFileLock(file, () => {
   const before = source()
   if (expectedRevision !== undefined && expectedRevision !== revision(before)) throw new Error('Configuration revision changed')
   const value = parse(JSON.parse(before)); mutator(value)
   const after = JSON.stringify(parse(value), null, 2) + '\n'
   if (fs.existsSync(file)) atomicWriteConfigFile(file + '.bak', before)
   atomicWriteConfigFile(file, after)
   return read()
  })
 }
 return { read, update }
}
