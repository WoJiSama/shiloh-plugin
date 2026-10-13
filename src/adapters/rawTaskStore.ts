import type { TaskStore, TaskWriteOptions } from '../contracts/taskStore.js'

export interface RawTaskStoreOptions {
  /** Resolve on each call so legacy runtime client replacement remains supported. */
  redis: () => unknown
  memory: Map<string, string>
}

export function createRawTaskStore({ redis, memory }: RawTaskStoreOptions): TaskStore {
  function method(name: 'get' | 'set' | 'del'): { receiver: object; invoke: (...args: unknown[]) => unknown } | null {
    const receiver = redis()
    if ((typeof receiver !== 'object' || receiver === null) && typeof receiver !== 'function') return null
    const candidate: unknown = Reflect.get(receiver, name)
    if (!candidate) return null
    if (typeof candidate !== 'function') throw new TypeError(`Redis ${name} is not a function`)
    return { receiver, invoke: candidate as (...args: unknown[]) => unknown }
  }
  return {
    async getRaw(key: string) {
      const redisGet = method('get')
      if (redisGet) return await Reflect.apply(redisGet.invoke, redisGet.receiver, [key]) as unknown
      return memory.get(key) || null
    },
    async setRaw(key: string, value: string, options: TaskWriteOptions = {}) {
      const redisSet = method('set')
      if (redisSet) return await Reflect.apply(redisSet.invoke, redisSet.receiver, [key, value, options]) as unknown
      if (options.NX && memory.has(key)) return null
      memory.set(key, value)
      return 'OK'
    },
    async delRaw(key: string) {
      const redisDel = method('del')
      if (redisDel) return await Reflect.apply(redisDel.invoke, redisDel.receiver, [key]) as unknown
      return memory.delete(key) ? 1 : 0
    }
  }
}
