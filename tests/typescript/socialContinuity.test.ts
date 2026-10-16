import {test} from 'node:test'
import assert from 'node:assert/strict'
import {recordTurnContinuity, loadTurnContinuity} from '../../src/modules/conversation/application/turnContinuity.js'
import {buildSocialContinuity, buildTurnInteractionContext, buildTurnInteractionPrompt, withTurnInteractionEvidence, withTurnSocialInterpretation} from '../../src/modules/conversation/domain/turnInteractionContext.js'

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

test('a sent three-turn object change keeps the current restriction rather than a rhetorical question', async () => {
  const {redis} = redisFixture()
  const scope = {redis, groupId: 'social-object-change', userId: '7', botId: '99', persona}
  const addressing = {botId: '99', persona, addressee: {targetKind: 'bot'}}
  const first = buildTurnInteractionContext({...addressing, rawUserText: '开个玩笑，我宣布你今天的工资是三块饼干'})
  const firstReply = '三块饼干？行吧，我先把它们存着。'
  const firstSocial = buildSocialContinuity(first, firstReply)
  assert.equal(firstSocial.pendingInteraction, undefined, 'echoing the offered quantity does not ask the user for more information')
  await recordTurnContinuity({...scope, lastReply: firstReply, social: firstSocial})

  const second = buildTurnInteractionContext({...addressing, rawUserText: '先扣两块，刚刚溜号了，哈哈', continuity: await loadTurnContinuity(scope)})
  assert.equal(second.social?.continuation?.previous.text, firstReply)
  assert.equal(second.social?.pendingInteraction, undefined)
  const relabeled = withTurnSocialInterpretation(second, {act: 'teasing', confidence: 0.99}, 'understanding_model')
  assert.equal(relabeled.kind, 'banter')
  assert.equal(relabeled.social?.activeBit?.text, second.rawUserText)
  const enriched = withTurnInteractionEvidence(relabeled, [{origin: 'tool', kind: 'image', state: 'unavailable'}])
  assert.equal(enriched.social?.continuation?.previous.text, firstReply)
  const secondReply = '那就剩一块，先留着。'
  await recordTurnContinuity({...scope, lastReply: secondReply, social: buildSocialContinuity(enriched, secondReply)})

  const third = buildTurnInteractionContext({...addressing, rawUserText: '剩下那块也不能吃，是年终奖', continuity: await loadTurnContinuity(scope)})
  assert.equal(third.social?.act, 'teasing')
  assert.equal(third.social?.continuation?.previous.text, secondReply)
  assert.equal(third.social?.activeBit?.text, third.rawUserText)
  const prompt = buildTurnInteractionPrompt(third)
  assert.match(prompt, /保留它归谁、由谁给谁/)
  assert.match(prompt, /自己的提议或讨价还价不等于对方已同意/)
  assert.match(prompt, /打算做的动作不等于已经完成/)
  assert.match(prompt, /不靠突然升级关系推进/)
})

test('a concrete playful response ends an old invitation to explain the attention bid', async () => {
  const {redis} = redisFixture()
  const scope = {redis, groupId: 'social-attention-purpose-change', userId: '7', botId: '99', persona}
  const addressing = {botId: '99', persona, addressee: {targetKind: 'bot'}}
  const first = buildTurnInteractionContext({...addressing, rawUserText: '你为什么不理我呀'})
  const firstReply = '在呢，我听着。你想聊什么？'
  await recordTurnContinuity({...scope, lastReply: firstReply, social: buildSocialContinuity(first, firstReply)})
  const second = buildTurnInteractionContext({...addressing, rawUserText: '给你三秒把我哄好，开玩笑的', continuity: await loadTurnContinuity(scope)})
  assert.equal(second.social?.act, 'teasing')
  assert.equal(second.social?.previousStance?.kind, 'supportive')
  assert.equal(second.social?.pendingInteraction, undefined, 'the new playful instruction supplies the current conversational purpose')
  assert.match(buildTurnInteractionPrompt(second), /不用让对方重新解释为什么想被回应/)

  const secondReply = '那这三秒就认真听你说。'
  await recordTurnContinuity({...scope, lastReply: secondReply, social: buildSocialContinuity(second, secondReply)})
  const task = buildTurnInteractionContext({...addressing, rawUserText: '认真问，帮我分析一下这份报错', continuity: await loadTurnContinuity(scope)})
  assert.equal(task.kind, 'serious_answer')
  assert.equal(task.social?.continuation, undefined)
  assert.equal(task.social?.activeBit, undefined)
})
