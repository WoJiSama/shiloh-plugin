import path from "node:path"

export interface MediaSegment {type?: unknown;name?:unknown;file_name?:unknown;file?:unknown;url?:unknown;file_url?:unknown;data?:Record<string,unknown>}

const IMAGE_EXTENSIONS = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".avif"])

export function getMessageFileName(segment: MediaSegment = {}) {
  const data = segment?.data && typeof segment.data === "object" ? segment.data : {}
  return String(
    segment.name || data.name || segment.file_name || data.file_name || segment.file || data.file || ""
  ).trim()
}
function extensionFromUrl(value: unknown = "") {
  try {
    const url = new URL(String(value || ""))
    const queryName = url.searchParams.get("fname") || url.searchParams.get("filename") || url.searchParams.get("name") || ""
    return path.extname(queryName || url.pathname).toLowerCase()
  } catch {
    return ""
  }
}

export function classifyMessageSegmentMedia(segment: MediaSegment = {}) {
  const type = String(segment?.type || "").toLowerCase()
  if (type === "image") return "image"
  if (type !== "file") return "other"
  const data = segment?.data && typeof segment.data === "object" ? segment.data : {}
  const fileName = getMessageFileName(segment)
  const extension = path.extname(fileName).toLowerCase() || extensionFromUrl(segment.url || data.url || segment.file_url || data.file_url)
  if (!extension) return "unknown_file"
  return IMAGE_EXTENSIONS.has(extension) ? "image_file" : "non_image_file"
}
