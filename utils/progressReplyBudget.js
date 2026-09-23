export function reserveProgressReply(event) {
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
