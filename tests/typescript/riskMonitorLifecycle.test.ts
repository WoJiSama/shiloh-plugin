import test from 'node:test'
import assert from 'node:assert/strict'
import { createLegacyRiskMonitor } from '../../src/adapters/riskSignalMonitor.js'
test('risk notice installation is idempotent and an old cleanup cannot detach a newer listener', () => {
  const listeners = new Set<(event: unknown) => void>()
  const bot = { on: (_event: string, listener: (event: unknown) => void) => { listeners.add(listener) }, removeListener: (_event: string, listener: (event: unknown) => void) => { listeners.delete(listener) } }
  const api = createLegacyRiskMonitor({ getBot: () => bot, getLogger: () => undefined, getRuntime: () => undefined, getSettings: () => ({ riskControl: { signalMonitorEnabled: true } }) })
  const first = api.installRiskSignalNoticeListener()
  const duplicate = api.installRiskSignalNoticeListener()
  assert.equal(listeners.size, 1)
  duplicate(); assert.equal(listeners.size, 1)
  first(); assert.equal(listeners.size, 0)
  const second = api.installRiskSignalNoticeListener()
  first(); assert.equal(listeners.size, 1)
  for (const listener of listeners) listener({ notice_type: 'group_ban', sub_type: 'ban', self_id: '42', user_id: '42', group_id: '123' })
  assert.equal(api.defaultMonitor.quietFactor('42'), 2)
  second(); assert.equal(listeners.size, 0)
})
