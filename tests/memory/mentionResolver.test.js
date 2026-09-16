// tests/memory/mentionResolver.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMentions } from '../../domains/memory/engine/mentionResolver.js'

const aliasDoc = {
  'maela': { qq: '3188163302', authority: 'teaching', confidence: 0.9, at: 2, display: 'Maela' },
  '希洛': { qq: '925640859', authority: 'self', confidence: 0.9, at: 1, display: '希洛' }
}

const entities = {
  e1: { qq: '925640859', canonicalName: '希洛', aliases: [{ text: '咖啡', superseded: false }], facts: [] },
  e2: { qq: '111222', canonicalName: '阿强', aliases: [{ text: '旧名', superseded: true }], facts: [] }
}

test('resolves explicit @QQ:数字 and QQ:数字 forms', () => {
  const out = resolveMentions('帮我问 @QQ:3188163302 和 QQ：111222 一下', { aliasDoc, entities, max: 5 })
  assert.deepEqual(out.qqs.sort(), ['111222', '3188163302'])
})

test('resolves alias hit via normalizeAlias against aliasDoc', () => {
  const out = resolveMentions('Maela! 在吗', { aliasDoc, entities, max: 5 })
  assert.ok(out.qqs.includes('3188163302'))
})

test('resolves entity canonicalName/alias substring hit', () => {
  const out = resolveMentions('咖啡今天来了没', { aliasDoc, entities, max: 5 })
  assert.ok(out.qqs.includes('925640859'))
})

test('dedupes across sources', () => {
  // 希洛 命中别名表 + 实体 canonicalName，且同一 QQ
  const out = resolveMentions('希洛 希洛 @QQ:925640859', { aliasDoc, entities, max: 5 })
  assert.deepEqual(out.qqs, ['925640859'])
})

test('caps result at max', () => {
  const out = resolveMentions('@QQ:1111 @QQ:2222 @QQ:3333 @QQ:4444', { aliasDoc: {}, entities: {}, max: 2 })
  assert.equal(out.qqs.length, 2)
  assert.deepEqual(out.qqs, ['1111', '2222'])
})

test('defaults max to 3 when not provided', () => {
  const out = resolveMentions('@QQ:1111 @QQ:2222 @QQ:3333 @QQ:4444', { aliasDoc: {}, entities: {} })
  assert.equal(out.qqs.length, 3)
})

test('excludes speakerQQ from every source', () => {
  const out = resolveMentions('希洛 @QQ:3188163302', {
    aliasDoc,
    entities,
    speakerQQ: '925640859',
    max: 5
  })
  assert.ok(!out.qqs.includes('925640859'))
  assert.ok(out.qqs.includes('3188163302'))
})

test('skips superseded entity aliases', () => {
  const out = resolveMentions('旧名 来了', { aliasDoc, entities, max: 5 })
  assert.ok(!out.qqs.includes('111222'))
})

test('no match returns empty array', () => {
  const out = resolveMentions('随便聊聊天气', { aliasDoc, entities, max: 5 })
  assert.deepEqual(out.qqs, [])
})

test('handles empty/blank message and missing inputs', () => {
  assert.deepEqual(resolveMentions('', {}).qqs, [])
  assert.deepEqual(resolveMentions(null, {}).qqs, [])
  assert.deepEqual(resolveMentions('希洛', {}).qqs, [])
})
