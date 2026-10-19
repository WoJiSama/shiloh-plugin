import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildGroupAdminDefaultsView, buildGroupAdminView,
  prepareGroupAdminDefaultUpdates, prepareGroupAdminUpdates
} from '../dist/backend/adapters/config/groupAdminConfig.js'
import {
  configuredGroupAdminIds, groupAdminStatus, resolveGroupAdminSettings
} from '../dist/backend/modules/groupAdmin/domain/groupAdminPolicy.js'

const copy = value => structuredClone(value)
const fields = view => Object.fromEntries(view.groups.flatMap(group => group.fields).map(field => [field.field, field]))
function apply(settings, updates) {
  const result = copy(settings)
  for (const [name, value] of Object.entries(updates)) {
    const parts = name.split('.')
    let cursor = result
    for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {}
    cursor[parts.at(-1)] = copy(value)
  }
  return result
}
function policy() {
  return {
    unrelated: { retained: true },
    groupGuard: { enabled: true, enabledGroups: ['100001'], timeoutSeconds: 300, kickOnTimeout: true },
    groupModeration: {
      enabled: true, enabledGroups: ['100001', '200002'], globalAdmins: ['700001'],
      groupAdmins: [{ groupId: '100001', admins: ['700002'] }, { groupId: '200002', admins: ['700003'] }],
      thresholds: { report: 0.7, recall: 0.85, mute: 0.9, kick: 0.97 },
      actions: { recallEnabled: true, muteEnabled: true, kickEnabled: true, muteSeconds: 900 }
    },
    groupNotice: {
      enabled: true, welcomeEnabled: true, leaveEnabled: true,
      welcomeMessage: 'default welcome', leaveMessage: 'default leave',
      groupRules: [
        { groupId: '100001', welcomeMessage: 'legacy welcome', leaveMessage: 'legacy leave', futureRule: 'keep' },
        { groupId: '200002', welcomeMessage: 'other welcome' }
      ]
    },
    groupAdmin: { futureRoot: 'keep', overrides: [
      {
        groupId: '100001', futureRow: { retained: true },
        groupGuard: { timeoutSeconds: 60, kickOnTimeout: false, futureGuard: 'keep' },
        groupModeration: { admins: [], thresholds: { kick: 0.99 }, actions: { recallEnabled: false } },
        groupNotice: { welcomeEnabled: false, welcomeMessage: '' }
      },
      { groupId: '200002', groupGuard: { enabled: true, timeoutSeconds: 120 } }
    ] }
  }
}

test('group policy deeply inherits sparse actions and thresholds while preserving explicit false and empty overrides', () => {
  const settings = policy(), before = copy(settings)
  const a = resolveGroupAdminSettings(settings, '100001')
  const b = resolveGroupAdminSettings(settings, '200002')
  assert.equal(a.groupGuard.timeoutSeconds, 60)
  assert.equal(a.groupGuard.kickOnTimeout, false)
  assert.deepEqual(a.groupModeration.thresholds, { report: 0.7, recall: 0.85, mute: 0.9, kick: 0.99 })
  assert.deepEqual(a.groupModeration.actions, { recallEnabled: false, muteEnabled: true, kickEnabled: true, muteSeconds: 900 })
  assert.deepEqual(a.groupModeration.groupAdmins.find(row => row.groupId === '100001').admins, [])
  assert.deepEqual(a.groupModeration.globalAdmins, ['700001'])
  assert.equal(a.groupNotice.welcomeEnabled, false)
  assert.equal(a.groupNotice.welcomeMessage, '')
  assert.equal(a.groupNotice.leaveMessage, 'legacy leave')
  assert.equal(b.groupGuard.timeoutSeconds, 120)
  assert.equal(b.groupGuard.kickOnTimeout, true)
  assert.equal(b.groupNotice.welcomeMessage, 'other welcome')
  assert.deepEqual(settings, before, 'reading either group must not mutate shared defaults or another group')

  const view = fields(buildGroupAdminView('100001', settings))
  assert.equal(view['groupGuard.enabled'].value, true)
  assert.equal(view['groupGuard.enabled'].inheritance, 'legacy')
  assert.equal(view['groupGuard.timeoutSeconds'].defaultValue, 300)
  assert.equal(view['groupGuard.timeoutSeconds'].inheritedValue, 300)
  assert.equal(view['groupGuard.timeoutSeconds'].inheritance, 'custom')
  assert.equal(view['groupNotice.welcomeMessage'].value, '')
  assert.equal(view['groupNotice.welcomeMessage'].inheritedValue, 'legacy welcome')
  assert.equal(view['groupNotice.leaveMessage'].inheritance, 'legacy')
  assert.deepEqual(view['groupModeration.admins'].value, [])
  assert.deepEqual(configuredGroupAdminIds(settings).sort(), ['100001', '200002'])
})

test('saving one group keeps sparse overrides, unknown future fields, and other groups intact', () => {
  const settings = policy(), before = copy(settings)
  const otherRevision = buildGroupAdminView('200002', settings).revision
  const prepared = prepareGroupAdminUpdates('100001', settings, {
    revision: buildGroupAdminView('100001', settings).revision,
    values: { 'groupGuard.enabled': true, 'groupGuard.timeoutSeconds': 90, 'groupModeration.thresholds.report': 0.6, 'groupNotice.leaveMessage': '' }
  })
  assert.ok(prepared.changed > 0)
  assert.deepEqual(Object.keys(prepared.updates), ['groupAdmin.overrides'])
  const saved = apply(settings, prepared.updates)
  const row = saved.groupAdmin.overrides.find(row => row.groupId === '100001')
  assert.deepEqual(row.futureRow, { retained: true })
  assert.equal(row.groupGuard.futureGuard, 'keep')
  assert.equal(row.groupGuard.timeoutSeconds, 90)
  assert.deepEqual(row.groupModeration.thresholds, { kick: 0.99, report: 0.6 })
  assert.equal(Object.hasOwn(row.groupModeration.thresholds, 'mute'), false, 'inherited fields must stay sparse')
  assert.equal(row.groupNotice.leaveMessage, '')
  assert.deepEqual(saved.groupAdmin.overrides[1], settings.groupAdmin.overrides[1])
  assert.equal(buildGroupAdminView('200002', saved).revision, otherRevision)
  assert.deepEqual(saved.groupGuard, settings.groupGuard)
  assert.equal(saved.groupAdmin.futureRoot, 'keep')
  assert.deepEqual(settings, before, 'preparing a write must be pure')
})

test('restore defaults removes both current and legacy overrides while retaining group activation', () => {
  const settings = policy()
  settings.groupAdmin.overrides[0].groupNotice.enabled = true
  settings.groupAdmin.overrides[0].groupModeration.enabled = true
  const prepared = prepareGroupAdminUpdates('100001', settings, {
    revision: buildGroupAdminView('100001', settings).revision,
    resets: ['groupGuard.timeoutSeconds', 'groupGuard.kickOnTimeout', 'groupNotice.welcomeMessage', 'groupNotice.leaveMessage', 'groupNotice.welcomeEnabled', 'groupModeration.admins']
  })
  const saved = apply(settings, prepared.updates)
  const row = saved.groupAdmin.overrides[0]
  assert.equal(Object.hasOwn(row.groupGuard, 'timeoutSeconds'), false)
  assert.equal(Object.hasOwn(row.groupGuard, 'kickOnTimeout'), false)
  assert.equal(Object.hasOwn(row.groupNotice, 'welcomeMessage'), false)
  assert.equal(Object.hasOwn(row.groupNotice, 'leaveMessage'), false)
  assert.equal(Object.hasOwn(row.groupModeration, 'admins'), false)
  assert.equal(row.groupNotice.enabled, true)
  assert.equal(row.groupModeration.enabled, true)
  const legacy = saved.groupNotice.groupRules.find(row => row.groupId === '100001')
  assert.equal(Object.hasOwn(legacy, 'welcomeMessage'), false)
  assert.equal(Object.hasOwn(legacy, 'leaveMessage'), false)
  assert.equal(legacy.futureRule, 'keep')
  assert.deepEqual(saved.groupModeration.groupAdmins, [{ groupId: '200002', admins: ['700003'] }])
  const view = fields(buildGroupAdminView('100001', saved))
  assert.equal(view['groupGuard.enabled'].value, true)
  assert.equal(view['groupNotice.enabled'].value, true)
  assert.equal(view['groupNotice.welcomeMessage'].value, 'default welcome')
  assert.equal(view['groupNotice.welcomeMessage'].inheritance, 'default')
  assert.deepEqual(view['groupModeration.admins'].value, [])
  assert.deepEqual(saved.groupNotice.groupRules[1], settings.groupNotice.groupRules[1])
  assert.equal(row.groupGuard.futureGuard, 'keep')
})

test('group revision rejects own or default concurrent edits and accepts unrelated group changes', () => {
  const settings = policy()
  const revision = buildGroupAdminView('100001', settings).revision
  const payload = { revision, values: { 'groupGuard.timeoutSeconds': 90 } }
  const other = copy(settings)
  other.unrelated.retained = false
  other.groupAdmin.overrides[1].groupGuard.timeoutSeconds = 180
  other.groupNotice.groupRules[1].welcomeMessage = 'concurrent other welcome'
  other.groupModeration.groupAdmins[1].admins = ['700004']
  assert.ok(prepareGroupAdminUpdates('100001', other, payload).changed > 0)
  const own = copy(settings)
  own.groupAdmin.overrides[0].groupGuard.timeoutSeconds = 180
  assert.throws(() => prepareGroupAdminUpdates('100001', own, payload), error => error.status === 409)
  const defaults = copy(settings)
  defaults.groupGuard.timeoutSeconds = 240
  assert.throws(() => prepareGroupAdminUpdates('100001', defaults, payload), error => error.status === 409)
  const legacy = copy(settings)
  legacy.groupNotice.groupRules[0].welcomeMessage = 'concurrent own legacy welcome'
  assert.throws(() => prepareGroupAdminUpdates('100001', legacy, payload), error => error.status === 409)
})

test('legacy moderation aliases share group identity for display, empty override, reset, and concurrency', () => {
  const settings = {
    groupModeration: { enabled: true, globalAdmins: ['700003'], groupAdmins: [
      { group_id: ' 100001 ', users: ['700001'], futureAlias: 'retained' },
      { group: '200002', userIds: ['700002'] }
    ] }
  }
  const original = buildGroupAdminView('100001', settings)
  assert.deepEqual(fields(original)['groupModeration.admins'].value, ['700001'])
  assert.equal(fields(original)['groupModeration.admins'].inheritance, 'legacy')
  assert.deepEqual(fields(buildGroupAdminView('200002', settings))['groupModeration.admins'].value, ['700002'])
  assert.deepEqual(configuredGroupAdminIds(settings).sort(), ['100001', '200002'])
  const concurrentOwn = copy(settings)
  concurrentOwn.groupModeration.groupAdmins[0].users = ['700004']
  assert.throws(() => prepareGroupAdminUpdates('100001', concurrentOwn, { revision: original.revision, values: { 'groupModeration.admins': [] } }), error => error.status === 409)
  const empty = apply(settings, prepareGroupAdminUpdates('100001', settings, { revision: original.revision, values: { 'groupModeration.admins': [] } }).updates)
  assert.deepEqual(fields(buildGroupAdminView('100001', empty))['groupModeration.admins'].value, [])
  assert.deepEqual(resolveGroupAdminSettings(empty, '100001').groupModeration.groupAdmins, [
    { group: '200002', userIds: ['700002'] }, { groupId: '100001', admins: [] }
  ])
  const reset = apply(empty, prepareGroupAdminUpdates('100001', empty, {
    revision: buildGroupAdminView('100001', empty).revision, resets: ['groupModeration.admins']
  }).updates)
  assert.deepEqual(reset.groupModeration.groupAdmins, [{ group: '200002', userIds: ['700002'] }])
  assert.deepEqual(fields(buildGroupAdminView('100001', reset))['groupModeration.admins'].value, [])
  assert.equal(fields(buildGroupAdminView('100001', reset))['groupModeration.admins'].inheritance, 'default')
  assert.deepEqual(fields(buildGroupAdminView('200002', reset))['groupModeration.admins'].value, ['700002'])
})

test('resetting legacy notice flags keeps templates while inheriting disabled and future enabled defaults', () => {
  const settings = {
    groupNotice: { enabled: true, welcomeEnabled: false, leaveEnabled: false, groupRules: [
      { groupId: ' 100001 ', welcomeMessage: 'legacy welcome', leaveMessage: 'legacy leave' }
    ] }
  }
  const original = buildGroupAdminView('100001', settings)
  assert.equal(fields(original)['groupNotice.enabled'].value, true)
  assert.equal(fields(original)['groupNotice.welcomeEnabled'].value, true)
  assert.equal(fields(original)['groupNotice.welcomeEnabled'].inheritance, 'legacy')
  assert.equal(fields(original)['groupNotice.leaveEnabled'].value, true)
  const reset = apply(settings, prepareGroupAdminUpdates('100001', settings, {
    revision: original.revision, resets: ['groupNotice.welcomeEnabled', 'groupNotice.leaveEnabled']
  }).updates)
  assert.deepEqual(reset.groupNotice.groupRules, [{ groupId: ' 100001 ' }])
  assert.deepEqual(reset.groupAdmin.overrides, [{ groupId: '100001', groupNotice: { welcomeMessage: 'legacy welcome', leaveMessage: 'legacy leave' } }])
  const after = fields(buildGroupAdminView('100001', reset))
  for (const key of ['welcomeEnabled', 'leaveEnabled']) {
    assert.equal(after[`groupNotice.${key}`].value, false)
    assert.equal(after[`groupNotice.${key}`].inheritance, 'default')
  }
  assert.equal(after['groupNotice.enabled'].value, true)
  assert.equal(after['groupNotice.welcomeMessage'].value, 'legacy welcome')
  assert.equal(after['groupNotice.leaveMessage'].value, 'legacy leave')
  reset.groupNotice.welcomeEnabled = true
  reset.groupNotice.leaveEnabled = true
  const changedDefaults = fields(buildGroupAdminView('100001', reset))
  assert.equal(changedDefaults['groupNotice.welcomeEnabled'].value, true)
  assert.equal(changedDefaults['groupNotice.leaveEnabled'].value, true)
  assert.equal(changedDefaults['groupNotice.welcomeEnabled'].inheritance, 'default')

  const disabled = copy(settings)
  disabled.groupAdmin = { overrides: [{ groupId: '100001', groupNotice: { enabled: false, welcomeEnabled: false, welcomeMessage: 'local template' } }] }
  const resolved = resolveGroupAdminSettings(disabled, '100001').groupNotice
  assert.deepEqual(resolved.groupRules, [], 'trimmed legacy rules must not leak back into the notice manager')
  assert.equal(resolved.welcomeMessage, 'local template')
  assert.equal(resolved.welcomeEnabled, false)
  assert.equal(groupAdminStatus(disabled, '100001').groupNotice, false)
})

test('restoring the last known policy field keeps unknown future row content', () => {
  const settings = { groupAdmin: { overrides: [
    { groupId: '100001', futureRow: { retained: true }, futureModule: { opaque: 'retained' }, groupGuard: { timeoutSeconds: 60 } }
  ] } }
  const reset = apply(settings, prepareGroupAdminUpdates('100001', settings, {
    revision: buildGroupAdminView('100001', settings).revision, resets: ['groupGuard.timeoutSeconds']
  }).updates)
  assert.deepEqual(reset.groupAdmin.overrides, [{ groupId: '100001', futureRow: { retained: true }, futureModule: { opaque: 'retained' } }])
})

test('group activation overrides module defaults; malformed policies are rejected before producing updates', () => {
  const settings = policy()
  settings.groupGuard.enabled = false
  settings.groupAdmin.overrides[0].groupGuard.enabled = true
  assert.equal(fields(buildGroupAdminView('100001', settings))['groupGuard.enabled'].value, true)
  assert.equal(groupAdminStatus(settings, '100001').groupGuard, true, '显式启用的群不再被默认总开关拦截')
  const revision = buildGroupAdminView('100001', settings).revision
  const stringFalse = prepareGroupAdminUpdates('100001', settings, { revision, values: { 'groupGuard.enabled': 'false' } })
  assert.equal(fields(buildGroupAdminView('100001', apply(settings, stringFalse.updates)))['groupGuard.enabled'].value, false)
  for (const payload of [
    { values: { 'groupGuard.unknown': true } },
    { values: { 'groupModeration.globalAdmins': ['700001'] } },
    { values: { 'groupModeration.admins': ['not-a-qq'] } },
    { values: { 'groupGuard.questionOperators': ['multiply'] } },
    { values: { 'groupGuard.timeoutSeconds': 30.5 } },
    { values: { 'groupGuard.timeoutSeconds': '' } },
    { values: { 'groupGuard.enabled': 'disabled' } },
    { values: { 'groupGuard.timeoutSeconds': 90 }, resets: ['groupGuard.timeoutSeconds'] },
    { resets: ['groupGuard.enabled'] },
    { values: {}, injected: true }
  ]) assert.throws(() => prepareGroupAdminUpdates('100001', settings, { revision, ...payload }), error => error.status === 400, JSON.stringify(payload))
  for (const id of ['', 'abc', '1', '1234567890123', '../100001']) {
    assert.throws(() => buildGroupAdminView(id, settings), error => error.status === 400)
    assert.throws(() => prepareGroupAdminUpdates(id, settings, { revision }), error => error.status === 400)
  }
  const defaultRevision = buildGroupAdminDefaultsView(settings).revision
  assert.throws(() => prepareGroupAdminDefaultUpdates(settings, { values: {} }), error => error.status === 409)
  assert.throws(() => prepareGroupAdminDefaultUpdates(settings, { revision: defaultRevision, values: { 'groupModeration.globalAdmins': ['bad'] } }), error => error.status === 400)
  assert.throws(() => prepareGroupAdminDefaultUpdates(settings, { revision: defaultRevision, values: { 'groupGuard.questionOperators': ['mul'] } }), error => error.status === 400)
})
