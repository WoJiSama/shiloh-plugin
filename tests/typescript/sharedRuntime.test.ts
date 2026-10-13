import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLegacySharedRuntime } from '../../src/adapters/sharedRuntime.js'
import type { MemoryCommandPort } from '../../src/contracts/sharedRuntime.js'

function managerFixture(): MemoryCommandPort & { secret: string; count: number } {
  return {
    secret: 'not-a-command', count: 7,
    async clearGroupRedis() { return this.count },
    async adminClearMemories() { return { cleared: this.count } },
    async adminStatus() { return { enabled: true } },
    async adminListMemories() { return { facts: [] } },
    async getGroupWorkflowRules() { return [] },
    async getGroupKnowledgeEntries() { return [] },
    async adminDeleteGroupWorkflow() { return { deleted: true } },
    async adminDeleteGroupKnowledge() { return { deleted: true } },
    async adminDeleteMemory() { return { deleted: true } },
    async clearUserMemory() { return { cleared: 1 } },
    async adminSetUserMemoryEnabled(scope) { return { enabled: scope.enabled } }
  }
}
test('uninitialized registry fails memory access and exposes empty config', () => {
  const runtime = createLegacySharedRuntime()
  assert.throws(() => runtime.getSharedMemoryManager(), /尚未就绪/)
  assert.deepEqual(runtime.getSharedConfig(), {})
  assert.equal(runtime.getSharedRuntime(), null)
})
test('legacy adapter narrows manager capability and retains method receivers', async () => {
  const runtime = createLegacySharedRuntime()
  const manager = managerFixture()
  runtime.setSharedRuntime({ memoryManager: manager })
  assert.equal('secret' in runtime.getSharedMemoryManager(), false)
  assert.equal(await runtime.getSharedMemoryManager().clearGroupRedis('g'), 7)
  manager.count = 9
  assert.deepEqual(await runtime.getSharedMemoryManager().adminClearMemories({ groupId: 'g' }), { cleared: 9 })
})
test('reinitialization replaces capabilities, config stays live, and reset removes them', () => {
  const runtime = createLegacySharedRuntime()
  let revision = 1
  runtime.setSharedRuntime({ memoryManager: managerFixture(), getConfig: () => ({ revision }) })
  revision = 2
  assert.deepEqual(runtime.getSharedConfig(), { revision: 2 })
  assert.deepEqual(runtime.getSharedRuntime()?.getConfig(), { revision: 2 })
  runtime.setSharedRuntime({ getConfig: () => ({ revision: 3 }) })
  assert.throws(() => runtime.getSharedMemoryManager(), /尚未就绪/)
  assert.deepEqual(runtime.getSharedConfig(), { revision: 3 })
  runtime.setSharedRuntime(null)
  runtime.setSharedRuntime(null)
  assert.equal(runtime.getSharedRuntime(), null)
  assert.deepEqual(runtime.getSharedConfig(), {})
})


test('missing command capability fails composition without replacing the working registry', () => {
  const runtime = createLegacySharedRuntime()
  runtime.setSharedRuntime({ memoryManager: managerFixture() })
  const previous = runtime.getSharedMemoryManager()
  const broken = { ...managerFixture(), adminStatus: undefined } as unknown as MemoryCommandPort
  assert.throws(() => runtime.setSharedRuntime({ memoryManager: broken }), /Missing memory command capability: adminStatus/)
  assert.equal(runtime.getSharedMemoryManager(), previous)
})
