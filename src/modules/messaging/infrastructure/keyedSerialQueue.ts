export class KeyedSerialQueue {
  tails: Map<string, Promise<unknown>>
  constructor() {
    this.tails = new Map()
  }

  run<T>(key: unknown, work: () => T | Promise<T>) {
    const queueKey = String(key || "default")
    const previous = this.tails.get(queueKey) || Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    this.tails.set(queueKey, current)
    current.finally(() => {
      if (this.tails.get(queueKey) === current) this.tails.delete(queueKey)
    }).catch(() => {})
    return current
  }

  get size() {
    return this.tails.size
  }
}

export class AsyncSemaphore {
  limit: number
  active: number
  waiters: (() => void)[]
  constructor(limit = 4) {
    this.limit = Math.max(1, Number(limit) || 4)
    this.active = 0
    this.waiters = []
  }

  async run<T>(work: () => T | Promise<T>) {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    this.active++
    try {
      return await work()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}
