import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { GroupGuardManager } from '../dist/backend/modules/groupAdmin/infrastructure/GroupGuardManager.js'
import { GroupNoticeManager } from '../dist/backend/modules/groupAdmin/infrastructure/GroupNoticeManager.js'
import { GroupModerationManager } from '../dist/backend/modules/groupAdmin/infrastructure/GroupModerationManager.js'
import { AdCorpusStore } from '../dist/backend/modules/groupAdmin/infrastructure/adCorpusStore.js'

const serverFile = fileURLToPath(new URL('../console/server.js', import.meta.url))
const fields = view => Object.fromEntries(view.groups.flatMap(group => group.fields).map(field => [field.field, field]))

async function fixture(t, settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-admin-console-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  const token = 'isolated-group-admin-fixture-only'
  fs.writeFileSync(path.join(root, 'config', 'console.json'), JSON.stringify({ token }))
  const configFile = path.join(root, 'config', 'message.yaml')
  fs.writeFileSync(configFile, '# preserve group administration fixture comment\n' + YAML.stringify({
    envelopeExtension: 'retained', pluginSettings: { unrelated: { retained: 'original' }, ...settings }
  }))
  const child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env, CONSOLE_PLUGIN_ROOT: root, CONSOLE_HOST: '127.0.0.1', CONSOLE_PORT: '0',
      CONSOLE_YUNZAI_HOST: '127.0.0.1', CONSOLE_YUNZAI_PORT: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(async () => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  })
  const base = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`fixture startup timed out: ${output}`)) }, 5000)
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`fixture exited ${code ?? signal}: ${output}`)) })
  })
  const request = async (pathname, { method = 'GET', body, authenticated = true } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-console-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { status: response.status, data: await response.json() }
  }
  const readSettings = () => YAML.parse(fs.readFileSync(configFile, 'utf8')).pluginSettings
  const getGroup = async id => {
    const response = await request(`/api/groups/${id}/admin`)
    assert.equal(response.status, 200, JSON.stringify(response.data))
    return response.data
  }
  const saveGroup = async (id, values, resets) => {
    const current = await getGroup(id)
    const response = await request(`/api/groups/${id}/admin`, {
      method: 'PUT', body: { revision: current.revision, values, ...(resets ? { resets } : {}) }
    })
    assert.equal(response.status, 200, JSON.stringify(response.data))
    return response.data
  }
  return { root, configFile, request, readSettings, getGroup, saveGroup }
}

test('group administration HTTP isolates edits, enforces revisions, and preserves the configuration document', async t => {
  const f = await fixture(t, {
    allowedGroups: [],
    groupGuard: { enabled: false, enabledGroups: ['300003'], timeoutSeconds: 300 },
    groupModeration: { enabled: true, enabledGroups: ['400004'], groupAdmins: [{ groupId: '600006', admins: ['700007'] }] },
    groupNotice: { enabled: true, groupRules: [{ groupId: '500005', welcomeMessage: 'legacy-only group' }] },
    groupAdmin: { futureRoot: { retained: true }, overrides: [
      { groupId: '100001', futureRow: 'retained', groupGuard: { futureGuard: 'retained' } },
      { groupId: '200002', groupNotice: { enabled: true } }
    ] }
  })
  for (const endpoint of ['/api/config/groupAdmin', '/api/groups/100001/admin']) {
    assert.equal((await f.request(endpoint, { authenticated: false })).status, 401)
    assert.equal((await f.request(endpoint, { method: 'POST', body: {} })).status, 405)
  }
  for (const id of ['abc', '123', '1234567890123']) assert.equal((await f.request(`/api/groups/${id}/admin`)).status, 400)
  const listing = await f.request('/api/groups')
  assert.equal(listing.status, 200)
  const groups = listing.data.groups
  for (const id of ['100001', '200002', '300003', '400004', '500005', '600006']) {
    assert.ok(groups.some(group => group.id === id), `configured but inactive group ${id} must be discoverable`)
  }

  const a = await f.getGroup('100001'), b = await f.getGroup('200002')
  const savedB = await f.request('/api/groups/200002/admin', {
    method: 'PUT', body: { revision: b.revision, values: { 'groupGuard.timeoutSeconds': 120 } }
  })
  assert.equal(savedB.status, 200)
  const savedA = await f.request('/api/groups/100001/admin', {
    method: 'PUT', body: { revision: a.revision, values: { 'groupGuard.enabled': true, 'groupGuard.timeoutSeconds': 90, 'groupNotice.welcomeMessage': '' } }
  })
  assert.equal(savedA.status, 200, 'saving another group must not stale this group revision')
  assert.ok(savedA.data.changed > 0)
  assert.ok(savedA.data.backup)
  assert.equal(fields(savedA.data)['groupGuard.timeoutSeconds'].value, 90)
  assert.equal(fields(savedA.data)['groupGuard.timeoutSeconds'].inheritance, 'custom')
  assert.equal(fields(savedA.data)['groupNotice.welcomeMessage'].value, '')
  assert.equal('masters' in savedA.data, false, '总开关不再作为按群生效前置')
  assert.equal((await f.getGroup('200002')).revision, savedB.data.revision)
  const stale = await f.request('/api/groups/100001/admin', {
    method: 'PUT', body: { revision: a.revision, values: { 'groupGuard.timeoutSeconds': 180 } }
  })
  assert.equal(stale.status, 409)

  const defaults = (await f.request('/api/config/groupAdmin')).data
  const savedDefaults = await f.request('/api/config/groupAdmin', {
    method: 'PUT', body: { revision: defaults.revision, values: { 'groupGuard.timeoutSeconds': 240, 'groupGuard.enabled': true } }
  })
  assert.equal(savedDefaults.status, 200)
  assert.equal(savedDefaults.data.applyMode, 'hot')
  assert.equal((await f.request('/api/groups/100001/admin', {
    method: 'PUT', body: { revision: savedA.data.revision, values: { 'groupGuard.timeoutSeconds': 180 } }
  })).status, 409, 'changing defaults must invalidate a group editor even if its displayed timeout is custom')
  assert.equal((await f.request('/api/config/groupAdmin', {
    method: 'PUT', body: { revision: defaults.revision, values: { 'groupGuard.enabled': false } }
  })).status, 409)

  const configBeforeInvalid = fs.readFileSync(f.configFile, 'utf8')
  const current = await f.getGroup('100001')
  for (const values of [
    { 'groupGuard.unknown': true }, { 'groupModeration.admins': ['invalid-qq'] },
    { 'groupGuard.questionOperators': ['multiply'] }, { 'groupGuard.timeoutSeconds': '' }
  ]) {
    assert.equal((await f.request('/api/groups/100001/admin', { method: 'PUT', body: { revision: current.revision, values } })).status, 400)
  }
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), configBeforeInvalid, 'invalid writes must not change the document')
  const stored = f.readSettings()
  assert.deepEqual(stored.unrelated, { retained: 'original' })
  assert.equal(stored.groupGuard.timeoutSeconds, 240)
  assert.equal(stored.groupAdmin.overrides[0].groupGuard.timeoutSeconds, 90)
  assert.equal(stored.groupAdmin.overrides[1].groupGuard.timeoutSeconds, 120)
  assert.equal(stored.groupAdmin.overrides[0].futureRow, 'retained')
  assert.equal(stored.groupAdmin.overrides[0].groupGuard.futureGuard, 'retained')
  assert.deepEqual(stored.groupAdmin.futureRoot, { retained: true })
  assert.equal(fs.readFileSync(f.configFile, 'utf8').includes('# preserve group administration fixture comment'), true)
  assert.equal(YAML.parse(fs.readFileSync(f.configFile, 'utf8')).envelopeExtension, 'retained')

  // A second writer changing this group's legacy configuration must also be detected.
  const beforeExternal = await f.getGroup('100001')
  const doc = YAML.parseDocument(fs.readFileSync(f.configFile, 'utf8'))
  doc.setIn(['pluginSettings', 'groupModeration', 'groupAdmins'], [{ groupId: '100001', admins: ['700008'] }])
  fs.writeFileSync(f.configFile, doc.toString())
  assert.equal((await f.request('/api/groups/100001/admin', {
    method: 'PUT', body: { revision: beforeExternal.revision, values: { 'groupGuard.timeoutSeconds': 180 } }
  })).status, 409)
})

test('group HTTP saves and resets preserve comments on untouched fields and sibling YAML sequence entries', async t => {
  const f = await fixture(t, {
    groupGuard: { enabled: true, timeoutSeconds: 300 },
    groupModeration: { enabled: true, groupAdmins: [
      { groupId: '100001', admins: ['700001'] }, { groupId: '200002', admins: ['700002'] }
    ] },
    groupNotice: { enabled: true, welcomeMessage: 'default welcome', groupRules: [
      { groupId: '100001', welcomeMessage: 'legacy welcome', leaveMessage: 'legacy leave' },
      { groupId: '200002', welcomeMessage: 'other legacy welcome' }
    ] },
    groupAdmin: { overrides: [
      { groupId: '100001', groupGuard: { timeoutSeconds: 60, kickOnTimeout: false } },
      { groupId: '200002', groupGuard: { timeoutSeconds: 120 } }
    ] }
  })
  const doc = YAML.parseDocument(fs.readFileSync(f.configFile, 'utf8'))
  const annotations = [
    [['groupAdmin', 'overrides', 0, 'groupGuard', 'kickOnTimeout'], ' preserve-current-unmodified-guard-field'],
    [['groupAdmin', 'overrides', 1, 'groupGuard', 'timeoutSeconds'], ' preserve-sibling-override-field'],
    [['groupNotice', 'groupRules', 1, 'welcomeMessage'], ' preserve-sibling-legacy-notice'],
    [['groupModeration', 'groupAdmins', 1, 'admins'], ' preserve-sibling-legacy-admins']
  ]
  for (const [keys, comment] of annotations) doc.getIn(['pluginSettings', ...keys], true).comment = comment
  fs.writeFileSync(f.configFile, doc.toString())
  const checkComments = () => {
    const source = fs.readFileSync(f.configFile, 'utf8')
    for (const [, comment] of annotations) assert.ok(source.includes(`#${comment}`), `lost YAML comment:${comment}`)
  }
  checkComments()
  await f.saveGroup('100001', {
    'groupGuard.timeoutSeconds': 90, 'groupModeration.admins': ['700003'], 'groupNotice.welcomeMessage': 'custom welcome'
  })
  checkComments()
  await f.saveGroup('100001', {}, ['groupGuard.timeoutSeconds', 'groupModeration.admins', 'groupNotice.welcomeMessage'])
  checkComments()
  let settings = f.readSettings()
  assert.deepEqual(settings.groupAdmin.overrides, [
    { groupId: '100001', groupGuard: { kickOnTimeout: false } },
    { groupId: '200002', groupGuard: { timeoutSeconds: 120 } }
  ])
  assert.deepEqual(settings.groupModeration.groupAdmins, [{ groupId: '200002', admins: ['700002'] }])
  assert.deepEqual(settings.groupNotice.groupRules, [
    { groupId: '100001', leaveMessage: 'legacy leave' },
    { groupId: '200002', welcomeMessage: 'other legacy welcome' }
  ])

  // Adding and then removing a group must leave the sequence's existing entries and comments intact.
  await f.saveGroup('300003', { 'groupGuard.timeoutSeconds': 180 })
  settings = f.readSettings()
  assert.equal(settings.groupAdmin.overrides.length, 3)
  assert.deepEqual(settings.groupAdmin.overrides[2], { groupId: '300003', groupGuard: { timeoutSeconds: 180 } })
  checkComments()
  await f.saveGroup('300003', {}, ['groupGuard.timeoutSeconds'])
  assert.deepEqual(f.readSettings().groupAdmin.overrides.map(row => row.groupId), ['100001', '200002'])
  checkComments()
  await f.saveGroup('100001', {}, ['groupGuard.kickOnTimeout'])
  assert.deepEqual(f.readSettings().groupAdmin.overrides, [{ groupId: '200002', groupGuard: { timeoutSeconds: 120 } }])
  const afterFirstRemoval = fs.readFileSync(f.configFile, 'utf8')
  for (const [, comment] of annotations.slice(1)) assert.ok(afterFirstRemoval.includes(`#${comment}`), `lost sibling comment after removing first entry:${comment}`)
  await f.saveGroup('100001', { 'groupGuard.timeoutSeconds': 240 })
  assert.deepEqual(f.readSettings().groupAdmin.overrides, [
    { groupId: '200002', groupGuard: { timeoutSeconds: 120 } },
    { groupId: '100001', groupGuard: { timeoutSeconds: 240 } }
  ])
  const afterFirstReadd = fs.readFileSync(f.configFile, 'utf8')
  for (const [, comment] of annotations.slice(1)) assert.ok(afterFirstReadd.includes(`#${comment}`), `lost sibling comment after appending first group again:${comment}`)
})

test('HTTP resets target legacy aliases and migrate implicit notice flags without losing group activation', async t => {
  const f = await fixture(t, {
    groupModeration: { enabled: true, globalAdmins: ['700003'], groupAdmins: [
      { group_id: ' 100001 ', users: ['700001'] }, { group: '200002', userIds: ['700002'] }
    ] },
    groupNotice: { enabled: true, welcomeEnabled: false, leaveEnabled: false, groupRules: [
      { groupId: ' 100001 ', welcomeMessage: 'legacy welcome', leaveMessage: 'legacy leave' },
      { groupId: '200002', welcomeMessage: 'other legacy welcome' }
    ] }
  })
  const doc = YAML.parseDocument(fs.readFileSync(f.configFile, 'utf8'))
  doc.getIn(['pluginSettings', 'groupModeration', 'groupAdmins', 1, 'userIds'], true).comment = ' sibling-alias-admins-comment'
  doc.getIn(['pluginSettings', 'groupNotice', 'groupRules', 1, 'welcomeMessage'], true).comment = ' sibling-trimmed-notice-comment'
  fs.writeFileSync(f.configFile, doc.toString())
  const original = fields(await f.getGroup('100001'))
  assert.deepEqual(original['groupModeration.admins'].value, ['700001'])
  assert.equal(original['groupModeration.admins'].inheritance, 'legacy')
  assert.equal(original['groupNotice.enabled'].value, true)
  assert.equal(original['groupNotice.welcomeEnabled'].value, true)
  assert.equal(original['groupNotice.leaveEnabled'].value, true)
  const saved = await f.saveGroup('100001', { 'groupModeration.admins': [] })
  assert.deepEqual(fields(saved)['groupModeration.admins'].value, [])
  assert.equal(fields(saved)['groupModeration.admins'].inheritance, 'custom')
  const reset = await f.saveGroup('100001', {}, ['groupModeration.admins', 'groupNotice.welcomeEnabled', 'groupNotice.leaveEnabled'])
  for (const name of ['welcomeEnabled', 'leaveEnabled']) {
    assert.equal(fields(reset)[`groupNotice.${name}`].value, false)
    assert.equal(fields(reset)[`groupNotice.${name}`].inheritance, 'default')
  }
  assert.equal(fields(reset)['groupNotice.enabled'].value, true)
  assert.equal(fields(reset)['groupNotice.welcomeMessage'].value, 'legacy welcome')
  assert.equal(fields(reset)['groupNotice.leaveMessage'].value, 'legacy leave')
  assert.deepEqual(f.readSettings().groupModeration.groupAdmins, [{ group: '200002', userIds: ['700002'] }])
  assert.deepEqual(f.readSettings().groupNotice.groupRules, [
    { groupId: ' 100001 ' }, { groupId: '200002', welcomeMessage: 'other legacy welcome' }
  ])
  const source = fs.readFileSync(f.configFile, 'utf8')
  assert.ok(source.includes('# sibling-alias-admins-comment'))
  assert.ok(source.includes('# sibling-trimmed-notice-comment'))
  assert.deepEqual(fields(await f.getGroup('200002'))['groupModeration.admins'].value, ['700002'])

  const sent = []
  const group = { getMemberMap: async () => new Map(), sendMsg: async message => sent.push(message) }
  const bot = { uin: 600006, pickGroup: () => group }
  const notice = new GroupNoticeManager({ readSettings: f.readSettings, getBot: () => bot })
  const event = { group_id: 100001, user_id: 800008, self_id: 600006, group }
  assert.equal(await notice.handleGroupIncrease(event), false)
  assert.equal(await notice.handleGroupDecrease(event), false)
  assert.deepEqual(sent, [])
  const defaults = (await f.request('/api/config/groupAdmin')).data
  assert.equal((await f.request('/api/config/groupAdmin', {
    method: 'PUT', body: { revision: defaults.revision, values: { 'groupNotice.welcomeEnabled': true, 'groupNotice.leaveEnabled': true } }
  })).status, 200)
  const inheritedEnabled = fields(await f.getGroup('100001'))
  assert.equal(inheritedEnabled['groupNotice.enabled'].value, true)
  assert.equal(inheritedEnabled['groupNotice.welcomeEnabled'].value, true)
  assert.equal(inheritedEnabled['groupNotice.welcomeEnabled'].inheritance, 'default')
  assert.equal(await notice.handleGroupIncrease(event), true)
  assert.equal(sent.pop(), 'legacy welcome')
  assert.equal(await notice.handleGroupDecrease(event), true)
  assert.equal(sent.pop(), 'legacy leave')
})

test('HTTP resets remove all duplicate group aliases and patch each duplicate legacy notice row independently', async t => {
  const otherAdmins = [
    { group: '200002', userIds: ['700003'], futureAdmin: 'other first' },
    { groupId: '300003', admins: ['700005'], futureAdmin: 'other second' }
  ]
  const otherNotices = [
    { groupId: '200002', welcomeMessage: 'other first welcome', leaveMessage: 'other first leave' },
    { groupId: '300003', welcomeMessage: 'other second welcome' }
  ]
  const f = await fixture(t, {
    groupModeration: { enabled: true, groupAdmins: [
      { group_id: ' 100001 ', users: ['700001'] }, otherAdmins[0],
      { groupId: 100001, admins: ['700002'] }, otherAdmins[1],
      { group: '100001', userIds: ['700004'] }
    ] },
    groupNotice: { enabled: true, welcomeMessage: 'default welcome', leaveMessage: 'default leave', groupRules: [
      { groupId: ' 100001 ', welcomeMessage: 'first legacy welcome', leaveMessage: 'first legacy leave', futureRule: 'first retained' },
      otherNotices[0],
      { groupId: 100001, welcomeMessage: 'second legacy welcome', leaveMessage: 'second legacy leave', futureRule: 'second retained' },
      otherNotices[1]
    ] }
  })
  const doc = YAML.parseDocument(fs.readFileSync(f.configFile, 'utf8'))
  const permanentComments = [
    [['groupModeration', 'groupAdmins', 1, 'userIds'], ' duplicate-reset-other-first-admins'],
    [['groupModeration', 'groupAdmins', 3, 'futureAdmin'], ' duplicate-reset-other-second-admins'],
    [['groupNotice', 'groupRules', 0, 'futureRule'], ' duplicate-reset-first-notice-extension'],
    [['groupNotice', 'groupRules', 1, 'welcomeMessage'], ' duplicate-reset-other-first-notice'],
    [['groupNotice', 'groupRules', 2, 'futureRule'], ' duplicate-reset-second-notice-extension'],
    [['groupNotice', 'groupRules', 3, 'welcomeMessage'], ' duplicate-reset-other-second-notice']
  ]
  const leaveComments = [
    [['groupNotice', 'groupRules', 0, 'leaveMessage'], ' duplicate-reset-first-untouched-leave'],
    [['groupNotice', 'groupRules', 2, 'leaveMessage'], ' duplicate-reset-second-untouched-leave']
  ]
  for (const [keys, comment] of [...permanentComments, ...leaveComments]) doc.getIn(['pluginSettings', ...keys], true).comment = comment
  fs.writeFileSync(f.configFile, doc.toString())
  const checkComments = annotations => {
    const source = fs.readFileSync(f.configFile, 'utf8')
    for (const [, comment] of annotations) assert.ok(source.includes(`#${comment}`), `lost comment while resetting duplicate group rows:${comment}`)
  }
  const otherRevision = (await f.getGroup('200002')).revision
  const original = fields(await f.getGroup('100001'))
  assert.deepEqual(original['groupModeration.admins'].value, ['700001'])
  assert.equal(original['groupNotice.welcomeMessage'].value, 'first legacy welcome')
  const reset = await f.saveGroup('100001', {}, ['groupModeration.admins', 'groupNotice.welcomeMessage'])
  assert.deepEqual(fields(reset)['groupModeration.admins'].value, [], 'no later duplicate legacy list may become active after resetting the first')
  assert.equal(fields(reset)['groupModeration.admins'].inheritance, 'default')
  assert.equal(fields(reset)['groupNotice.welcomeMessage'].value, 'default welcome')
  assert.equal(fields(reset)['groupNotice.welcomeMessage'].inheritance, 'default')
  assert.equal(fields(reset)['groupNotice.leaveMessage'].value, 'first legacy leave')
  assert.deepEqual(f.readSettings().groupModeration.groupAdmins, otherAdmins, 'every alias of the target group must be removed')
  assert.deepEqual(f.readSettings().groupNotice.groupRules, [
    { groupId: ' 100001 ', leaveMessage: 'first legacy leave', futureRule: 'first retained' },
    otherNotices[0],
    { groupId: 100001, leaveMessage: 'second legacy leave', futureRule: 'second retained' },
    otherNotices[1]
  ], 'each duplicate rule must retain its own untouched values')
  checkComments([...permanentComments, ...leaveComments])
  assert.equal((await f.getGroup('200002')).revision, otherRevision)

  const resetLeave = await f.saveGroup('100001', {}, ['groupNotice.leaveMessage'])
  assert.equal(fields(resetLeave)['groupNotice.leaveMessage'].value, 'default leave')
  assert.equal(fields(resetLeave)['groupNotice.enabled'].value, true, 'resetting all legacy templates must preserve group activation')
  assert.deepEqual(f.readSettings().groupNotice.groupRules, [
    { groupId: ' 100001 ', futureRule: 'first retained' }, otherNotices[0],
    { groupId: 100001, futureRule: 'second retained' }, otherNotices[1]
  ])
  assert.deepEqual(f.readSettings().groupModeration.groupAdmins, otherAdmins)
  checkComments(permanentComments)
  assert.equal((await f.getGroup('200002')).revision, otherRevision)
})

test('HTTP persisted group policies drive compiled guard, notices, moderation, and legacy reset behavior', async t => {
  const f = await fixture(t, {
    groupGuard: { enabled: true, timeoutSeconds: 300, maxWrongTimes: 1, passMessage: '', timeoutMessage: '' },
    groupModeration: {
      enabled: true, globalAdmins: ['700001'],
      groupAdmins: [{ groupId: '100001', admins: ['700002'] }],
      actions: { kickEnabled: true, muteEnabled: false, recallEnabled: false },
      thresholds: { report: 0.1, kick: 0.1 }, publicReportEnabled: false, forwardEvidenceToAdmins: false, adCorpusAutoCollect: false
    },
    groupNotice: {
      enabled: true, welcomeMessage: 'default welcome {userId}', leaveMessage: 'default leave',
      groupRules: [{ groupId: '100001', welcomeMessage: 'legacy welcome', leaveMessage: 'legacy leave', futureRule: 'retained' }]
    }
  })
  const sent = [], apiCalls = []
  let members = new Map([[600006, { role: 'admin' }], [800008, { role: 'member', nickname: 'fixture user', level: 0 }]])
  const group = { name: 'isolated group', getMemberMap: async () => members, sendMsg: async message => sent.push(message) }
  const bot = {
    uin: 600006, pickGroup: () => group,
    sendApi: async (method, params) => { apiCalls.push({ method, params }); return { status: 'ok' } }
  }
  const ports = { readSettings: f.readSettings, getBot: () => bot }
  const event = id => ({ group_id: Number(id), user_id: 800008, self_id: 600006, bot, group, sender: { role: 'member', level: 0 }, reply: async message => sent.push(message) })
  const guard = new GroupGuardManager(ports)
  const notice = new GroupNoticeManager(ports)
  const moderation = new GroupModerationManager(ports, new AdCorpusStore({ filePath: path.join(f.root, 'isolated-ad-corpus.jsonl') }))
  t.after(() => { for (const key of guard.pending.keys()) guard.clearPending(key) })
  await f.saveGroup('100001', {
    'groupGuard.enabled': true, 'groupGuard.timeoutSeconds': 60, 'groupGuard.kickOnWrongAnswer': false,
    'groupModeration.enabled': true, 'groupModeration.admins': ['700003'], 'groupModeration.actions.kickEnabled': false,
    'groupNotice.enabled': true, 'groupNotice.welcomeMessage': 'saved welcome {userId}'
  })
  await f.saveGroup('200002', {
    'groupGuard.enabled': false, 'groupGuard.timeoutSeconds': 120,
    'groupModeration.enabled': true, 'groupNotice.enabled': true, 'groupNotice.welcomeMessage': 'other welcome {userId}'
  })
  assert.equal(guard.getConfig('100001').timeoutSeconds, 60)
  assert.equal(guard.getConfig('200002').timeoutSeconds, 120)
  assert.deepEqual(moderation.getNotificationAdmins(moderation.getConfig('100001'), '100001'), ['700001', '700003'])
  assert.deepEqual(moderation.getNotificationAdmins(moderation.getConfig('200002'), '200002'), ['700001'])
  assert.equal(await notice.handleGroupIncrease(event('100001')), false, 'the current group guard suppresses its welcome')
  assert.equal(await notice.handleGroupIncrease(event('200002')), true)
  assert.equal(sent.pop(), 'other welcome 800008')
  assert.equal(await guard.handleGroupIncrease(event('100001')), true)
  assert.ok(guard.pending.has('100001:800008'))
  assert.equal(await guard.handleGroupIncrease(event('200002')), false)
  const answer = guard.pending.get('100001:800008').answer
  await guard.handleMessage({ ...event('100001'), msg: String(Number(answer) + 9999) })
  assert.equal(apiCalls.length, 0, 'the saved local kick override must protect a wrong-answer user')

  const ad = { ...event('100001'), msg: '兼职副业 日结佣金 免费带 名额有限 加微信 abcdefg https://example.invalid', message_id: 1 }
  assert.equal(await moderation.handleMessage(ad), true)
  assert.equal(apiCalls.length, 0, 'local moderation kick=false must override the global punitive action')
  assert.equal(await moderation.handleMessage({ ...ad, group_id: 200002 }), true)
  assert.equal(apiCalls.at(-1).method, 'set_group_kick')
  assert.equal(apiCalls.at(-1).params.group_id, 200002)
  apiCalls.length = 0

  members = new Map([[600006, { role: 'admin' }], [800008, { role: 'owner' }]])
  assert.equal(await guard.handleGroupIncrease(event('100001')), false)
  assert.equal(await guard.kickUser(event('100001'), 100001, 800008, 'fixture'), false)
  assert.equal(await moderation.handleMessage({ ...ad, group_id: 200002, sender: { role: 'owner', level: 0 } }), false)
  assert.equal(apiCalls.length, 0, 'native owners remain protected')
  members = new Map([[600006, { role: 'member' }], [800008, { role: 'member', level: 0 }]])
  assert.equal(await guard.handleGroupIncrease(event('100001')), false)
  assert.equal(await moderation.handleMessage({ ...ad, group_id: 200002 }), false)
  assert.equal(apiCalls.length, 0, 'punitive actions require bot administrator permission')

  members = new Map([[600006, { role: 'admin' }], [800008, { role: 'member', level: 0 }]])
  await guard.handleGroupIncrease(event('100001'))
  const sentBeforeDisable = sent.length
  await f.saveGroup('100001', { 'groupGuard.enabled': false })
  await guard.handleTimeout(100001, 800008)
  assert.equal(guard.pending.size, 0)
  assert.equal(apiCalls.length, 0, 'disabling a group must cancel pending timeout punishment')
  assert.equal(sent.length, sentBeforeDisable, 'disabling a group must also suppress pending timeout messages')
  assert.equal(await notice.handleGroupIncrease(event('100001')), true)
  assert.equal(sent.pop(), 'saved welcome 800008')

  const reset = await f.saveGroup('100001', {}, ['groupGuard.timeoutSeconds', 'groupModeration.admins', 'groupNotice.welcomeMessage', 'groupNotice.leaveMessage'])
  assert.equal(fields(reset)['groupGuard.enabled'].value, false)
  assert.equal(fields(reset)['groupNotice.enabled'].value, true)
  assert.equal(guard.getConfig('100001').timeoutSeconds, 300)
  assert.deepEqual(moderation.getNotificationAdmins(moderation.getConfig('100001'), '100001'), ['700001'])
  const legacyRule = f.readSettings().groupNotice.groupRules.find(row => row.groupId === '100001')
  assert.equal(Object.hasOwn(legacyRule, 'welcomeMessage'), false)
  assert.equal(Object.hasOwn(legacyRule, 'leaveMessage'), false)
  assert.equal(legacyRule.futureRule, 'retained')
  assert.equal(await notice.handleGroupIncrease(event('100001')), true)
  assert.equal(sent.pop(), 'default welcome 800008')
  assert.equal(await notice.handleGroupIncrease(event('200002')), true)
  assert.equal(sent.pop(), 'other welcome 800008')

  await f.saveGroup('100001', { 'groupGuard.enabled': true })
  const defaults = (await f.request('/api/config/groupAdmin')).data
  assert.equal((await f.request('/api/config/groupAdmin', {
    method: 'PUT', body: { revision: defaults.revision, values: { 'groupGuard.enabled': false, 'groupModeration.enabled': false, 'groupNotice.enabled': false } }
  })).status, 200)
  // 新语义：总开关只是默认值——本群显式启用的模块不再被默认关闭拦截
  assert.equal(await guard.handleGroupIncrease(event('100001')), true, '显式启用的入群验证无视默认总开关关闭')
  assert.equal(await moderation.handleMessage({ ...ad, group_id: 200002 }), true, '显式启用的广告扫描无视默认总开关关闭')
  assert.equal(apiCalls.at(-1).method, 'set_group_kick')
  assert.equal(await notice.handleGroupIncrease(event('200002')), true)
  assert.equal(sent.pop(), 'other welcome 800008')
})
