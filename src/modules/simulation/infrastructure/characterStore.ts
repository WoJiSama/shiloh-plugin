import { randomUUID } from 'node:crypto'
import type { CharacterScope, CharacterState } from '../../../contracts/character.js'
import { characterKey, compactCharacterState, createEmptyCharacterState, validateCharacterState } from '../domain/characterState.js'
import type { SimRedisLike } from './simSessionStore.js'

export interface CharacterRedis extends SimRedisLike {
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

// Also serialize fake/in-process stores that lack Lua. Production Redis uses the token checked commit below.
const queues = new WeakMap<object, Map<string, Promise<unknown>>>()
const COMMIT = 'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end redis.call("SET", KEYS[2], ARGV[2]) redis.call("DEL", KEYS[1]) return 1'
const RELEASE = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end'

export function createCharacterStore({ redis, now = Date.now, retainEvidenceRefs }: { redis: CharacterRedis; now?: () => number; retainEvidenceRefs?(scope: CharacterScope): Promise<string[]> }) {
  async function load(scope: CharacterScope): Promise<CharacterState> {
    const raw = await redis.get(characterKey(scope))
    // Do not turn corrupt/failed reads into an empty state that can overwrite history.
    return raw === null ? createEmptyCharacterState(scope) : validateCharacterState(JSON.parse(raw), scope)
  }

  async function update(scope: CharacterScope, mutate: (state: CharacterState) => CharacterState): Promise<CharacterState> {
    const key = characterKey(scope)
    let queue = queues.get(redis)
    if (!queue) { queue = new Map(); queues.set(redis, queue) }
    const previous = queue.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const token = randomUUID()
      const lock = `${key}:lock`
      let acquired = false
      if (redis.eval) {
        const deadline = Date.now() + 2500
        do {
          const result = await redis.set(lock, token, { NX: true, PX: 10_000 })
          acquired = result === 'OK' || result === true
          if (!acquired) await new Promise(resolve => setTimeout(resolve, 25))
        } while (!acquired && Date.now() < deadline)
        if (!acquired) throw new Error('角色状态正忙，请稍后重试')
      }
      try {
        const current = await load(scope)
        const retained = retainEvidenceRefs ? await retainEvidenceRefs(scope) : []
        const next = validateCharacterState(mutate(compactCharacterState(structuredClone(current), now(), retained)), scope)
        next.revision = current.revision + 1
        if (redis.eval) {
          const committed = await redis.eval(COMMIT, { keys: [lock, key], arguments: [token, JSON.stringify(next)] })
          if (Number(committed) !== 1) throw new Error('角色状态锁已失效，修改未提交')
          acquired = false
        } else {
          await redis.set(key, JSON.stringify(next))
        }
        return next
      } finally {
        if (acquired) await redis.eval!(RELEASE, { keys: [lock], arguments: [token] })
      }
    })
    queue.set(key, operation)
    try { return await operation } finally { if (queue.get(key) === operation) queue.delete(key) }
  }
  return { load, update }
}
