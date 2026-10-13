import type { SharedRuntime } from '../../../contracts/sharedRuntime.js'

export function createSharedRuntimeRegistry() {
  let runtime: SharedRuntime | null = null
  return {
    setSharedRuntime(value: SharedRuntime | null) { runtime = value },
    getSharedRuntime() { return runtime },
    getSharedMemoryManager() {
      if (!runtime?.memoryManager) throw new Error('记忆系统尚未就绪，请稍后再试')
      return runtime.memoryManager
    },
    getSharedConfig() { return runtime?.config.read() || {} }
  }
}
