import {test} from 'node:test'
import assert from 'node:assert/strict'
import {recordTurnContinuity, loadTurnContinuity} from '../../src/modules/conversation/application/turnContinuity.js'
import {buildSocialContinuity, buildTurnInteractionContext} from '../../src/modules/conversation/domain/turnInteractionContext.js'

const persona = {personaId: 'first', personaVersion: 'v2', personaName: '安序'}
function redisFixture() {
  const rows = new Map<string, string>()
  return {rows, redis: {get: async (key: string) => rows.get(key) ?? null,
    set: async (key: string, value: string, _options: {EX: number}) => {rows.set(key, value); return 'OK'}}}
}

test('confirmed social continuity persists to Redis and returns to the same persona next turn', async () => {
  const {redis, rows} = redisFixture()
  const scope = {redis, groupId: 'social-continuity-roundtrip', userId: '7', botId: '99', persona}
  const first = buildTurnInteractionContext({rawUserText: '这个电子体香', botId: '99', persona})
  const lastReply = '这瓶电子体香预热挺快。你给它选哪个香调？'
  const social = buildSocialContinuity(first, lastReply)
  await recordTurnContinuity({...scope, lastReply, social})
  const stored = JSON.parse([...rows.values()][0]!) as {social: unknown}
  assert.deepEqual(stored.social, social)
  const loaded = await loadTurnContinuity(scope)
  assert.ok(loaded)
  assert.deepEqual(loaded.social, social)
  const next = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', persona, continuity: loaded})
  assert.equal(next.social?.act, 'teasing')
  assert.equal(next.social?.activeBit?.text, lastReply)
  assert.equal(next.social?.pendingInteraction?.text, '你给它选哪个香调？')
  assert.equal(next.social?.previousStance?.kind, 'playful')
  assert.equal(await loadTurnContinuity({...scope, persona: {...persona, personaVersion: 'v3'}}), null)
  assert.equal(await loadTurnContinuity({...scope, persona: {...persona, personaId: 'second'}}), null)
  assert.equal(await loadTurnContinuity({...scope, botId: '100'}), null)
})

test('the writer only persists excerpts present in delivered lastReply', async () => {
  const {redis} = redisFixture()
  const scope = {redis, groupId: 'social-continuity-write-validation', userId: '7', botId: '99', persona}
  const written = await recordTurnContinuity({...scope, lastReply: '已发出的句子。',
    social: {activeBit: '从未发出的梗', pendingInteraction: '凭空的问题？', stance: 'neutral'}})
  assert.deepEqual(written.social, {stance: 'neutral'})
  const empty = await recordTurnContinuity({...scope, lastReply: '', social: {activeBit: '别人的梗', stance: 'playful'}})
  assert.equal(empty.social, undefined)
  const outsideSummary = await recordTurnContinuity({...scope, lastReply: `${'正文'.repeat(200)}。被截去的问题？`,
    social: {activeBit: '正文', pendingInteraction: '被截去的问题？', stance: 'matter_of_fact'}})
  assert.deepEqual(outsideSummary.social, {activeBit: '正文', stance: 'matter_of_fact'})
})

test('Redis reader independently validates social fields and keeps legacy records readable', async () => {
  const {redis, rows} = redisFixture()
  const scope = {redis, groupId: 'social-continuity-read-validation', userId: '7', botId: '99', persona}
  const row = await recordTurnContinuity({...scope, lastReply: '真实的梗。你选哪个？'})
  const key = [...rows.keys()][0]!
  rows.set(key, JSON.stringify({...row, social: {activeBit: '真实的梗', pendingInteraction: '假问题？', stance: 'invented-emotion', previousStance: '编造关系'}}))
  assert.deepEqual((await loadTurnContinuity(scope))?.social, {activeBit: '真实的梗'})
  rows.set(key, JSON.stringify({...row, social: {activeBit: ['真实的梗'], pendingInteraction: {text: '你选哪个？'}, stance: 1}}))
  assert.equal((await loadTurnContinuity(scope))?.social, undefined)
  rows.set(key, JSON.stringify(row))
  assert.equal((await loadTurnContinuity(scope))?.lastReply, row.lastReply)
  assert.equal((await loadTurnContinuity(scope))?.social, undefined)
})

test('fallback loads also revalidate mutated output objects instead of trusting an in-process reference', async () => {
  const scope = {groupId: 'social-continuity-memory-validation', userId: '7', botId: '99', persona}
  const row = await recordTurnContinuity({...scope, lastReply: '真实的梗。', social: {activeBit: '真实的梗', stance: 'playful'}})
  assert.ok(row.social)
  row.social.activeBit = '调用者后来塞入的假梗'
  assert.deepEqual((await loadTurnContinuity(scope))?.social, {stance: 'playful'})
})

test('excerpts tolerate actual whitespace normalization and Unicode without splitting delivered text', async () => {
  const scope = {groupId: 'social-continuity-unicode', userId: '7', botId: '99', persona}
  const row = await recordTurnContinuity({...scope, lastReply: `${'🫧'.repeat(200)}。你给它\n选哪个？`,
    social: {activeBit: '🫧'.repeat(20), pendingInteraction: '你给它 选哪个？', stance: 'playful'}})
  assert.ok(row.lastReply.includes('选哪个？'))
  assert.deepEqual((await loadTurnContinuity(scope))?.social, {activeBit: '🫧'.repeat(20), pendingInteraction: '你给它 选哪个？', stance: 'playful'})
})
