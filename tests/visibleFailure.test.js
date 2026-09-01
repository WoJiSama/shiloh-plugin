import test from "node:test"
import assert from "node:assert/strict"
import { appendVisibleFailureDetail, buildVisibleFailureDetail } from "../utils/visibleFailure.js"

test("shows actionable authentication and route failures", () => {
  assert.equal(
    buildVisibleFailureDetail('API 请求失败：401 Unauthorized - {"error":{"message":"invalid token"}}'),
    "401 Unauthorized（invalid token：当前渠道的授权无效或已失效）"
  )
  assert.match(
    buildVisibleFailureDetail('404 Not Found - {"error":{"message":"no route available for the requested model"}}'),
    /404 Not Found.*no route available/
  )
})

test("redacts credentials, signed query data, magnets, and local paths", () => {
  const detail = buildVisibleFailureDetail(
    '503 upstream error Bearer sk-secret-value https://example.test/file?token=abc&rkey=private magnet:?xt=urn:btih:abcdef /opt/trss-yunzai/config/message.yaml'
  )
  assert.match(detail, /503 上游服务异常/)
  assert.doesNotMatch(detail, /sk-secret-value|token=abc|rkey=private|urn:btih|\/opt\/trss-yunzai/)
  assert.match(appendVisibleFailureDetail("查询没有完成。", "request timeout"), /原因：请求超时/)
})

test("keeps actionable tool errors while removing transport secrets", () => {
  const detail = buildVisibleFailureDetail(
    'error: 工具 excelWorkbookTool 执行失败: 401 Unauthorized Bearer sk-real-secret https://example.test/data?x-signature=private'
  )
  assert.match(detail, /401 Unauthorized/)
  assert.doesNotMatch(detail, /sk-real-secret|x-signature=private/)
})

test("localizes statusless upstream overload responses", () => {
  const detail = buildVisibleFailureDetail("Our servers are currently overloaded. Please try again later.")
  assert.equal(detail, "上游服务当前负载过高，请稍后重试")
})
