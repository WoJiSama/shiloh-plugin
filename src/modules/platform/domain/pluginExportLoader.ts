/** A discovered class; constructor arguments belong to the host adapter. */
export type PluginConstructor = new (...args: never[]) => object

export interface PluginExport {
  exportName: string
  PluginClass: PluginConstructor
}

/** Host module namespaces are external data, so discovery validates each value. */
export function collectPluginExports(moduleNamespace: unknown = {}, PluginBase?: unknown): PluginExport[] {
  if (typeof PluginBase !== 'function') return []
  const entries: [string, unknown][] = Object.entries(moduleNamespace || {})
  const ordered = [
    ...entries.filter(([name]) => name === 'default'),
    ...entries.filter(([name]) => name !== 'default')
  ]
  const seen = new Set<unknown>()
  const plugins: PluginExport[] = []
  for (const [exportName, value] of ordered) {
    if (typeof value !== 'function' || !value.prototype || !(value.prototype instanceof PluginBase)) continue
    if (seen.has(value)) continue
    seen.add(value)
    plugins.push({ exportName, PluginClass: value as PluginConstructor })
  }
  return plugins
}
