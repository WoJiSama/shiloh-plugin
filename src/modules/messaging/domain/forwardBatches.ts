import { normalizeDeliveryReceipt } from './deliveryReceipt.js'

export const QQ_FORWARD_NODE_LIMIT = 100

type Awaitable<T> = T | PromiseLike<T>

export interface ForwardBatchOptions<Node, Payload> {
  makeForward: (batch: Node[]) => Awaitable<Payload>
  /** Transport receipts differ by adapter and must be inspected at runtime. */
  send: (payload: Payload) => Awaitable<unknown>
  onProgress?: (sent: number, total: number) => void
}

export async function sendForwardBatches<Node, Payload>(
  nodes: readonly Node[],
  { makeForward, send, onProgress = () => {} }: ForwardBatchOptions<Node, Payload>
): Promise<number> {
  const batches: Node[][] = []
  for (let offset = 0; offset < nodes.length; offset += QQ_FORWARD_NODE_LIMIT) {
    batches.push(nodes.slice(offset, offset + QQ_FORWARD_NODE_LIMIT))
  }
  let sent = 0
  for (const batch of batches) {
    // Await each receipt so records retain their original ordering.
    const payload = await makeForward(batch)
    const receipt = await send(payload)
    const normalized = normalizeDeliveryReceipt(receipt)
    if (normalized.state === 'unknown') throw Object.assign(new Error(`聊天记录第 ${sent + 1}/${batches.length} 份回执不确定；已确认发送 ${sent} 份，未自动重试`), { uncertain: true })
    if (normalized.state === 'failed') {
      throw new Error(`聊天记录第 ${sent + 1}/${batches.length} 份发送失败；已发送 ${sent} 份`)
    }
    sent++
    onProgress(sent, batches.length)
  }
  return sent
}
