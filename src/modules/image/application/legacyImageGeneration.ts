import { executeImageCandidates } from './executeCandidates.js';
import { describeImageGenerationConfig, shouldRetryWithoutUrlResponseFormat, buildImageEditFailureMessage, buildImageGenerationFailureMessage } from '../domain/providerConfig.js';

type Candidate = Record<string, unknown>;
type Response = { ok: true; image: unknown } | { ok: false; errorMessage?: string };
interface SharedAdapter {
  parseResponse?: (response: unknown) => Response | Promise<Response>;
  validateImage?: (image: unknown, config: Candidate) => unknown | Promise<unknown>;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
  signal?: AbortSignal;
}
interface GenerateAdapter extends SharedAdapter {
  request?: (config: Candidate, prompt: string, format?: string) => unknown | Promise<unknown>;
}
interface EditAdapter extends SharedAdapter {
  request?: (config: Candidate, prompt: string, images: readonly string[], format?: string) => unknown | Promise<unknown>;
}
function candidatesFrom(value: unknown): Candidate[] {
  return (Array.isArray(value) ? value : [value]).filter((item): item is Candidate => item !== null && typeof item === 'object' && !Array.isArray(item));
}
async function executeLegacyImageCandidates(configs: unknown, adapter: SharedAdapter, operation: 'generate' | 'edit', request: (candidate: Candidate, format?: string) => unknown | Promise<unknown>) {
  const parseResponse = adapter.parseResponse;
  if (!parseResponse) throw new Error('图片适配器缺少 parseResponse 能力');
  const title = operation === 'edit' ? '图片编辑' : '图片生成';
  const result = await executeImageCandidates<Candidate, unknown>(candidatesFrom(configs), {
    describe: describeImageGenerationConfig,
    identity: config => ({ providerId: String(config.providerId || config.name || ''), model: String(config.model || '') }),
    async request(config, format) {
      const parsed = await parseResponse(await request(config, format || undefined));
      if (!parsed.ok) return { ok: false, errorMessage: parsed.errorMessage || '未接收到有效图片' };
      const image = adapter.validateImage ? await adapter.validateImage(parsed.image, config) : parsed.image;
      return { ok: true, value: image };
    },
    retryWithoutFormat: shouldRetryWithoutUrlResponseFormat,
    failureMessage: attempts => (operation === 'edit' ? buildImageEditFailureMessage : buildImageGenerationFailureMessage)(attempts.map(item => ({ label: item.provider, message: item.error }))),
    now: () => Date.now(),
    ...(adapter.signal ? { signal: adapter.signal } : {}),
    onFormatFallback: label => adapter.logInfo?.(`[${title}] ${label} 不支持 response_format=b64_json，退回默认返回格式`),
    onCandidateFailure: (attempt, hasNext) => { if (hasNext) adapter.logWarn?.(`[${title}] ${attempt.provider} 失败，尝试下一个候选模型: ${attempt.error}`); },
    onSuccess: (label, index) => { if (index > 0) adapter.logInfo?.(`[${title}] fallback 成功: ${label}`); }
  });
  return result.value;
}
export async function generateImageWithFallbacks(configs: unknown, prompt: string, adapter: GenerateAdapter = {}) {
  const request = adapter.request;
  if (!request) throw new Error('图片适配器缺少 request 能力');
  return executeLegacyImageCandidates(configs, adapter, 'generate', (config, format) => request(config, prompt, format));
}
export async function generateImageEditWithFallbacks(configs: unknown, prompt: string, images: readonly string[], adapter: EditAdapter = {}) {
  const request = adapter.request;
  if (!request) throw new Error('图片适配器缺少 request 能力');
  return executeLegacyImageCandidates(configs, adapter, 'edit', (config, format) => request(config, prompt, images, format));
}
