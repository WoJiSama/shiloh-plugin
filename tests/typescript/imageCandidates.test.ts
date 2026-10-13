import test from 'node:test';
import assert from 'node:assert/strict';
import { executeImageCandidates, ImageExecutionError } from '../../src/modules/image/application/executeCandidates.js';
import type { ImageCandidatePorts } from '../../src/contracts/image.js';
function ports(request: ImageCandidatePorts<string, string[]>['request'], signal?: AbortSignal): ImageCandidatePorts<string, string[]> {
  return { request, describe: item => item, identity: item => ({ providerId: item, model: 'model-' + item }),
    retryWithoutFormat: message => message.includes('response_format'), failureMessage: attempts => attempts.map(item => item.error).join(';'), now: () => 100, ...(signal ? { signal } : {}) };
}
test('candidate core preserves all images, format retry and provider/model attempts', async () => {
  const calls: string[] = [];
  const result = await executeImageCandidates(['a', 'b'], ports(async (candidate, format) => {
    calls.push(`${candidate}:${format}`);
    if (candidate === 'a') return { ok: false, errorMessage: '429 insufficient balance' };
    if (format) return { ok: false, errorMessage: 'unsupported response_format' };
    return { ok: true, value: ['image1', 'image2'] };
  }));
  assert.deepEqual(calls, ['a:b64_json', 'b:b64_json', 'b:']);
  assert.deepEqual(result.value, ['image1', 'image2']);
  assert.equal(result.attempts[0]?.model, 'model-a');
  assert.equal(result.attempts[1]?.providerId, 'b');
  assert.equal(result.attempts[1]?.ok, true);
});
test('cancellation before request and during response prevents retries or false success', async () => {
  const controller = new AbortController(); let calls = 0;
  const p = ports(async () => { calls++; controller.abort(); return { ok: true, value: ['must-not-send'] }; }, controller.signal);
  await assert.rejects(executeImageCandidates(['a', 'b'], p), error => error instanceof ImageExecutionError && error.cancelled && error.attempts.length === 1);
  assert.equal(calls, 1);
  await assert.rejects(executeImageCandidates(['a'], p), error => error instanceof ImageExecutionError && error.cancelled && error.attempts.length === 0);
  assert.equal(calls, 1);
});
test('thrown errors and no candidates retain structured failure results', async () => {
  await assert.rejects(executeImageCandidates(['a', 'b'], ports(async () => { throw new Error('timeout'); })), error => {
    assert.ok(error instanceof ImageExecutionError);
    assert.equal(error.attempts.length, 2); assert.equal(error.cancelled, false); return true;
  });
  await assert.rejects(executeImageCandidates([], ports(async () => ({ ok: true, value: [] }))), ImageExecutionError);
});
