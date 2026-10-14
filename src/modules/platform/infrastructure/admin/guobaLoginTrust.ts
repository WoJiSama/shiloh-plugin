const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'?value as Record<string,unknown>:{}
// 锅巴登录态互信:命令管理页等本插件管理页面信任锅巴(Guoba-Plugin)的
// accessToken。验证口径与锅巴 TokenInterceptor 一致——redis 存在
// Yz:Guoba:access-token:<token>,且其中 JWT 用锅巴配置的 secret 验签通过。
import fs from "fs"
import path from "path"

import YAML from "yaml"

const GUOBA_REDIS_PREFIX = "Yz:Guoba:"
const guobaJwtSecretCache=new Map<string,string>()

export function resetGuobaJwtSecretCache() {
  guobaJwtSecretCache.clear()
}

function readGuobaJwtSecret(pluginRoot = process.cwd()) {
  const cacheKey=path.resolve(pluginRoot)
  const cached=guobaJwtSecretCache.get(cacheKey)
  if (cached) return cached
  try {
    const yamlPath = path.join(String(pluginRoot || ""), "..", "Guoba-Plugin", "config", "application.yaml")
    const doc:unknown = YAML.parse(fs.readFileSync(yamlPath, "utf8"))
    const secret = String(record(record(doc).jwt).secret || "")
    if (secret.length === 32) guobaJwtSecretCache.set(cacheKey,secret)
    return secret || ""
  } catch {
    return ""
  }
}

export function createGuobaLoginTrust(getRedis:()=>{get(key:string):Promise<unknown>}|null,verifyJwt:(token:string,secret:string)=>unknown){
async function checkGuobaLoginToken(provided:unknown, pluginRoot = process.cwd()) {
  const token = String(provided || "").trim()
  if (!token || !token.startsWith("eyJ")) return false
  const redis = getRedis()
  if (!redis?.get) return false
  let storedJwt = ""
  try {
    const value=await redis.get(GUOBA_REDIS_PREFIX + "access-token:" + token)
    storedJwt=typeof value==='string'?value:''
  } catch {
    return false
  }
  if (!storedJwt) return false
  const secret = readGuobaJwtSecret(pluginRoot)
  if (!secret) return false
  try {
    verifyJwt(storedJwt, secret)
    return true
  } catch {
    return false
  }
}

return {checkGuobaLoginToken}
}
