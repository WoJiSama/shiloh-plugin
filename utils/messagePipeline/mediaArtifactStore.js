import fs from "node:fs"

const DEFAULT_TTL_MS = 2 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 8
const DEFAULT_MAX_IDLE_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_ENCODED_BYTES = 64 * 1024 * 1024

function once(fn) {
  let called = false
  return async () => {
    if (called) return
    called = true
    await fn()
  }
}

export class MediaArtifactStore {
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxIdleBytes = DEFAULT_MAX_IDLE_BYTES,
    maxEncodedBytes = DEFAULT_MAX_ENCODED_BYTES,
    logger = globalThis.logger
  } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0)
    this.maxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES)
    this.maxIdleBytes = Math.max(0, Number(maxIdleBytes) || 0)
    this.maxEncodedBytes = Math.max(0, Number(maxEncodedBytes) || 0)
    this.logger = logger
    this.entries = new Map()
    this.byPath = new Map()
  }

  async acquire(key, producer) {
    const artifactKey = String(key || "").trim()
    if (!artifactKey || typeof producer !== "function") return null

    let entry = this.entries.get(artifactKey)
    if (!entry) {
      entry = {
        key: artifactKey,
        promise: null,
        filePath: "",
        size: 0,
        refs: 0,
        lastAccessAt: Date.now(),
        cleanupTimer: null,
        base64Promise: null
      }
      entry.promise = Promise.resolve()
        .then(producer)
        .then(async filePath => {
          if (!filePath) return null
          const stat = await fs.promises.stat(filePath)
          if (!stat.isFile() || stat.size <= 0) return null
          entry.filePath = String(filePath)
          entry.size = Number(stat.size || 0)
          entry.lastAccessAt = Date.now()
          this.byPath.set(entry.filePath, entry)
          return entry.filePath
        })
        .catch(async error => {
          await this.removeEntry(entry, { unlink: true })
          throw error
        })
      this.entries.set(artifactKey, entry)
    }

    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer)
      entry.cleanupTimer = null
    }
    entry.refs += 1
    entry.lastAccessAt = Date.now()

    try {
      const filePath = await entry.promise
      if (!filePath) {
        await this.releaseEntry(entry, { immediate: true })
        return null
      }
      return {
        key: artifactKey,
        filePath,
        shared: entry.refs > 1,
        release: once(() => this.releaseEntry(entry))
      }
    } catch (error) {
      entry.refs = Math.max(0, entry.refs - 1)
      throw error
    }
  }

  async encodeFile(filePath) {
    const normalized = String(filePath || "")
    const entry = this.byPath.get(normalized)
    if (!entry || entry.size > this.maxEncodedBytes) {
      return `base64://${(await fs.promises.readFile(normalized)).toString("base64")}`
    }
    entry.lastAccessAt = Date.now()
    entry.base64Promise ||= fs.promises.readFile(normalized)
      .then(buffer => `base64://${buffer.toString("base64")}`)
      .catch(error => {
        entry.base64Promise = null
        throw error
      })
    return await entry.base64Promise
  }

  async releaseEntry(entry, { immediate = false } = {}) {
    if (!entry) return
    entry.refs = Math.max(0, entry.refs - 1)
    entry.lastAccessAt = Date.now()
    if (entry.refs > 0) return
    if (immediate || this.ttlMs <= 0) {
      await this.removeEntry(entry, { unlink: true })
      return
    }
    entry.cleanupTimer = setTimeout(() => {
      this.removeEntry(entry, { unlink: true }).catch(error => {
        this.logger?.warn?.(`[MediaArtifactStore] 清理共享媒体失败: ${error.message}`)
      })
    }, this.ttlMs)
    entry.cleanupTimer.unref?.()
    await this.pruneIdleEntries()
  }

  async pruneIdleEntries() {
    const idle = [...this.entries.values()]
      .filter(entry => entry.refs === 0 && entry.filePath)
      .sort((left, right) => left.lastAccessAt - right.lastAccessAt)
    let idleBytes = idle.reduce((total, entry) => total + Number(entry.size || 0), 0)
    let totalEntries = this.entries.size
    for (const entry of idle) {
      if (totalEntries <= this.maxEntries && idleBytes <= this.maxIdleBytes) break
      await this.removeEntry(entry, { unlink: true })
      idleBytes -= Number(entry.size || 0)
      totalEntries -= 1
    }
  }

  async removeEntry(entry, { unlink = false } = {}) {
    if (!entry || this.entries.get(entry.key) !== entry) return
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    this.entries.delete(entry.key)
    if (entry.filePath) this.byPath.delete(entry.filePath)
    if (unlink && entry.filePath) await fs.promises.unlink(entry.filePath).catch(() => {})
    entry.base64Promise = null
  }

  async stop() {
    const idleEntries = [...this.entries.values()].filter(entry => entry.refs === 0)
    await Promise.all(idleEntries.map(entry => this.removeEntry(entry, { unlink: true })))
  }
}

export function buildMediaArtifactKey(platform, identity = {}) {
  const type = String(platform || "media").toLowerCase()
  if (type === "bilibili" || type === "bilibili-auth") {
    const bvid = String(identity.bvid || "").trim()
    const part = String(identity.cid || identity.page || 1)
    const quality = String(identity.quality || identity.qn || 6)
    return bvid ? `${type}:${bvid}:${part}:qn${quality}` : ""
  }
  if (type === "douyin") {
    const awemeId = String(identity.aweme_id || identity.awemeId || "").trim()
    return awemeId ? `douyin:${awemeId}:lowest` : ""
  }
  if (type === "youtube") {
    const videoId = String(identity.video_id || identity.videoId || "").trim()
    return videoId ? `youtube:${videoId}:lowest-mp4` : ""
  }
  if (type === "pixiv") {
    const artworkId = String(identity.artwork_id || identity.artworkId || "").trim()
    const page = Number(identity.page || 0)
    return artworkId && Number.isInteger(page) && page >= 0 ? `pixiv:${artworkId}:p${page}:regular` : ""
  }
  return ""
}
