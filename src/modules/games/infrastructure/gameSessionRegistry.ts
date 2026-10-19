// 跨模块的"游戏占用群"注册表:小游戏组合根发布进行中的局,主聊天prefilter查询。
// 用进程级Symbol解耦——conversation与games两个组合根互不import,同进程内共享一份状态。
type ActiveGroupsReader = () => ReadonlySet<string>
const REGISTRY_KEY = Symbol.for('shiloh-plugin.games.activeGameGroups')

export function publishActiveGameGroups(reader:ActiveGroupsReader) {
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = reader
}

export function readActiveGameGroups():ReadonlySet<string> {
  const reader = (globalThis as Record<symbol, unknown>)[REGISTRY_KEY]
  if (typeof reader !== 'function') return new Set()
  try {
    const value = (reader as ActiveGroupsReader)()
    return value instanceof Set ? value : new Set()
  } catch {
    return new Set()
  }
}
