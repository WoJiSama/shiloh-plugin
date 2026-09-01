import assert from "node:assert/strict"
import { test } from "node:test"
import { armSmartLockWatchdog, clearSmartLockWatchdog, isLongRunningTaskLinkRequest } from "../utils/smartLockPolicy.js"

function freshState(token = 1) {
  return {
    inFlight: true,
    inFlightToken: token,
    inFlightSince: Date.now() - 1000,
    inFlightWatchdog: null,
    queuedWhileInFlight: 2,
    needsRerun: true
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test("持锁超过时限且 token 未变时强制释放", async () => {
  const state = freshState()
  let releasedToken = null
  armSmartLockWatchdog(state, {
    timeoutMs: 20,
    onForceRelease: token => { releasedToken = token }
  })
  await delay(60)
  assert.equal(releasedToken, 1)
  assert.equal(state.inFlightWatchdog, null)
})

test("正常释放（清掉看门狗）后不触发强制释放", async () => {
  const state = freshState()
  let fired = false
  armSmartLockWatchdog(state, {
    timeoutMs: 20,
    onForceRelease: () => { fired = true }
  })
  clearSmartLockWatchdog(state)
  await delay(60)
  assert.equal(fired, false)
})

test("看门狗触发前锁已轮转给新轮次时不误杀新轮次", async () => {
  const state = freshState(1)
  let fired = false
  armSmartLockWatchdog(state, {
    timeoutMs: 20,
    onForceRelease: () => { fired = true }
  })
  // 旧轮次超时前，新轮次已经接管（token=2）
  state.inFlightToken = 2
  state.inFlightSince = Date.now()
  await delay(60)
  assert.equal(fired, false)
})

test("timeoutMs=0 时布防即空操作（看门狗关闭）", async () => {
  const state = freshState()
  let fired = false
  armSmartLockWatchdog(state, {
    timeoutMs: 0,
    onForceRelease: () => { fired = true }
  })
  assert.equal(state.inFlightWatchdog, null)
  await delay(30)
  assert.equal(fired, false)
})

test("重复布防会替换旧看门狗", async () => {
  const state = freshState()
  let fired = 0
  armSmartLockWatchdog(state, { timeoutMs: 15, onForceRelease: () => { fired++ } })
  armSmartLockWatchdog(state, { timeoutMs: 60, onForceRelease: () => { fired++ } })
  await delay(30)
  assert.equal(fired, 0, "第一个短定时器应已被清除")
  await delay(80)
  assert.equal(fired, 1)
})

test("isLongRunningTaskLinkRequest 识别磁链与视频链接", () => {
  assert.equal(isLongRunningTaskLinkRequest("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=test"), true)
  assert.equal(isLongRunningTaskLinkRequest("https://b23.tv/abcd123 解析一下"), true)
  assert.equal(isLongRunningTaskLinkRequest("https://www.bilibili.com/video/BV1xx411c7mD 看看这个"), true)
  assert.equal(isLongRunningTaskLinkRequest("https://www.douyin.com/video/71234567890123456789"), true)
  assert.equal(isLongRunningTaskLinkRequest("https://v.douyin.com/iRNBho5/ 帮我看看"), true)
  assert.equal(isLongRunningTaskLinkRequest("今天天气不错"), false)
  assert.equal(isLongRunningTaskLinkRequest(""), false)
  assert.equal(isLongRunningTaskLinkRequest("https://www.bilibili.com/audio/au123"), false)
})
