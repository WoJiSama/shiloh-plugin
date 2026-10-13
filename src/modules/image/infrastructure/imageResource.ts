import { readImageDimensions } from '../domain/imageDimensions.js';
export interface ImageBytes { buffer: Buffer; mime: string }
export interface ImageResourceOptions { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number }
export function sniffImageMime(buffer: Uint8Array): string {
  const bytes = Buffer.from(buffer);
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'application/octet-stream';
}
export function createImageResource(options: ImageResourceOptions = {}) {
  const fetchImage = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const validate = (buffer: Buffer): ImageBytes => {
    if (!buffer.length) throw new Error('上游返回的图片数据为空');
    if (buffer.length > maxBytes || !readImageDimensions(buffer)) throw new Error('上游返回的图片无效或超过大小上限');
    return { buffer, mime: sniffImageMime(buffer) };
  };
  return async function materializeImageResult(image: string | Uint8Array, externalSignal?: AbortSignal): Promise<ImageBytes> {
    if (externalSignal?.aborted) throw new Error('已取消');
    if (image instanceof Uint8Array) return validate(Buffer.from(image));
    const base64 = image.startsWith('base64://') ? image.slice(9) : image.match(/^data:image\/[^;,]+;base64,(.+)$/)?.[1];
    if (base64 !== undefined) {
      if (base64.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error('上游返回的图片超过大小上限');
      return validate(Buffer.from(base64, 'base64'));
    }
    if (!/^https?:\/\//i.test(image)) throw new Error(`未知图片结果格式: ${image.slice(0, 60)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    try {
      const response = await fetchImage(image, { signal: controller.signal });
      if (!response.ok) throw new Error(`成图 URL 拉取失败: ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error('成图 URL 返回空内容');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) { controller.abort(); await reader.cancel(); throw new Error('成图超过大小上限'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      if (externalSignal?.aborted) throw new Error('已取消');
      return validate(Buffer.concat(chunks));
    } catch (error: unknown) {
      if (externalSignal?.aborted) throw new Error('已取消');
      if (controller.signal.aborted) throw new Error(`成图 URL 拉取超过 ${Math.ceil(timeoutMs / 1000)} 秒或大小限制`);
      throw error;
    } finally {
      clearTimeout(timer); externalSignal?.removeEventListener('abort', onAbort);
    }
  };
}
