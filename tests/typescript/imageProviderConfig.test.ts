import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveImageGenerationConfigs, resolveImageEditConfigs, normalizeImageProviderParameter } from '../../src/modules/image/domain/providerConfig.js';
import { generateImageWithFallbacks } from '../../src/modules/image/application/legacyImageGeneration.js';

test('external malformed root and provider list values do not become phantom channels', () => {
  for (const value of [null, 1, 'invalid', [], { imageGenerationAiConfig: null }, { imageEditAiConfig: 42 }]) {
    assert.deepEqual(resolveImageGenerationConfigs(value), []);
    assert.deepEqual(resolveImageEditConfigs(value), []);
  }
  const configs = resolveImageGenerationConfigs({ imageGenerationAiConfig: {
    imageGenerationApiKey: 'real-test-key', imageGenerationApiModel: 'gpt-image-2',
    providers: [null, 42, 'bad', [], { name: 'actual', model: 'gpt-image-2', apiKey: 'second-test-key' }]
  } });
  assert.equal(configs.length, 2);
  assert.equal(configs[1]?.name, 'actual');
  assert.deepEqual(normalizeImageProviderParameter(null), {});
});
test('legacy execution capability omissions fail explicitly at boundary', async () => {
  await assert.rejects(generateImageWithFallbacks([], 'draw'), /request/);
  await assert.rejects(generateImageWithFallbacks([], 'draw', { request: () => ({}) }), /parseResponse/);
});
