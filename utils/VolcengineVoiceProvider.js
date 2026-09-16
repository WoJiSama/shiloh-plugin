import { randomUUID } from "crypto"
import { writeTempVoiceFile } from "./qqVoiceAudio.js"

const DEFAULT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"

function compactObject(value) {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(compactObject)
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === "") continue
    result[key] = compactObject(item)
  }
  return result
}

function looksLikeBase64(value = "", minLength = 80) {
  const trimmed = String(value || "").trim()
  return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length >= minLength
}

function findBase64Audio(value, preferred = false) {
  if (!value) return ""
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (looksLikeBase64(trimmed, preferred ? 4 : 80)) return trimmed
    return ""
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBase64Audio(item, preferred)
      if (found) return found
    }
    return ""
  }
  if (typeof value !== "object") return ""

  for (const key of ["audio", "audio_data", "audioData"]) {
    const found = findBase64Audio(value[key], true)
    if (found) return found
  }
  if (Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, "data")) {
    const found = findBase64Audio(value.data, true)
    if (found) return found
  }
  for (const key of ["data", "payload"]) {
    const found = findBase64Audio(value[key], false)
    if (found) return found
  }
  for (const item of Object.values(value)) {
    const found = findBase64Audio(item, preferred)
    if (found) return found
  }
  return ""
}

export function parseVolcengineAudioPayload(rawBuffer, contentType = "") {
  if (!rawBuffer?.length) throw new Error("火山语音接口没有返回音频")
  if (/audio|octet-stream/i.test(contentType)) return rawBuffer

  const text = rawBuffer.toString("utf8").trim()
  const audioParts = []
  const candidates = text
    .split(/\r?\n/)
    .map(line => line.replace(/^data:\s*/i, "").trim())
    .filter(Boolean)

  if (!candidates.length && text) candidates.push(text)

  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate)
      const audio = findBase64Audio(json)
      if (audio) audioParts.push(Buffer.from(audio, "base64"))
    } catch {
      if (looksLikeBase64(candidate, 80)) {
        audioParts.push(Buffer.from(candidate, "base64"))
      }
    }
  }

  if (audioParts.length) return Buffer.concat(audioParts)
  throw new Error(`火山语音接口未返回可识别音频: ${text.slice(0, 160)}`)
}

export class VolcengineVoiceProvider {
  constructor(config = {}, options = {}) {
    this.config = config || {}
    this.fetch = options.fetch || globalThis.fetch
  }

  validateConfig() {
    const cfg = this.config
    const missing = []
    if (!cfg.appId) missing.push("appId")
    if (!cfg.accessToken) missing.push("accessToken")
    if (!cfg.resourceId) missing.push("resourceId")
    if (!cfg.voiceType) missing.push("voiceType")
    if (missing.length) throw new Error(`火山语音配置缺少: ${missing.join(", ")}`)
  }

  buildRequest({ text, style = {} } = {}) {
    this.validateConfig()
    const cfg = this.config
    const format = style.format || cfg.format || "mp3"
    const voiceType = style.voiceType || cfg.voiceType
    const requestId = randomUUID()
    const body = compactObject({
      user: {
        uid: cfg.uid || "shiloh-plugin"
      },
      req_params: {
        text,
        speaker: voiceType,
        audio_params: {
          format,
          sample_rate: Number(style.sampleRate || cfg.sampleRate) || 24000,
          speech_rate: style.speedRatio || cfg.speedRatio,
          pitch_rate: style.pitchRatio || cfg.pitchRatio,
          volume_ratio: style.volumeRatio || cfg.volumeRatio
        },
        additions: {
          emotion: style.emotion || cfg.emotion,
          style: style.prompt || cfg.stylePrompt
        }
      }
    })

    const headers = compactObject({
      "Content-Type": "application/json",
      "X-Api-App-Id": cfg.appId,
      "X-Api-Access-Key": cfg.accessToken,
      "X-Api-Resource-Id": style.resourceId || cfg.resourceId,
      "X-Api-Connect-Id": requestId,
      Authorization: cfg.authorization ? `Bearer ${cfg.authorization}` : undefined
    })

    return {
      endpoint: cfg.endpoint || DEFAULT_ENDPOINT,
      requestId,
      format,
      body,
      headers
    }
  }

  async synthesizeToBuffer({ text, style = {} } = {}) {
    const request = this.buildRequest({ text, style })
    if (typeof this.fetch !== "function") {
      throw new Error("当前 Node 环境不支持 fetch，无法请求火山语音接口")
    }
    const response = await this.fetch(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body)
    })
    const arrayBuffer = await response.arrayBuffer()
    const rawBuffer = Buffer.from(arrayBuffer)
    if (!response.ok) {
      throw new Error(`火山语音请求失败 ${response.status}: ${rawBuffer.toString("utf8").slice(0, 200)}`)
    }
    return {
      buffer: parseVolcengineAudioPayload(rawBuffer, response.headers.get("content-type") || ""),
      format: request.format,
      requestId: request.requestId
    }
  }

  async synthesizeToFile({ text, style = {} } = {}) {
    const result = await this.synthesizeToBuffer({ text, style })
    const filePath = await writeTempVoiceFile(result.buffer, result.format)
    return { ...result, filePath }
  }

  async *synthesizeStream() {
    throw new Error("阶段三预留: synthesizeStream 尚未接入实时通话链路")
  }
}
