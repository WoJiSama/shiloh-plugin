// 锅巴登录态互信:命令管理页等本插件管理页面信任锅巴(Guoba-Plugin)的
// accessToken。验证口径与锅巴 TokenInterceptor 一致——redis 存在
// Yz:Guoba:access-token:<token>,且其中 JWT 用锅巴配置的 secret 验签通过。
import fs from "fs"
import path from "path"
import jwt from "jsonwebtoken"
import YAML from "yaml"

const GUOBA_REDIS_PREFIX = "Yz:Guoba:"
let guobaJwtSecretCache = null

export function resetGuobaJwtSecretCache() {
  guobaJwtSecretCache = null
}

function readGuobaJwtSecret(pluginRoot = process.cwd()) {
  if (guobaJwtSecretCache) return guobaJwtSecretCache
  try {
    const yamlPath = path.join(String(pluginRoot || ""), "..", "Guoba-Plugin", "config", "application.yaml")
    const doc = YAML.parse(fs.readFileSync(yamlPath, "utf8"))
    const secret = String(doc?.jwt?.secret || "")
    if (secret.length === 32) guobaJwtSecretCache = secret
    return secret || ""
  } catch {
    return ""
  }
}

export async function checkGuobaLoginToken(provided, pluginRoot = process.cwd()) {
  const token = String(provided || "").trim()
  if (!token || !token.startsWith("eyJ")) return false
  const redis = globalThis.redis
  if (!redis?.get) return false
  let storedJwt = ""
  try {
    storedJwt = await redis.get(GUOBA_REDIS_PREFIX + "access-token:" + token) || ""
  } catch {
    return false
  }
  if (!storedJwt) return false
  const secret = readGuobaJwtSecret(pluginRoot)
  if (!secret) return true
  try {
    jwt.verify(storedJwt, secret)
    return true
  } catch {
    return false
  }
}
