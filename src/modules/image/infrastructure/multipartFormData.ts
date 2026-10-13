interface LegacyMultipart { getHeaders(): unknown; getBuffer(): unknown }
function isLegacyMultipart(value: unknown): value is LegacyMultipart {
  if (typeof value !== 'object' || value === null) return false
  return 'getHeaders' in value && typeof value.getHeaders === 'function' && 'getBuffer' in value && typeof value.getBuffer === 'function'
}
export async function serializeMultipartFormData(formData: unknown) {
  if (isLegacyMultipart(formData)) {
    const body = formData.getBuffer()
    if (!Buffer.isBuffer(body) || !body.length) throw new Error("multipart 请求体为空")
    const sourceHeaders = formData.getHeaders()
    if (!sourceHeaders || typeof sourceHeaders !== 'object') throw new Error("无法生成 multipart boundary")
    const headers = sourceHeaders as Record<string, unknown>
    const contentType = headers["content-type"] || headers["Content-Type"] || ""
    if (typeof contentType !== "string" || !/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
      throw new Error("无法生成 multipart boundary")
    }
    return {
      body,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length)
      }
    }
  }

  if (!(formData instanceof FormData)) throw new Error("无法生成 multipart boundary")
  const encoded = new Response(formData)
  const contentType = encoded.headers.get("content-type") || ""
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    throw new Error("无法生成 multipart boundary")
  }

  const body = Buffer.from(await encoded.arrayBuffer())
  if (!body.length) throw new Error("multipart 请求体为空")

  return {
    body,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(body.length)
    }
  }
}
