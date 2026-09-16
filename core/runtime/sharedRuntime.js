// 共享运行时注册表：主聊天插件初始化的共享管理器（memoryManager 等）
// 通过这里暴露给已拆出的功能域命令 App 使用，避免域代码反向依赖 apps/test.js。
let runtime = null

export function setSharedRuntime(value) {
  runtime = value || null
}

export function getSharedRuntime() {
  return runtime
}

export function getSharedMemoryManager() {
  const manager = runtime?.memoryManager
  if (!manager) throw new Error("记忆系统尚未就绪，请稍后再试")
  return manager
}

export function getSharedConfig() {
  return runtime?.getConfig?.() || {}
}
