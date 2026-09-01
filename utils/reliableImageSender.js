import sharp from "sharp"

const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

export function isMessageSendFailed(result) {
  if (result === false) return true
  if (!result || typeof result !== "object") return false
  if (result.status === "failed") return true
  if (Number(result.retcode) && Number(result.retcode) !== 0) return true
  return Boolean(result.error)
}

export function formatMessageSendFailure(result) {
  if (!result || typeof result !== "object") return "消息发送失败"
  const error = result.error || result.message || result.wording || result.msg || ""
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 240)
  if (error?.message) return String(error.message).slice(0, 240)
  return `消息发送失败 retcode=${result.retcode ?? "unknown"}`
}

export async function resolveImageBuffer(image, options = {}) {
  if (Buffer.isBuffer(image)) return image
  const source = String(image || "").trim()
  if (!source) throw new Error("图片内容为空")

  const base64Match = source.match(/^(?:data:image\/[^;]+;base64,|base64:\/\/)([A-Za-z0-9+/=]+)$/)
  if (base64Match) {
    const buffer = Buffer.from(base64Match[1], "base64")
    if (!buffer.length) throw new Error("图片 base64 内容为空")
    return buffer
  }

  if (!/^https?:\/\//i.test(source)) throw new Error("不支持的图片来源")
  const controller = new AbortController()
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(source, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    })
    if (!response.ok) throw new Error(`图片下载失败: HTTP ${response.status}`)
    const contentType = String(response.headers.get("content-type") || "")
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`图片下载失败: 返回类型 ${contentType}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new Error("图片下载结果为空")
    const maxBytes = Number(options.maxBytes) || DEFAULT_MAX_BYTES
    if (buffer.length > maxBytes) throw new Error(`图片过大: ${buffer.length} bytes`)
    return buffer
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`图片下载超过 ${Math.round(timeoutMs / 1000)} 秒`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function getImageBufferMetadata(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null
  try {
    const metadata = await sharp(imageBuffer).metadata()
    const width = Number(metadata.width) || 0
    const height = Number(metadata.height) || 0
    if (!width || !height) return null
    return {
      width,
      height,
      format: String(metadata.format || ""),
      orientation: width === height ? "square" : (width < height ? "portrait" : "landscape")
    }
  } catch {
    return null
  }
}

export async function sendImageReliably(event, image, options = {}) {
  const imageBuffer = await resolveImageBuffer(image, options)
  const buildMessage = options.buildMessage || (buffer => [segment.image(buffer)])
  const result = await event.reply(buildMessage(imageBuffer))
  if (isMessageSendFailed(result)) throw new Error(formatMessageSendFailure(result))
  return result
}
