import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
export function withConfigFileLock<T>(file: string, run: () => T, timeoutMs = 5000): T {
 const lock = path.resolve(file) + '.lock'
 fs.mkdirSync(path.dirname(lock), { recursive: true })
 const deadline = Date.now() + timeoutMs
 while (true) {
  try {
   fs.mkdirSync(lock)
   try { fs.writeFileSync(path.join(lock, 'owner'), String(process.pid)) }
   catch (error) { fs.rmSync(lock, { recursive: true, force: true }); throw error }
   break
  } catch (error) {
   if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
   if (Date.now() >= deadline) {
    let owner = 'unknown'; try { owner = fs.readFileSync(path.join(lock, 'owner'), 'utf8') } catch {}
    throw new Error(`Configuration lock timeout: ${lock}; owner=${owner}; inspect owner before manually removing abandoned lock`)
   }
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
 }
 try { return run() } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}
export function atomicWriteConfigFile(file: string, text: string): void {
 const temp = file + '.tmp-' + randomUUID()
 let fd: number | undefined
 try {
  fd = fs.openSync(temp, 'wx', 0o600)
  fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
  fs.renameSync(temp, file)
 } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temp, { force: true }) }
}
