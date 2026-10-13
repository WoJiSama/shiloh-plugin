import type { ImageAttempt, ImageCandidatePorts, ImageExecutionResult } from '../../../contracts/image.js';

export class ImageExecutionError extends Error {
  constructor(message: string, readonly attempts: ImageAttempt[], readonly cancelled = false) {
    super(message); this.name = 'ImageExecutionError';
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误');
}
/** Shared candidate policy for QQ single-image and HTTP multi-image adapters. */
export async function executeImageCandidates<C, T>(candidates: readonly C[], ports: ImageCandidatePorts<C, T>): Promise<ImageExecutionResult<T>> {
  const attempts: ImageAttempt[] = [];
  const checkCancelled = () => { if (ports.signal?.aborted) throw new ImageExecutionError('已取消', attempts, true); };
  checkCancelled();
  for (const [index, candidate] of candidates.entries()) {
    const provider = ports.describe(candidate, index);
    const identity = ports.identity(candidate);
    const startedAt = ports.now();
    try {
      checkCancelled();
      let result = await ports.request(candidate, 'b64_json');
      checkCancelled();
      if (!result.ok && ports.retryWithoutFormat(result.errorMessage)) {
        ports.onFormatFallback?.(provider);
        checkCancelled();
        result = await ports.request(candidate, '');
        checkCancelled();
      }
      if (!result.ok) throw new Error(result.errorMessage || '未接收到有效图片');
      attempts.push({ provider, ...identity, ok: true, ms: Math.max(0, ports.now() - startedAt) });
      ports.onSuccess?.(provider, index);
      return { value: result.value, provider, attempts };
    } catch (error: unknown) {
      const cancelled = ports.signal?.aborted === true;
      const attempt: ImageAttempt = { provider, ...identity, ok: false, ms: Math.max(0, ports.now() - startedAt), error: cancelled ? '已取消' : errorMessage(error).slice(0, 400) };
      attempts.push(attempt);
      if (cancelled) throw new ImageExecutionError('已取消', attempts, true);
      ports.onCandidateFailure?.(attempt, index + 1 < candidates.length);
    }
  }
  throw new ImageExecutionError(ports.failureMessage(attempts), attempts);
}
