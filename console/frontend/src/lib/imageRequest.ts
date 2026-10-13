// The server reads image requests with a 60 MiB JSON body ceiling.
export const IMAGE_BODY_LIMIT = 60 * 1024 * 1024
export function serializeImageRequest(payload: unknown): string {
  const body = JSON.stringify(payload)
  if (new TextEncoder().encode(body).byteLength > IMAGE_BODY_LIMIT) {
    throw new Error('参考图片编码后总大小超过 60 MB，请减少图片数量或压缩图片后重试')
  }
  return body
}
