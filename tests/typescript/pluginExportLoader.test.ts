import assert from 'node:assert/strict'
import test from 'node:test'
import { collectPluginExports } from '../../src/modules/platform/domain/pluginExportLoader.js'

class PluginBase {}
class First extends PluginBase {}
class Second extends PluginBase {}

test('discovery puts default first and deduplicates aliases without registering helpers', () => {
  const results = collectPluginExports({ First, helper: () => {}, default: Second, Second, value: 3, PluginBase }, PluginBase)
  assert.deepEqual(results, [
    { exportName: 'default', PluginClass: Second },
    { exportName: 'First', PluginClass: First }
  ])
})

test('invalid host base and absent namespace produce no plugins', () => {
  for (const base of [undefined, null, {}, 'PluginBase', 1]) {
    assert.deepEqual(collectPluginExports({ First }, base), [])
  }
  for (const namespace of [undefined, null, false, 0, {}]) {
    assert.deepEqual(collectPluginExports(namespace, PluginBase), [])
  }
})

test('indirect subclasses are accepted but unrelated classes are excluded', () => {
  class Child extends First {}
  class Other {}
  assert.deepEqual(collectPluginExports({ Child, Other }, PluginBase), [{ exportName: 'Child', PluginClass: Child }])
})
