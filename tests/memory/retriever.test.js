// tests/memory/retriever.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAliasPrompt, buildEntityPrompt, buildGroupFactsPrompt, buildContextualPrompt } from '../../domains/memory/engine/retriever.js'

const aliasDoc = {
  'maela': { qq: '3188163302', authority: 'teaching', confidence: 0.9, at: 2, display: 'maela' },
  '希洛':  { qq: '925640859',  authority: 'self',     confidence: 0.9, at: 1, display: '希洛' }
}

test('buildAliasPrompt lists mappings and is empty when no aliases', () => {
  const p = buildAliasPrompt(aliasDoc, '', 1200)
  assert.ok(p.includes('maela'))
  assert.ok(p.includes('3188163302'))
  assert.equal(buildAliasPrompt({}, '', 1200), '')
})

test('buildAliasPrompt prefers query-matched alias', () => {
  const p = buildAliasPrompt(aliasDoc, 'maela是谁', 1200)
  assert.ok(p.includes('maela'))
})

test('buildEntityPrompt formats name/aliases/facts, skips superseded', () => {
  const entity = { qq: '1', canonicalName: '咖啡大人', aliases: [
      { text: '咖啡', authority: 'self', confidence: 0.9, at: 1, superseded: false },
      { text: '旧名', authority: 'mention', confidence: 0.5, at: 0, superseded: true }
    ], facts: [{ text: '在上海', tags: [], refs: [], authority: 'self', confidence: 0.8, at: 1, superseded: false }] }
  const p = buildEntityPrompt(entity, 1200)
  assert.ok(p.includes('咖啡大人'))
  assert.ok(p.includes('咖啡'))
  assert.ok(!p.includes('旧名'))
  assert.ok(p.includes('在上海'))
})

test('buildGroupFactsPrompt sorts by confidence and caps by chars', () => {
  const facts = [
    { text: 'A群规', tags: ['群规'], authority: 'mention', confidence: 0.5, at: 1, superseded: false },
    { text: 'B重要', tags: [], authority: 'mention', confidence: 0.9, at: 2, superseded: false }
  ]
  const p = buildGroupFactsPrompt(facts, '', 2, 1200)
  assert.ok(p.indexOf('B重要') < p.indexOf('A群规'))
})

// ---- buildContextualPrompt（§1.2 顺序 + §1.3 分级措辞） ----

function fact(text, over = {}) {
  return { text, tags: [], refs: [], authority: 'mention', confidence: 0.7, at: 1, superseded: false, ...over }
}

test('buildContextualPrompt assembles sections in §1.2 order', () => {
  const speakerEntity = { qq: '1', canonicalName: '咖啡', aliases: [], facts: [fact('在上海工作', { authority: 'self', confidence: 0.9 })] }
  const mentionedEntities = [{ qq: '2', canonicalName: '阿强', aliases: [], facts: [fact('喜欢钓鱼', { authority: 'self', confidence: 0.9 })] }]
  const refsFacts = [fact('和阿强是同事', { authority: 'teaching', confidence: 0.9 })]
  const aliasDoc = { 'maela': { qq: '3', display: 'Maela', confidence: 0.9, at: 2 } }
  const groupFacts = [fact('群里不要刷屏', { tags: ['群规'], confidence: 0.9 })]
  const pendingFacts = [fact('下周有考试')]

  const p = buildContextualPrompt({ speakerEntity, mentionedEntities, refsFacts, aliasDoc, groupFacts, pendingFacts, config: {} })

  const iSpeaker = p.indexOf('【长期记忆】')
  const iPeople = p.indexOf('【相关的人】')
  const iRefs = p.indexOf('【关联信息】')
  const iAlias = p.indexOf('【群内称呼映射记忆】')
  const iGroup = p.indexOf('【群共识记忆】')
  const iPending = p.indexOf('【可自然提起】')
  assert.ok(iSpeaker >= 0 && iPeople > iSpeaker && iRefs > iPeople && iAlias > iRefs && iGroup > iAlias && iPending > iGroup)
  assert.ok(p.includes('在上海工作'))
  assert.ok(p.includes('喜欢钓鱼'))
  assert.ok(p.includes('下周有考试'))
})

test('buildContextualPrompt applies §1.3 confidence wording', () => {
  const speakerEntity = {
    qq: '1', canonicalName: null, aliases: [], facts: [
      fact('在上海', { authority: 'self', confidence: 0.9 }),
      fact('喜欢喝茶', { authority: 'mention', confidence: 0.4 }),
      fact('生日是夏天', { authority: 'teaching', confidence: 0.5 })
    ]
  }
  const p = buildContextualPrompt({ speakerEntity, config: {} })
  assert.ok(p.includes('- 在上海'))            // self -> 直述，无限定词
  assert.ok(!p.includes('好像 在上海'))
  assert.ok(p.includes('好像 喜欢喝茶'))         // mention/低置信 -> 好像
  assert.ok(p.includes('(据群里教学) 生日是夏天')) // teaching -> 据群里教学
})

test('buildContextualPrompt skips superseded facts', () => {
  const speakerEntity = {
    qq: '1', canonicalName: '咖啡', aliases: [], facts: [
      fact('当前事实', { authority: 'self', confidence: 0.9 }),
      fact('旧事实', { authority: 'self', confidence: 0.9, superseded: true })
    ]
  }
  const p = buildContextualPrompt({ speakerEntity, config: {} })
  assert.ok(p.includes('当前事实'))
  assert.ok(!p.includes('旧事实'))
})

test('buildContextualPrompt omits empty sections and pending header', () => {
  const speakerEntity = { qq: '1', canonicalName: '咖啡', aliases: [], facts: [] }
  const p = buildContextualPrompt({ speakerEntity, config: {} })
  assert.ok(p.includes('【长期记忆】'))
  assert.ok(!p.includes('【相关的人】'))
  assert.ok(!p.includes('【关联信息】'))
  assert.ok(!p.includes('【群共识记忆】'))
  assert.ok(!p.includes('【可自然提起】'))
})

test('buildContextualPrompt returns empty string when nothing to show', () => {
  assert.equal(buildContextualPrompt({ config: {} }), '')
  assert.equal(buildContextualPrompt({}), '')
})

test('buildContextualPrompt hard-truncates to promptMaxChars', () => {
  const facts = Array.from({ length: 50 }, (_, i) => fact(`事实编号${i}非常长的描述文本填充内容`, { authority: 'self', confidence: 0.9 }))
  const speakerEntity = { qq: '1', canonicalName: '咖啡', aliases: [], facts }
  const p = buildContextualPrompt({ speakerEntity, config: { promptMaxChars: 80 } })
  assert.ok(p.length <= 80)
})

// §0.4：entity 段消费 MM 传入的"已排序好的 facts"，按既定顺序渲染，不再自己重排。
test('buildContextualPrompt renders speaker facts in the given (pre-sorted) order', () => {
  const speakerEntity = {
    qq: '1', canonicalName: null, aliases: [], facts: [
      fact('第一条', { authority: 'self', confidence: 0.5 }),
      fact('第二条', { authority: 'self', confidence: 0.9 }) // 置信度更高但排在后 → 不应被前移
    ]
  }
  const p = buildContextualPrompt({ speakerEntity, config: {} })
  assert.ok(p.indexOf('第一条') < p.indexOf('第二条')) // 保持传入顺序
})

// §0.4：entity 段按 promptMaxEntityFacts 截断（向后兼容：给到全量时仍受上限保护）。
test('buildContextualPrompt caps entity facts at promptMaxEntityFacts', () => {
  const facts = Array.from({ length: 10 }, (_, i) => fact(`事实${i}`, { authority: 'self', confidence: 0.9 }))
  const speakerEntity = { qq: '1', canonicalName: null, aliases: [], facts }
  const p = buildContextualPrompt({ speakerEntity, config: { promptMaxEntityFacts: 3, promptMaxChars: 9999 } })
  assert.ok(p.includes('事实0') && p.includes('事实1') && p.includes('事实2'))
  assert.ok(!p.includes('事实3'))
})
