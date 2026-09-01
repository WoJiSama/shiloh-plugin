import { test } from "node:test"
import assert from "node:assert/strict"
import { containsInternalStatusLeak } from "../utils/internalStatusLeak.js"

test("keeps ordinary technical explanations out of the internal-status fallback", () => {
  assert.equal(containsInternalStatusLeak("这个 API 地址少了 /v1，服务端会把请求打到错误路由，所以才超时。"), false)
  assert.equal(containsInternalStatusLeak("Redis 连不上先看网络、密码和数据库编号。"), false)
  assert.equal(containsInternalStatusLeak("图片渠道授权没有通过，所以这次没读到图里的内容。"), false)
})

test("blocks only raw tool protocol and execution narration", () => {
  assert.equal(containsInternalStatusLeak("googleImageAnalysisTool 返回 HTTP 503"), true)
  assert.equal(containsInternalStatusLeak("我刚才调用工具以后拿到了结果"), true)
  assert.equal(containsInternalStatusLeak("[tool_code] searchInformationTool(...)"), true)
})
