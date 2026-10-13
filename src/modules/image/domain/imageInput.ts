export function normalizeCustomSize(value: unknown = ''): string {
  const size = String(value || '').trim().replace(/[×*]/g, 'x').replace(/\s+/g, '');
  if (!size) return '';
  if (/^[1-9]\d{0,4}x[1-9]\d{0,4}$/i.test(size)) return size.toLowerCase();
  if (/^auto$/i.test(size)) return 'auto';
  if (/^[1-9]\d*(?:\.\d+)?k$/i.test(size)) return size.replace(/k$/i, 'K');
  throw new Error(`自定义尺寸格式无效: ${String(value)}(可填 1024x1536、2K、auto 等)`);
}
export function normalizeQuality(value: unknown = ''): string {
  const quality = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(quality) ? quality : '';
}
