import type { ImageServicePorts, ImageServiceCandidate, ImageServiceRequest, ImageValue } from '../../../contracts/imageService.js'
import { executeImageCandidates } from './executeCandidates.js'
import { shouldRetryWithoutUrlResponseFormat, describeImageGenerationConfig } from '../domain/providerConfig.js'
import { isGrokImageModel, assertGrokImageRatio } from '../domain/imageAspectRatio.js'
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function first(value: unknown): unknown { return Array.isArray(value) ? value[0] : undefined }
export function isImagesEditEndpoint(apiUrl = '') {
 const url = String(apiUrl || '').trim()
 if (!url || /\/chat\/completions\/?$/i.test(url)) return false
 return /(?:\/images\/edits\/?|\/v1\/?|\/openai\/v1\/?|\/api\/v1\/?|\/)$/.test(url)
}
export function createImageService(ports: ImageServicePorts) {
 function buildGenerationPayload(config: ImageServiceCandidate, prompt: string, format = '', count = 1, quality = '') {
  const payload: Record<string, unknown> = { model: config.model, prompt }
  if (isGrokImageModel(config.model)) { payload.quality = quality || config.quality || 'high'; if (count > 1) payload.n = count }
  else { payload.n = count; if (format) payload.response_format = format; if (quality && /^gpt-image/i.test(config.model)) payload.quality = quality }
  if (config.size) payload.size = config.size
  if (config.aspectRatio && isGrokImageModel(config.model)) payload.aspect_ratio = config.aspectRatio
  return payload
 }
 async function timedFetch(url: string, options: RequestInit, timeoutMs = 120000): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
   const response = await ports.fetch(url, { ...options, signal })
   // Consume body under the deadline; provider headers alone must not end timeout coverage.
   const text = await response.text()
   return new Response([204,205,304].includes(response.status) ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch (error) {
   if (options.signal?.aborted) throw options.signal.reason
   if (timeout.aborted) throw new Error(`图片接口超过 ${Math.ceil(timeoutMs / 1000)} 秒没有返回完整响应`)
   throw error
  }
 }
 async function parseResponse(response: Response) {
  const text = await response.text()
  let data: Record<string, unknown>
  try { data = record(JSON.parse(text)) } catch { data = { raw: text } }
  if (!response.ok) return { ok: false as const, errorMessage: `API请求失败: ${response.status} ${record(data.error).message || data.detail || data.raw || response.statusText || '未知错误'}` }
  const images: ImageValue[] = []
  let format = ''
  for (const item of Array.isArray(data.data) ? data.data : []) {
   const entry = record(item)
   if (typeof entry.url === 'string' && entry.url) { images.push(entry.url); format ||= 'url' }
   else if (typeof entry.b64_json === 'string' && entry.b64_json) { images.push(`base64://${entry.b64_json}`); format ||= 'b64_json' }
  }
  if (images.length) return { ok: true as const, images, image: images[0]!, format }
  const entry = record(first(data.data))
  const detail = Object.keys(data).length ? `未接收到有效图片，上游返回字段: top=[${Object.keys(data).join(',')}] data0=[${Object.keys(entry).join(',') || '无'}]${data.error ? ` error=${JSON.stringify(data.error).slice(0,240)}` : ''}${entry.revised_prompt ? ` revised_prompt=${String(entry.revised_prompt).slice(0,180)}` : ''}` : '未接收到有效图片'
  return { ok: false as const, errorMessage: detail }
 }
 async function buildEdit(config: ImageServiceCandidate, prompt: string, images: readonly string[], format = '', count = 1, quality = '', signal?: AbortSignal) {
  const fields: Record<string,string> = { model: config.model || 'gpt-image-2', prompt, n: String(count) }
  if (config.size) fields.size = config.size
  if (quality && (isGrokImageModel(config.model) || /^gpt-image/i.test(config.model))) fields.quality = quality
  if (config.aspectRatio && isGrokImageModel(config.model)) fields.aspect_ratio = config.aspectRatio
  if (format) fields.response_format = format
  const files = []
  for (const url of images) {
   if (!url) continue
   signal?.throwIfAborted()
   const data = await ports.loadReference(url, signal)
   signal?.throwIfAborted()
   const match = data.match(/^data:([^;,]+);base64,([\s\S]+)$/)
   if (!match) throw new Error(/无效|过期/.test(data) ? data : '参考图片转换失败')
   const bytes = Uint8Array.from(atob(match[2]!), value => value.charCodeAt(0))
   files.push({ data: bytes, mimeType: match[1]!, filename: `reference-${files.length+1}.${match[1]!.split('/')[1] || 'png'}` })
  }
  if (!files.length) throw new Error('没有可用的参考图片')
  return ports.encodeMultipart(fields, files)
 }
 async function requestGeneration(config: ImageServiceCandidate, prompt: string, format = '', options: Omit<ImageServiceRequest,'operation'|'prompt'> = {}) {
  return timedFetch(config.apiUrl, { method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${config.apiKey}`}, body:JSON.stringify(buildGenerationPayload(config,prompt,format,options.count,options.quality)), ...(options.signal ? { signal:options.signal } : {}) })
 }
 async function requestEdit(config: ImageServiceCandidate, prompt: string, images: readonly string[], format = '', options: Omit<ImageServiceRequest,'operation'|'prompt'> = {}) {
  const multipart = await buildEdit(config,prompt,images,format,options.count,options.quality,options.signal)
  return timedFetch(config.apiUrl, { method:'POST', headers:{...multipart.headers, Authorization:`Bearer ${config.apiKey || 'sk-xxxxxx'}`}, body: multipart.body, ...(options.signal ? { signal:options.signal } : {}) })
 }
 async function run(configs: readonly ImageServiceCandidate[], request: ImageServiceRequest) {
  const result = await executeImageCandidates<ImageServiceCandidate, { images: ImageValue[]; format: string }>(configs, {
   describe: describeImageGenerationConfig,
   identity: config => ({ providerId:config.providerId || config.name || '', model:config.model }),
   async request(config,format) {
    const response = request.operation === 'edit' ? await requestEdit(config,request.prompt,request.images || [],format,request) : await requestGeneration(config,request.prompt,format,request)
    const parsed = await parseResponse(response)
    if (!parsed.ok) return parsed
    parsed.images = await Promise.all(parsed.images.map(async image => {
     const bytes = await ports.resolveImage(image, request.signal)
     const dimensions = await ports.metadata(bytes)
     if (![dimensions.width,dimensions.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('图片尺寸无效')
     if (config.aspectRatio && isGrokImageModel(config.model)) assertGrokImageRatio(config,dimensions)
     return bytes
    }))
    return { ok:true as const, value:{ images:parsed.images, format:parsed.format } }
   },
   retryWithoutFormat:shouldRetryWithoutUrlResponseFormat,
   failureMessage:attempts => `所有候选渠道都失败了：${attempts.map(item=>`${item.provider}: ${item.error}`).join('；')}`,
   now:()=>Date.now(), ...(request.signal ? {signal:request.signal}:{}),
   onCandidateFailure:(attempt,hasNext)=>{ if(hasNext)ports.logWarn?.(`[图片生成] ${attempt.provider} 失败: ${attempt.error}`) }
  })
  return {...result.value,provider:result.provider,attempts:result.attempts}
 }
 async function chat(config: { apiUrl?:string; apiKey?:string; model?:string },prompt:string,images:readonly string[],signal?:AbortSignal) {
  const content:unknown[] = [{type:'text',text:'你必须至少生成一张高质量的图片:'+prompt}]
  for(const url of images) { if(url) { const data=await ports.loadReference(url,signal); if(!data.startsWith('data:image/'))throw new Error('参考图片转换失败'); content.push({type:'image_url',image_url:{url:data}}) } }
  const response=await timedFetch(config.apiUrl || 'https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.apiKey || 'sk-xxxxxx'}`},body:JSON.stringify({model:config.model || 'gemini-3-pro-image-preview',messages:[{role:'user',content}],stream:false}),...(signal?{signal}:{})})
  const data=record(await response.json()); if(!response.ok)throw new Error(`API请求失败: ${response.status} ${record(data.error).message || response.statusText}`)
  const message=record(record(first(data.choices)).message),image=record(first(message.images))
  return record(image.image_url).url || image.url || message.content
 }
 return {run,chat,buildGenerationPayload,requestGeneration,requestEdit,parseResponse,buildEdit,timedFetch}
}
