/**
 * 出站消息仲裁（refactor-blueprint §四.3）：一个回合的所有出站消息过同一个有序队列。
 *
 * - 有序：回合内每次发送都排在上一次完成之后，进度话/正文/结果不再竞态乱序；
 * - 承诺约束：工具结果未决时，「承诺类文案」（如"好，我整理成卡片发你"）先扣住，
 *   工具全部成功才放行，出现失败则丢弃——杜绝"先说我去办、工具没成、再补一句"的事故；
 * - 重入保护：正在出队的发送函数内部再触发 e.reply 时直接放行，避免队列自锁。
 *
 * 事件包装（wrapEvent）让工具内部的 e.reply 天然入队；显式承诺通过 enqueue("commitment", ...) 进入。
 */
export function createOutboundArbiter({ logger, trace } = {}) {
  let queueTail = Promise.resolve()
  let dispatching = false
  let outcomeResolved = true
  const held = []
  const stats = { sent: 0, dropped: 0, deferred: 0 }

  const dispatch = send => {
    queueTail = queueTail.then(async () => {
      dispatching = true
      try {
        await send()
        stats.sent++
        trace?.countOutbound()
      } catch (error) {
        logger?.warn?.(`[出站仲裁] 单条出站发送失败，不阻断后续出站: ${error?.message || error}`)
      } finally {
        dispatching = false
      }
    })
    return queueTail
  }

  const arbiter = {
    stats,

    /** 工具即将执行，承诺类文案进入待定状态 */
    beginToolOutcomes() {
      outcomeResolved = false
    },

    /** 工具结果落定：成功放行扣住的承诺，失败全部丢弃 */
    resolveToolOutcomes({ failed = false } = {}) {
      if (outcomeResolved) return
      outcomeResolved = true
      const pending = held.splice(0)
      if (failed) {
        stats.dropped += pending.length
        if (pending.length) logger?.info?.(`[出站仲裁] 工具结果失败，丢弃承诺类文案 ${pending.length} 条`)
        return
      }
      for (const send of pending) dispatch(send)
    },

    markFailure() {
      arbiter.resolveToolOutcomes({ failed: true })
    },

    /** 回合兜底：仍有未落定的承诺时，按工具结果决定放行或丢弃 */
    settle(outcomes = []) {
      if (outcomeResolved) return
      const failed = !outcomes.length || outcomes.some(outcome => outcome?.success === false)
      arbiter.resolveToolOutcomes({ failed })
    },

    enqueue(kind, send) {
      if (typeof send !== "function") return queueTail
      if (kind === "commitment" && !outcomeResolved) {
        held.push(send)
        stats.deferred++
        return queueTail
      }
      return dispatch(send)
    },

    wrapReply(reply) {
      if (typeof reply !== "function") return reply
      const wrapped = async (message, options) => {
        if (dispatching) return reply(message, options)
        return arbiter.enqueue("default", () => reply(message, options))
      }
      return wrapped
    },

    wrapEvent(e) {
      if (!e) return e
      const wrapped = Object.create(e)
      wrapped.reply = arbiter.wrapReply(typeof e.reply === "function" ? e.reply.bind(e) : e.reply)
      return wrapped
    }
  }

  return arbiter
}
