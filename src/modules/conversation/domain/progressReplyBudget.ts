export function reserveProgressReply(event?: {_progressReplyState?: {sent?: boolean; reserved?: boolean}}) {
  const state = event?._progressReplyState
  if (!state) return { commit() {}, release() {} }
  if (state.sent || state.reserved) return null

  state.reserved = true
  let active = true
  return {
    commit() {
      if (!active) return
      active = false
      state.reserved = false
      state.sent = true
    },
    release() {
      if (!active) return
      active = false
      state.reserved = false
    }
  }
}
