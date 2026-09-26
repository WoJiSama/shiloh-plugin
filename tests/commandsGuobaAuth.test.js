// 命令管理页的锅巴登录态互信:guoba_token 与锅巴 redis/JWT 同口径验证
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import jwt from "jsonwebtoken"

test("checkGuobaLoginToken: redis 命中且 JWT 验签通过 → 信任", async () => {
  const { checkGuobaLoginToken, resetGuobaJwtSecretCache } = await import("../utils/guobaLoginTrust.js")
  const secret = "s".repeat(32)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guoba-auth-"))
  const pluginRoot = path.join(dir, "shiloh-plugin")
  fs.mkdirSync(pluginRoot, { recursive: true })
  fs.mkdirSync(path.join(dir, "Guoba-Plugin", "config"), { recursive: true })
  fs.writeFileSync(path.join(dir, "Guoba-Plugin", "config", "application.yaml"),
    `jwt:\n  secret: "${secret}"\n`)
  const accessToken = jwt.sign({ username: 925640859 }, secret)
  const innerJwt = jwt.sign({ username: 925640859, iat: 1790437763 }, secret)
  const store = new Map([[`Yz:Guoba:access-token:${accessToken}`, innerJwt]])
  globalThis.redis = { get: async key => store.get(key) || null }
  resetGuobaJwtSecretCache()
  try {
    assert.equal(await checkGuobaLoginToken(accessToken, pluginRoot), true, "redis 命中+验签通过")
    assert.equal(await checkGuobaLoginToken(jwt.sign({ u: 1 }, "othersecret-othersecret-otherse"), pluginRoot), false, "redis 未命中拒绝")
    assert.equal(await checkGuobaLoginToken("", pluginRoot), false, "空令牌拒绝")
    assert.equal(await checkGuobaLoginToken("not-a-jwt", pluginRoot), false, "非 JWT 形态拒绝")
    // 错误 secret 签的 redis 值 → 验签失败拒绝
    const badInner = jwt.sign({ username: 1 }, "x".repeat(32))
    store.set(`Yz:Guoba:access-token:${jwt.sign({ u: 2 }, secret)}`, badInner)
    assert.equal(await checkGuobaLoginToken(jwt.sign({ u: 2 }, secret), pluginRoot), false, "redis 内容验签失败拒绝")
  } finally {
    delete globalThis.redis
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
