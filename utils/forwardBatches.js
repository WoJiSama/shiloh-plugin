export const QQ_FORWARD_NODE_LIMIT = 100

export async function sendForwardBatches(nodes, { makeForward, send, onProgress = () => {} }) {
  const batches = []
  for (let offset = 0; offset < nodes.length; offset += QQ_FORWARD_NODE_LIMIT) {
    batches.push(nodes.slice(offset, offset + QQ_FORWARD_NODE_LIMIT))
  }
  let sent = 0
  for (const batch of batches) {
    // Await each receipt so records retain their original ordering.
    const payload = await makeForward(batch)
    const receipt = await send(payload)
    if (receipt === false || receipt?.status === 'failed' || (receipt?.retcode != null && Number(receipt.retcode) !== 0)) {
      throw new Error(`聊天记录第 ${sent + 1}/${batches.length} 份发送失败；已发送 ${sent} 份`)
    }
    sent++
    onProgress(sent, batches.length)
  }
  return sent
}
