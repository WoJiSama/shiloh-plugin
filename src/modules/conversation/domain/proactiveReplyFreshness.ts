interface ProactiveEvent {_proactiveReply?:boolean;_proactiveReplyAnchorAt?:number}
export function markProactiveReply<T extends ProactiveEvent>(event:T, latestIncomingAt = Date.now()) {
  event._proactiveReply = true
  event._proactiveReplyAnchorAt = Math.max(0, Number(latestIncomingAt) || 0)
  return event
}

export function shouldCancelProactiveReply(event:ProactiveEvent = {}, latestIncomingAt = 0) {
  if (event?._proactiveReply !== true) return false
  const anchorAt = Math.max(0, Number(event?._proactiveReplyAnchorAt) || 0)
  const newestAt = Math.max(0, Number(latestIncomingAt) || 0)
  return anchorAt > 0 && newestAt > anchorAt
}
