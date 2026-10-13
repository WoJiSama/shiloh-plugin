export const QQ_FORWARD_NODE_LIMIT = 100

type Awaitable<T> = T | PromiseLike<T>

export interface ForwardBatchOptions<Node, Payload> {
  makeForward: (batch: Node[]) => Awaitable<Payload>
  /** Transport receipts differ by adapter and must be inspected at runtime. */
  send: (payload: Payload) => Awaitable<unknown>
  onProgress?: (sent: number, total: number) => void
}

function isFailedReceipt(receipt: unknown): boolean {
  if (receipt === false) return true
  if ((typeof receipt !== 'object' && typeof receipt !== 'function') || receipt === null) return false
  const status = 'status' in receipt ? receipt.status : undefined
  const retcode = 'retcode' in receipt ? receipt.retcode : undefined
  return status === 'failed' || (retcode != null && Number(retcode) !== 0)
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
    if (isFailedReceipt(receipt)) {
      throw new Error(`聊天记录第 ${sent + 1}/${batches.length} 份发送失败；已发送 ${sent} 份`)
    }
    sent++
    onProgress(sent, batches.length)
  }
  return sent
}
