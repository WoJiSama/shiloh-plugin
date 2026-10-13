import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnSessionStore, TURN_SESSION_FIELDS } from '../../src/modules/runtime/domain/turnSession.js'
import type { TurnSession, SessionId } from '../../src/modules/runtime/domain/turnSession.js'

test('fake clock at epoch zero: TTL boundary, activity refresh and object identity', () => {
  let time = 0
  const store = createTurnSessionStore({ now: () => time, ttlMs: 10 })
  const first = store.getOrCreate('uuid', [])
  assert.equal(first.__createdAt, 0)
  assert.equal(first.__lastActiveAt, 0)
  time = 10
  assert.equal(store.sweep(), 0)
  assert.equal(store.getOrCreate('uuid', ['ignored']), first)
  assert.equal(first.__lastActiveAt, 10)
  assert.deepEqual(first.tools, [])
  time = 20
  assert.equal(store.sweep(), 0)
  time = 21
  assert.equal(store.sweep(), 1)
})

test('capacity removes least active sessions, including numeric zero keys', () => {
  let time = 0
  const store = createTurnSessionStore({ now: () => time, maxSessions: 2 })
  store.getOrCreate(0, [])
  time = 1
  store.getOrCreate('a', [])
  time = 2
  store.getOrCreate('b', [])
  assert.equal(store.sweep(), 1)
  assert.equal(store.get(0), undefined)
  time = 3
  store.getOrCreate('a', [])
  time = 4
  store.getOrCreate('c', [])
  assert.equal(store.sweep(), 1)
  assert.equal(store.get('b'), undefined)
})

test('shared legacy map identity, missing metadata and zero activity are preserved', () => {
  const existing: TurnSession = { tools: [], __createdAt: 100, __lastActiveAt: 0 }
  const map = new Map<SessionId, TurnSession>([['legacy', existing], ['missing', {}]])
  const store = createTurnSessionStore({ map, now: () => 11, ttlMs: 10 })
  assert.equal(store.map, map)
  assert.equal(store.get('legacy'), existing)
  assert.equal(store.sweep(), 2)
  assert.equal(map.size, 0)
})

test('refresh tools, clear and zero capacity operate on the shared map', () => {
  const store = createTurnSessionStore({ maxSessions: 0, now: () => 0 })
  const a = store.getOrCreate('a', [])
  store.getOrCreate('b', [])
  const tools = ['updated']
  store.refreshTools(tools)
  assert.equal(a.tools, tools)
  store.clear('b')
  store.clear('absent')
  assert.equal(store.stats().sessions, 1)
  assert.equal(store.sweep(), 1)
  assert.equal(store.stats().sessions, 0)
  assert.equal(new Set(TURN_SESSION_FIELDS.map(field => field.name)).size, TURN_SESSION_FIELDS.length)
})
