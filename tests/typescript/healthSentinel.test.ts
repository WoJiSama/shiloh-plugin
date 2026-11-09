// 健康哨兵纯函数测试:P1-2 承诺失约 faillog 告警 + 既有风格学习/表达学习不回归。
import assert from 'node:assert/strict'
import test from 'node:test'

import { checkHealth, formatAlerts } from '../../src/modules/simulation/domain/healthSentinel.js'

const NOW = 1770000000000

test('承诺终态失败:单条即 error 告警,样例带意图与群号', () => {
  const alerts = checkHealth({ now: NOW, commitmentFailures: [{ id: 'cmt_1', intent: '每天中午12点发三角洲今日密码', group_id: '20', reason: 'sim wake boom', at: NOW - 60_000 }] })
  const alert = alerts.find(a => a.component === '承诺账本·失约')
  assert.ok(alert, '产生承诺失约告警')
  assert.equal(alert!.severity, 'error')
  assert.match(alert!.message, /1 个托付终态失败/)
  assert.match(alert!.message, /「每天中午12点发三角洲今日密码」（群20）/)
  assert.match(alert!.message, /失约明说消息也可能没送达/)
  assert.equal(alert!.metric, 1)
})

test('承诺失败多条:最多列 3 条样例,计数全量', () => {
  const failures = Array.from({ length: 5 }, (_, i) => ({ id: `cmt_${i}`, intent: `托付${i}`, group_id: String(20 + i), reason: 'x', at: NOW }))
  const alert = checkHealth({ now: NOW, commitmentFailures: failures }).find(a => a.component === '承诺账本·失约')!
  assert.equal(alert.metric, 5)
  assert.match(alert.message, /5 个托付终态失败/)
  assert.ok(!alert.message.includes('托付4'), '只展示前 3 条样例')
})

test('无失败/空输入不告警;坏数据静默忽略', () => {
  assert.deepEqual(checkHealth({ now: NOW, commitmentFailures: [] }), [])
  assert.deepEqual(checkHealth({ now: NOW, commitmentFailures: null as unknown as [] }), [])
  assert.equal(checkHealth({ now: NOW, commitmentFailures: [null, {}, { intent: '' }] as unknown as { id?: string }[] }).length, 0, '空壳条目不当失败')
})

test('既有检查不回归:风格学习连环失败仍告警,formatAlerts 可读', () => {
  const alerts = checkHealth({ now: NOW, styleMemory: { aiSummary: { autoFailureCount: 1144 } } })
  assert.ok(alerts.some(a => a.component === '风格学习·自动总结' && a.severity === 'error'))
  const text = formatAlerts(alerts)
  assert.match(text, /后台组件健康告警/)
  assert.match(text, /🔴/)
})
