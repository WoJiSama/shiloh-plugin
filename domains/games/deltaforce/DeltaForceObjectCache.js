import fs from "fs"
import path from "path"
import { unwrapApiData } from "./DeltaForceClient.js"

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000

function getDefaultCachePath() {
  const cwd = process.cwd()
  const looksLikePluginRoot =
    path.basename(cwd) === "bl-chat-plugin" &&
    fs.existsSync(path.join(cwd, "config_default")) &&
    fs.existsSync(path.join(cwd, "apps"))
  const pluginRoot = looksLikePluginRoot ? cwd : path.join(cwd, "plugins/bl-chat-plugin")
  return path.join(pluginRoot, "database/delta-force-objects.json")
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function pickFirst(item, keys) {
  for (const key of keys) {
    if (item?.[key] !== undefined && item?.[key] !== null && item?.[key] !== "") return item[key]
  }
  return ""
}

function findArrayDeep(value, depth = 0) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object" || depth > 3) return []

  for (const key of ["list", "items", "objects", "data", "records", "rows"]) {
    const found = findArrayDeep(value[key], depth + 1)
    if (found.length) return found
  }

  for (const child of Object.values(value)) {
    const found = findArrayDeep(child, depth + 1)
    if (found.length) return found
  }
  return []
}

export function normalizeDeltaForceObjects(body) {
  const data = unwrapApiData(body)
  const list = findArrayDeep(data)
  const objects = []

  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const objectID = pickFirst(item, ["objectID", "objectId", "id", "object_id", "itemID", "itemId"])
    const objectName = pickFirst(item, ["objectName", "name", "itemName", "object_name", "cnName", "displayName"])
    if (objectID === "" || objectName === "") continue
    objects.push({
      objectID: String(objectID),
      objectName: String(objectName),
      raw: item
    })
  }

  return objects
}

export class DeltaForceObjectCache {
  constructor({ cachePath, ttlMs = DEFAULT_CACHE_TTL_MS, logger = globalThis.logger } = {}) {
    this.cachePath = cachePath || getDefaultCachePath()
    this.ttlMs = ttlMs
    this.logger = logger
    this.objects = new Map()
    this.updatedAt = 0
    this.refreshing = null
    this.timer = null
    this.loadFromDisk()
  }

  loadFromDisk() {
    try {
      if (!fs.existsSync(this.cachePath)) return
      const payload = JSON.parse(fs.readFileSync(this.cachePath, "utf8"))
      this.updatedAt = Number(payload.updatedAt) || 0
      this.replaceObjects(payload.objects || [])
    } catch (err) {
      this.logger?.warn?.(`[三角洲物品缓存] 读取本地缓存失败: ${err.message}`)
    }
  }

  saveToDisk() {
    try {
      ensureDir(this.cachePath)
      fs.writeFileSync(this.cachePath, JSON.stringify({
        updatedAt: this.updatedAt,
        objects: [...this.objects.values()]
      }, null, 2), "utf8")
    } catch (err) {
      this.logger?.warn?.(`[三角洲物品缓存] 写入本地缓存失败: ${err.message}`)
    }
  }

  replaceObjects(objects) {
    const next = new Map()
    for (const item of objects || []) {
      if (!item?.objectID || !item?.objectName) continue
      next.set(String(item.objectID), {
        objectID: String(item.objectID),
        objectName: String(item.objectName),
        raw: item.raw || item
      })
    }
    this.objects = next
  }

  isStale() {
    return !this.updatedAt || Date.now() - this.updatedAt > this.ttlMs
  }

  getName(objectID) {
    if (objectID === undefined || objectID === null || objectID === "") return ""
    return this.objects.get(String(objectID))?.objectName || ""
  }

  get size() {
    return this.objects.size
  }

  getStatusText() {
    const updated = this.updatedAt ? new Date(this.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "未更新"
    const stale = this.isStale() ? "可能已过期" : "正常"
    return `三角洲物品缓存\n数量：${this.size}\n状态：${stale}\n更新时间：${updated}`
  }

  async refresh(client, { force = false } = {}) {
    if (!force && !this.isStale() && this.size > 0) return { refreshed: false, size: this.size }
    if (this.refreshing) return this.refreshing

    this.refreshing = (async () => {
      const body = typeof client.getAllObjectList === "function"
        ? await client.getAllObjectList()
        : await client.getObjectList()
      const objects = normalizeDeltaForceObjects(body)
      if (!objects.length) throw new Error("物品列表为空或结构无法识别")
      this.replaceObjects(objects)
      this.updatedAt = Date.now()
      this.saveToDisk()
      this.logger?.mark?.(`[三角洲物品缓存] 已更新 ${this.size} 个物品`)
      return { refreshed: true, size: this.size }
    })().finally(() => {
      this.refreshing = null
    })

    return this.refreshing
  }

  startAutoRefresh(client, refreshMinutes = 360) {
    const intervalMs = Math.max(10, Math.min(Number(refreshMinutes) || 360, 1440)) * 60 * 1000
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      this.refresh(client, { force: true }).catch(err => {
        this.logger?.warn?.(`[三角洲物品缓存] 定时更新失败: ${err.message}`)
      })
    }, intervalMs)
    this.timer.unref?.()
  }
}
