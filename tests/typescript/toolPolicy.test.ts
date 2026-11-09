// 工具能力策略纯函数测试:P1-3 白名单翻转——open 默认全量内置安全工具-减法,legacy 回退,敏感默认禁。
import assert from 'node:assert/strict'
import test from 'node:test'

import { RESTRICTED_SIM_TOOLS, normalizeSimToolPolicy, resolveSimToolSurface } from '../../src/modules/simulation/domain/toolPolicy.js'

const BUILT_IN = [
  'sendLocalEmojiTool', 'searchVideoTool', 'bananaTool', 'searchInformationTool',
  'commitmentTool', 'delegateMemoryTool', 'jinyanTool', 'recallTool', 'sendGiftTool',
  'grabRedBagTool', 'qqZoneTool', 'changeCardTool', 'mentionAdminsTool', 'reminderTool',
  'searchMusicTool', 'webParserTool', 'chatHistoryTool', 'memberInfoTool',
]

test('normalizeSimToolPolicy:默认 open,非法输入回落', () => {
  assert.equal(normalizeSimToolPolicy(undefined).mode, 'open')
  assert.equal(normalizeSimToolPolicy({}).mode, 'open')
  assert.equal(normalizeSimToolPolicy({ mode: 'legacy' }).mode, 'legacy')
  assert.equal(normalizeSimToolPolicy({ mode: 'garbage' }).mode, 'open')
  assert.deepEqual(normalizeSimToolPolicy({ allowTools: ['a', 'a', ' ', 1], denyTools: 'nope', groups: { '12345': ['x'], bad: ['y'] } }),
    { mode: 'open', allowTools: ['a', '1'], denyTools: [], groups: { '12345': ['x'] } }, '未知名/非串/非法群键被规整丢弃')
})

test('open 模式:内置安全工具默认全量放通,敏感工具默认禁', () => {
  const surface = resolveSimToolSurface({ policy: normalizeSimToolPolicy({}), builtInNames: BUILT_IN, extraTools: [], groupId: '1' })
  assert.ok(surface.includes('searchMusicTool'), '普通工具默认放通')
  assert.ok(surface.includes('commitmentTool'))
  for (const name of RESTRICTED_SIM_TOOLS) {
    assert.ok(!surface.includes(name), `${name} 默认禁`)
  }
})

test('open 模式:减法/按群减法/显式解禁/自定义追加', () => {
  const policy = normalizeSimToolPolicy({ denyTools: ['bananaTool'], groups: { '11111': ['searchVideoTool'], bad: ['x'] }, allowTools: ['jinyanTool', 'myCustomTool'] })
  assert.deepEqual(Object.keys(policy.groups), ['11111'], '非法群键丢弃')
  const base = resolveSimToolSurface({ policy, builtInNames: BUILT_IN, extraTools: [], groupId: '2' })
  assert.ok(!base.includes('bananaTool'), '全局减法生效')
  assert.ok(base.includes('searchVideoTool'), '其他群不受按群减法影响')
  assert.ok(base.includes('jinyanTool'), 'allowTools 解禁敏感工具')
  assert.ok(base.includes('myCustomTool'), 'allowTools 放行自定义工具')
  const g11111 = resolveSimToolSurface({ policy, builtInNames: BUILT_IN, extraTools: [], groupId: '11111' })
  assert.ok(!g11111.includes('searchVideoTool'), '按群减法生效')
  // deny 优先于 allow:同名列 deny 赢
  const denyWins = resolveSimToolSurface({ policy: normalizeSimToolPolicy({ denyTools: ['jinyanTool'], allowTools: ['jinyanTool'] }), builtInNames: BUILT_IN, extraTools: [], groupId: '1' })
  assert.ok(!denyWins.includes('jinyanTool'), 'deny 优先于 allow')
})

test('open 模式:extraTools 恒为追加面(自定义工具显式放行,重复去重)', () => {
  const surface = resolveSimToolSurface({ policy: normalizeSimToolPolicy({}), builtInNames: BUILT_IN, extraTools: ['bananaTool', 'myCustomTool', 'bananaTool'], groupId: '1' })
  assert.ok(surface.includes('myCustomTool'), '自定义工具经 extraTools 追加')
  assert.equal(surface.filter(n => n === 'bananaTool').length, 1, '去重')
})

test('legacy 模式:维持 extraTools 白名单原行为,不受 deny/allow 影响', () => {
  const policy = normalizeSimToolPolicy({ mode: 'legacy', denyTools: ['bananaTool'], allowTools: ['jinyanTool'] })
  const surface = resolveSimToolSurface({ policy, builtInNames: BUILT_IN, extraTools: ['bananaTool'], groupId: '1' })
  assert.deepEqual(surface, ['bananaTool'], 'legacy 只看 extraTools,deny/allow 不掺和')
})

test('RESTRICTED 清单内容锚定:花钱/管人/改身份/出机隐私/双轨', () => {
  for (const name of ['jinyanTool', 'recallTool', 'sendGiftTool', 'grabRedBagTool', 'qqZoneTool', 'changeCardTool', 'mentionAdminsTool', 'reminderTool']) {
    assert.ok(RESTRICTED_SIM_TOOLS.includes(name), `${name} 在默认禁清单`)
  }
})
