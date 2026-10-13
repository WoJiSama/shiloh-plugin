export class LeaseLostError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} lease lost: ${id}`)
    this.name = "LeaseLostError"
  }
}

export function startLeaseHeartbeat({ store, kind, id, token, leaseMs, logger }: { store: { extendLock(kind: string, id: string, token: string, leaseMs: number): Promise<boolean> }; kind: string; id: string; token: string; leaseMs: number; logger?: { warn?(message: string): void } | undefined }) {
  const intervalMs = Math.max(1000, Math.floor(Math.max(3000, Number(leaseMs) || 60000) / 3))
  let stopped = false
  let running: Promise<boolean> | null = null

  const renew = async () => {
    if (stopped) return false
    if (running) return await running
    running = Promise.resolve()
      .then(() => store.extendLock(kind, id, token, leaseMs))
      .catch(error => {
        logger?.warn?.(`[MessagePipeline] ${kind} 租约续期失败 id=${id}: ${error.message}`)
        return false
      })
      .finally(() => { running = null })
    return await running
  }

  const timer = setInterval(() => { renew().catch(() => {}) }, intervalMs)
  timer.unref?.()

  return {
    renew,
    async assertOwned() {
      if (!await renew()) throw new LeaseLostError(kind, id)
    },
    stop() {
      stopped = true
      clearInterval(timer)
    }
  }
}
