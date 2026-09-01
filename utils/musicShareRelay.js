import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

const MAX_AUDIO_BYTES = 20 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 60_000
const TEMP_DIR = path.join(os.tmpdir(), "bl-chat-plugin-music-share")

function decodeEntities(value = "") {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
}

function parseJson(value) {
  if (value && typeof value === "object") return value
  const text = decodeEntities(value).trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\[CQ:json,data=([\s\S]*)\]$/)
    if (!match) return null
    try {
      return JSON.parse(match[1])
    } catch {
      return null
    }
  }
}

function walk(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return []
  seen.add(value)
  const result = [value]
  for (const item of Object.values(value)) result.push(...walk(item, seen))
  return result
}

function normalizeTitle(value = "") {
  return String(value || "音乐")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "音乐"
}

function officialMusicHost(value = "") {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === "music.163.com" || host.endsWith(".music.163.com") || host.endsWith(".music.126.net")
  } catch {
    return false
  }
}

function extractNeteasePageLink(value = "") {
  const match = decodeEntities(value).match(/https?:\/\/(?:y\.)?music\.163\.com\/[^\s，。！？；;）)\]}>]+/i)
  if (!match) return null
  try {
    const url = new URL(match[0])
    const id = url.searchParams.get("id")
    const type = url.pathname.endsWith("/dj") ? "dj" : url.pathname.endsWith("/song") ? "song" : ""
    return type && /^\d{1,20}$/.test(id || "") ? { type, id } : null
  } catch {
    return null
  }
}

async function requestNeteaseJson(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 10_000))
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    })
    if (!response?.ok) throw new Error(`网易云接口返回 ${response?.status || "未知状态"}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function artistName(song = {}, fallback = "未知艺术家") {
  const artists = song.artists || song.ar || []
  const names = Array.isArray(artists) ? artists.map(item => item?.name).filter(Boolean) : []
  return normalizeTitle(names.join("/") || fallback)
}

export function extractNeteaseMusicShare(message = {}) {
  const segments = Array.isArray(message?.message) ? message.message : Array.isArray(message) ? message : []
  const candidates = [
    message,
    ...segments.map(segment => segment?.data ?? segment),
    message?.raw_message,
    message?.msg
  ].map(parseJson).filter(Boolean)

  for (const payload of candidates) {
    const music = walk(payload).find(item => item?.musicUrl && String(item?.tag || "").includes("网易云"))
      || walk(payload).find(item => item?.musicUrl && officialMusicHost(decodeEntities(item.musicUrl)))
    if (!music) continue
    const url = decodeEntities(music.musicUrl)
    if (!officialMusicHost(url)) continue
    return {
      title: normalizeTitle(music.title),
      artist: normalizeTitle(music.desc || "未知艺术家"),
      sourceUrl: url
    }
  }
  return null
}

export async function resolveNeteaseTextShare(value = "", { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const link = extractNeteasePageLink(value)
  if (!link) return null
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有可用的网易云解析能力")

  if (link.type === "dj") {
    const payload = await requestNeteaseJson(`https://music.163.com/api/dj/program/detail?id=${link.id}`, { fetchImpl, timeoutMs })
    const program = payload?.program
    const song = program?.mainSong
    if (Number(payload?.code) !== 200 || !/^\d{1,20}$/.test(String(song?.id || ""))) throw new Error("网易云电台节目没有可播放的主音频")
    return {
      title: normalizeTitle(song.name || program.name),
      artist: artistName(song, program?.dj?.nickname || "未知艺术家"),
      sourceUrl: `https://music.163.com/song/media/outer/url?id=${song.id}`
    }
  }

  const payload = await requestNeteaseJson(`https://music.163.com/api/song/detail/?ids=[${link.id}]`, { fetchImpl, timeoutMs })
  const song = payload?.songs?.[0]
  if (Number(payload?.code) !== 200 || !song?.id) throw new Error("网易云歌曲详情不可用")
  return {
    title: normalizeTitle(song.name),
    artist: artistName(song),
    sourceUrl: `https://music.163.com/song/media/outer/url?id=${song.id}`
  }
}

export async function downloadOfficialMusicShare(share, {
  fetchImpl = globalThis.fetch,
  tempDir = TEMP_DIR,
  maxBytes = MAX_AUDIO_BYTES,
  timeoutMs = DOWNLOAD_TIMEOUT_MS
} = {}) {
  if (!share?.sourceUrl || !officialMusicHost(share.sourceUrl)) throw new Error("不是可下载的网易云音乐官方播放地址")
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有可用的下载能力")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || DOWNLOAD_TIMEOUT_MS))
  try {
    const response = await fetchImpl(share.sourceUrl, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    })
    if (!response?.ok) throw new Error(`音乐源返回 ${response?.status || "未知状态"}`)
    if (!officialMusicHost(response.url || share.sourceUrl)) throw new Error("音乐重定向到了非官方地址")
    if (!/^audio\//i.test(response.headers?.get?.("content-type") || "")) throw new Error("音乐源没有返回音频内容")
    const declaredSize = Number(response.headers?.get?.("content-length") || 0)
    if (declaredSize > maxBytes) throw new Error("音乐文件超过20MB限制")
    if (!response.body) throw new Error("音乐源没有返回文件内容")

    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > maxBytes) throw new Error("音乐文件超过20MB限制")
      chunks.push(buffer)
    }
    if (!size) throw new Error("音乐文件为空")

    await fs.mkdir(tempDir, { recursive: true })
    const fileName = `${normalizeTitle(share.title)}-${normalizeTitle(share.artist)}-${randomUUID()}.mp3`
    const filePath = path.join(tempDir, fileName)
    await fs.writeFile(filePath, Buffer.concat(chunks))
    return { filePath, fileName, size }
  } finally {
    clearTimeout(timer)
  }
}

export function scheduleMusicShareCleanup(filePath, delayMs = 10 * 60 * 1000) {
  if (!filePath) return
  setTimeout(() => fs.unlink(filePath).catch(() => {}), Math.max(1_000, Number(delayMs) || 10 * 60 * 1000)).unref?.()
}
