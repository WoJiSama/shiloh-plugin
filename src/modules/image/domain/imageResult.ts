export function extractImageResult(content: unknown): string | null {
  const value = String(content || "").trim()
  if (!value) return null
  if (/^base64:\/\/[A-Za-z0-9+/=]+$/.test(value)) return value
  if (/^https?:\/\/\S+$/i.test(value)) return value

  const markdownMatch = value.match(/!\[.*?\]\((data:image\/[^;]+;base64,[^)]+|https?:\/\/[^)]+)\)/)
  if (markdownMatch?.[1]) return normalizeImageResult(markdownMatch[1])

  const dataUriMatch = value.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/)
  if (dataUriMatch) return `base64://${dataUriMatch[1]}`

  const urlMatch = value.match(/https?:\/\/[^\s)'"<>]+\.(?:png|jpg|jpeg|gif|webp|bmp)(?:[^\s)'"<>]*)?/i)
  return urlMatch?.[0] || null
}

function normalizeImageResult(value: string) {
  if (value.startsWith("data:image")) {
    return `base64://${value.replace(/^data:image\/[^;]+;base64,/, "")}`
  }
  return value
}
