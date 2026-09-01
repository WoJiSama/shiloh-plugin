import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateImageEditWithFallbacks,
  generateImageWithFallbacks,
  isImageToolContractError,
  normalizeImageProviderParameter,
  resolveRequestedImageProvider,
  resolveImageEditConfigs,
  resolveImageGenerationConfigs,
  selectImageConfigsByProvider,
  shouldRetryWithoutUrlResponseFormat,
  toImageEditUrl,
  toImageGenerationUrl
} from '../utils/imageGenerationFallback.js'

function response(ok, body, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    async text() {
      return JSON.stringify(body)
    }
  }
}

test('keeps legacy imageGenerationAiConfig as first candidate and appends fallbacks', () => {
  const configs = resolveImageGenerationConfigs({
    imageGenerationAiConfig: {
      imageGenerationApiUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
      imageGenerationApiModel: 'doubao-seedream-5-0-260128',
      imageGenerationApiKey: 'seedream-key',
      imageGenerationSize: '2K',
      imageGenerationPriority: 1,
      imageGenerationFallbacks: [
        {
          name: 'image2',
          imageGenerationApiUrl: 'https://api.openai.com/v1',
          imageGenerationApiModel: 'gpt-image-2',
          imageGenerationApiKey: 'image2-key',
          imageGenerationSize: '1024x1024',
          priority: 2
        }
      ]
    }
  })

  assert.equal(configs.length, 2)
  assert.deepEqual(
    configs.map(item => [item.name, item.apiUrl, item.model, item.size]),
    [
      ['doubao-seedream-5-0-260128', 'https://ark.cn-beijing.volces.com/api/v3/images/generations', 'doubao-seedream-5-0-260128', '2K'],
      ['image2', 'https://api.openai.com/v1/images/generations', 'gpt-image-2', '1024x1024']
    ]
  )
})

test('supports explicit ordered imageGenerationProviders list', () => {
  const configs = resolveImageGenerationConfigs({
    imageGenerationAiConfig: {
      imageGenerationApiUrl: 'https://primary.example.com/v1/images/generations',
      imageGenerationApiModel: 'primary-image',
      imageGenerationApiKey: 'primary-key',
      imageGenerationPriority: 3,
      imageGenerationProviders: [
        {
          name: 'seedream',
          imageGenerationApiUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
          imageGenerationApiModel: 'doubao-seedream-5-0-260128',
          imageGenerationApiKey: 'seedream-key',
          imageGenerationSize: '2K',
          priority: 1
        },
        {
          name: 'image2',
          apiUrl: 'https://api.openai.com/v1/images/edits',
          model: 'gpt-image-2',
          apiKey: 'image2-key',
          size: '1024x1024',
          priority: 2
        }
      ]
    }
  })

  assert.equal(configs.length, 3)
  assert.equal(configs[0].name, 'seedream')
  assert.equal(configs[1].name, 'image2')
  assert.equal(configs[2].name, 'primary-image')
  assert.equal(configs[1].apiUrl, 'https://api.openai.com/v1/images/generations')
})

test('supports Guoba providers-only configuration', () => {
  const configs = resolveImageGenerationConfigs({
    imageGenerationAiConfig: {
      providers: [
        {
          name: 'doubao',
          apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
          model: 'doubao-seedream-5-0-260128',
          apiKey: 'seedream-key',
          size: '2K',
          priority: 2
        },
        {
          name: 'image2',
          apiUrl: 'https://api.openai.com/v1/images/generations',
        model: 'gpt-image-2',
        apiKey: 'image2-key',
        size: '1024x1024',
        squareSize: '1024x1024',
        portraitSize: '1024x1536',
        landscapeSize: '1536x1024',
        priority: 1
        }
      ]
    }
  })

  assert.deepEqual(configs.map(item => item.name), ['image2', 'doubao'])
  assert.deepEqual(
    [configs[0].squareSize, configs[0].portraitSize, configs[0].landscapeSize],
    ['1024x1024', '1024x1536', '1536x1024']
  )
})

test('priority can promote any configured provider to first place', () => {
  const configs = resolveImageGenerationConfigs({
    imageGenerationAiConfig: {
      imageGenerationApiUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
      imageGenerationApiModel: 'doubao-seedream-5-0-260128',
      imageGenerationApiKey: 'seedream-key',
      imageGenerationSize: '2K',
      imageGenerationPriority: 2,
      imageGenerationProviders: [
        {
          name: 'image2',
          imageGenerationApiUrl: 'https://api.openai.com/v1/images/generations',
          imageGenerationApiModel: 'gpt-image-2',
          imageGenerationApiKey: 'image2-key',
          imageGenerationSize: '1024x1024',
          priority: 1
        }
      ]
    }
  })

  assert.equal(configs[0].name, 'image2')
  assert.equal(configs[1].name, 'doubao-seedream-5-0-260128')
})

test('explicit provider wording selects the configured channel name', () => {
  const config = {
    imageGenerationAiConfig: {
      providers: [
        { name: 'Krill', apiUrl: 'https://krill.example/v1', model: 'gpt-image-2', apiKey: 'krill-key', priority: 1 },
        { name: 'Grok', apiUrl: 'https://grok.example/v1', model: 'grok-imagine', apiKey: 'grok-key', priority: 3 }
      ]
    }
  }
  const requested = resolveRequestedImageProvider(config, '希洛，帮我用 grok 画一张猫猫图')
  const selected = selectImageConfigsByProvider(resolveImageGenerationConfigs(config), requested, '文生图')

  assert.equal(requested, 'Grok')
  assert.deepEqual(selected.map(item => item.name), ['Grok'])
  assert.equal(selected[0].quality, '')
  assert.equal(resolveRequestedImageProvider(config, '用 Grok 改一下这张图'), 'Grok')
})

test('normalizes optional provider quality for tutorial-compatible payloads', () => {
  const configs = resolveImageGenerationConfigs({
    imageGenerationAiConfig: {
      providers: [{
        name: 'grok',
        apiUrl: 'https://api.krill-ai.com/v1',
        model: 'grok-imagine-image',
        apiKey: 'grok-key',
        quality: 'high'
      }]
    }
  })
  assert.equal(configs[0].quality, 'high')
})

test('provider selection supports model ids and explicit channel wording', () => {
  const config = {
    imageGenerationAiConfig: {
      providers: [{ name: 'Grok', apiUrl: 'https://grok.example/v1', model: 'grok-imagine', apiKey: 'grok-key' }]
    }
  }
  assert.equal(resolveRequestedImageProvider(config, '指定名字是 Grok 的渠道画一张图'), 'Grok')
  assert.equal(resolveRequestedImageProvider(config, '用 grok-imagine 模型生成一张图'), 'Grok')
  assert.equal(resolveRequestedImageProvider(config, '用 Foo 渠道画一张图'), 'Foo')
})

test('unique channel shorthand matches configured compound names', () => {
  const config = {
    imageGenerationAiConfig: {
      providers: [
        { name: 'krill-image-2', apiUrl: 'https://krill.example/v1', model: 'gpt-image-2', apiKey: 'krill-key' },
        { name: 'sou-inmage-2', apiUrl: 'https://sou.example/v1', model: 'gpt-image-2', apiKey: 'sou-key' }
      ]
    }
  }
  assert.equal(resolveRequestedImageProvider(config, '用 krill 画一张图'), 'krill-image-2')
  assert.equal(resolveRequestedImageProvider(config, '用 sou 渠道生成一张图'), 'sou-inmage-2')
})

test('style wording alone does not lock an image provider', () => {
  const config = {
    imageGenerationAiConfig: {
      providers: [{ name: 'Grok', apiUrl: 'https://grok.example/v1', model: 'grok-imagine', apiKey: 'grok-key' }]
    }
  }
  assert.equal(resolveRequestedImageProvider(config, '用 Grok 风格画一只猫'), '')
  assert.equal(resolveRequestedImageProvider(config, '参考 Grok 的画面风格生成'), '')
})

test('drops a planner-invented provider unless the user explicitly selected it', () => {
  const config = {
    imageGenerationAiConfig: {
      providers: [
        { name: 'Grok', apiUrl: 'https://grok.example/v1', model: 'grok-imagine', apiKey: 'grok-key' },
        { name: 'Krill', apiUrl: 'https://krill.example/v1', model: 'gpt-image-2', apiKey: 'krill-key' }
      ]
    }
  }

  assert.equal(
    resolveRequestedImageProvider(config, '希洛帮我去掉这个图手里的手机', 'gemini'),
    ''
  )
  assert.equal(
    resolveRequestedImageProvider(config, '希洛帮我用 Grok 去掉这个图手里的手机', 'gemini'),
    'Grok'
  )
  assert.equal(
    resolveRequestedImageProvider(config, '希洛帮我用 Gemini 去掉这个图手里的手机', 'gemini'),
    'gemini'
  )

  assert.deepEqual(
    normalizeImageProviderParameter(
      { prompt: '去掉手机', images: ['image'], provider: 'gemini' },
      config,
      '希洛帮我去掉这个图手里的手机'
    ),
    { prompt: '去掉手机', images: ['image'] }
  )
  assert.deepEqual(
    normalizeImageProviderParameter(
      { prompt: '去掉手机', images: ['image'], provider: 'Grok' },
      config,
      '希洛帮我用 Grok 去掉这个图手里的手机'
    ),
    { prompt: '去掉手机', images: ['image'], provider: 'Grok' }
  )
  assert.equal(
    resolveRequestedImageProvider(config, '不要用 Grok，改用 Krill 去掉手机', 'Grok'),
    'Krill'
  )
})

test('strict provider selection never falls back to a different name', () => {
  const configs = [
    { name: 'Krill', aliases: ['Krill', 'gpt-image-2'], priority: 1 },
    { name: 'Grok', aliases: ['Grok', 'grok-imagine'], priority: 3 }
  ]
  assert.deepEqual(selectImageConfigsByProvider(configs, 'grok').map(item => item.name), ['Grok'])
  assert.throws(
    () => selectImageConfigsByProvider(configs, 'Sou', '文生图'),
    /指定图片渠道“Sou”.*不会自动改用其他渠道/
  )
})

test('generation-only provider is rejected for image editing', () => {
  const config = {
    imageGenerationAiConfig: {
      providers: [
        { name: 'Grok', apiUrl: 'https://grok.example/v1', model: 'grok-imagine', apiKey: 'grok-key' },
        { name: 'Krill', apiUrl: 'https://krill.example/v1', model: 'gpt-image-2', apiKey: 'krill-key' }
      ]
    }
  }
  const editConfigs = resolveImageEditConfigs(config)
  assert.deepEqual(editConfigs.map(item => item.name), ['Krill'])
  assert.throws(
    () => selectImageConfigsByProvider(editConfigs, 'Grok', '图片编辑'),
    /未找到可用于图片编辑的指定图片渠道“Grok”/
  )
})

test('shared model id asks for a channel name instead of choosing one arbitrarily', () => {
  const config = {
    imageGenerationAiConfig: {
      providers: [
        { name: 'Krill', apiUrl: 'https://krill.example/v1', model: 'gpt-image-2', apiKey: 'krill-key' },
        { name: 'Sou', apiUrl: 'https://sou.example/v1', model: 'gpt-image-2', apiKey: 'sou-key' }
      ]
    }
  }
  const requested = resolveRequestedImageProvider(config, '用 gpt-image-2 模型画一张图')
  assert.equal(requested, 'gpt-image-2')
  assert.throws(
    () => selectImageConfigsByProvider(resolveImageGenerationConfigs(config), requested, '文生图'),
    /同时匹配多个渠道.*Krill.*Sou.*明确说渠道名称/
  )
})

test('skips placeholder keys and falls back to imageEditAiConfig only for generation-like edit config', () => {
  assert.deepEqual(resolveImageGenerationConfigs({
    imageGenerationAiConfig: {
      imageGenerationApiUrl: 'https://api.openai.com/v1/images/generations',
      imageGenerationApiModel: 'gpt-image-1',
      imageGenerationApiKey: 'sk-xxxxx'
    }
  }), [])

  const configs = resolveImageGenerationConfigs({
    imageEditAiConfig: {
      imageEditApiUrl: 'https://api.openai.com/v1/images/edits',
      imageEditApiModel: 'gpt-image-1',
      imageEditApiKey: 'real-key'
    }
  })

  assert.equal(configs.length, 1)
  assert.equal(configs[0].apiUrl, 'https://api.openai.com/v1/images/generations')
  assert.equal(configs[0].model, 'gpt-image-1')
})

test('normalizes common endpoint URLs to images/generations', () => {
  assert.equal(toImageGenerationUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/images/generations')
  assert.equal(toImageGenerationUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/images/generations')
  assert.equal(toImageGenerationUrl('https://api.openai.com/v1/images/edits'), 'https://api.openai.com/v1/images/generations')
})

test('resolves only image-edit-capable providers and keeps current edit config first', () => {
  const configs = resolveImageEditConfigs({
    imageEditAiConfig: {
      imageEditApiUrl: 'https://primary.example.com/v1',
      imageEditApiModel: 'gpt-image-2',
      imageEditApiKey: 'primary-key',
      imageEditSize: '1024x1024'
    },
    imageGenerationAiConfig: {
      providers: [
        {
          name: 'grok',
          apiUrl: 'https://grok.example.com/v1',
          model: 'grok-imagine',
          apiKey: 'grok-key',
          priority: 1
        },
        {
          name: 'image2-backup',
          apiUrl: 'https://backup.example.com/v1/images/generations',
          model: 'gpt-image-2',
          apiKey: 'backup-key',
          priority: 2
        }
      ]
    }
  })

  assert.deepEqual(configs.map(item => item.name), ['gpt-image-2', 'image2-backup'])
  assert.deepEqual(configs.map(item => item.apiUrl), [
    'https://primary.example.com/v1/images/edits',
    'https://backup.example.com/v1/images/edits'
  ])
})

test('supports explicit imageEditAiConfig providers before generation-provider fallbacks', () => {
  const configs = resolveImageEditConfigs({
    imageEditAiConfig: {
      imageEditApiUrl: 'https://primary.example/v1',
      imageEditApiModel: 'gpt-image-2',
      imageEditApiKey: 'primary-key',
      providers: [{
        name: 'edit-backup',
        apiUrl: 'https://edit-backup.example/v1',
        model: 'gpt-image-2',
        apiKey: 'edit-backup-key',
        priority: 1
      }]
    },
    imageGenerationAiConfig: {
      providers: [{
        name: 'generation-backup',
        apiUrl: 'https://generation-backup.example/v1',
        model: 'gpt-image-2',
        apiKey: 'generation-backup-key',
        priority: 2
      }]
    }
  })

  assert.deepEqual(configs.map(item => item.name), ['gpt-image-2', 'edit-backup', 'generation-backup'])
})

test('keeps chat-completions image editing on its legacy route', () => {
  assert.deepEqual(resolveImageEditConfigs({
    imageEditAiConfig: {
      imageEditApiUrl: 'https://api.example.com/v1/chat/completions',
      imageEditApiModel: 'gemini-3-pro-image-preview',
      imageEditApiKey: 'gemini-key'
    }
  }), [])
})

test('normalizes common endpoint URLs to images/edits', () => {
  assert.equal(toImageEditUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/images/edits')
  assert.equal(toImageEditUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/images/edits')
  assert.equal(toImageEditUrl('https://api.openai.com/v1/images/generations'), 'https://api.openai.com/v1/images/edits')
})

test('falls back to second model when first model fails', async () => {
  const calls = []
  const image = await generateImageWithFallbacks([
    { name: 'seedream', apiUrl: 'u1', model: 'm1', apiKey: 'key-1', size: '2K' },
    { name: 'image2', apiUrl: 'u2', model: 'm2', apiKey: 'key-2', size: '1024x1024' }
  ], '画一只猫', {
    async request(config, prompt, responseFormat) {
      calls.push([config.name, prompt, responseFormat || 'default'])
      return config.name === 'seedream'
        ? response(false, { error: { message: 'rate limited' } }, 429)
        : response(true, { data: [{ url: 'https://example.com/cat.png' }] })
    },
    async parseResponse(res) {
      const data = JSON.parse(await res.text())
      if (!res.ok) return { ok: false, errorMessage: data.error.message }
      return { ok: true, image: data.data[0].url }
    }
  })

  assert.equal(image, 'https://example.com/cat.png')
  assert.deepEqual(calls.map(item => [item[0], item[2]]), [
    ['seedream', 'b64_json'],
    ['image2', 'b64_json']
  ])
})

test('retries same model without response_format before moving to next fallback', async () => {
  const calls = []
  const image = await generateImageWithFallbacks([
    { name: 'seedream', apiUrl: 'u1', model: 'm1', apiKey: 'key-1', size: '2K' },
    { name: 'image2', apiUrl: 'u2', model: 'm2', apiKey: 'key-2', size: '1024x1024' }
  ], '画一只猫', {
    async request(config, prompt, responseFormat) {
      calls.push([config.name, responseFormat || 'default'])
      if (responseFormat === 'b64_json') {
        return response(false, { error: { message: 'unknown parameter: response_format' } }, 400)
      }
      return response(true, { data: [{ b64_json: 'abc123' }] })
    },
    async parseResponse(res) {
      const data = JSON.parse(await res.text())
      if (!res.ok) return { ok: false, errorMessage: data.error.message }
      const item = data.data[0]
      return { ok: true, image: item.url || `base64://${item.b64_json}` }
    }
  })

  assert.equal(image, 'base64://abc123')
  assert.deepEqual(calls, [
    ['seedream', 'b64_json'],
    ['seedream', 'default']
  ])
})

test('image edit falls back after 503 while preserving prompt and references exactly', async () => {
  const calls = []
  const rawPrompt = '保持我的原话：衣服内微微露胸，黑色丝袜，不要替我改词'
  const references = ['https://img.example/avatar.jpg']
  const image = await generateImageEditWithFallbacks([
    { name: 'primary', apiUrl: 'https://primary.example/v1/images/edits', model: 'gpt-image-2', apiKey: 'primary-key' },
    { name: 'backup', apiUrl: 'https://backup.example/v1/images/edits', model: 'gpt-image-2', apiKey: 'backup-key' }
  ], rawPrompt, references, {
    async request(config, prompt, images, responseFormat) {
      calls.push({ name: config.name, prompt, images, responseFormat })
      return config.name === 'primary'
        ? response(false, { error: { message: '503 No available channel for model gpt-image-2 under group codex (distributor)' } }, 503)
        : response(true, { data: [{ b64_json: 'edited-image' }] })
    },
    async parseResponse(res) {
      const data = JSON.parse(await res.text())
      if (!res.ok) return { ok: false, errorMessage: data.error.message }
      return { ok: true, image: `base64://${data.data[0].b64_json}` }
    }
  })

  assert.equal(image, 'base64://edited-image')
  assert.deepEqual(calls.map(item => item.name), ['primary', 'backup'])
  assert.ok(calls.every(item => item.prompt === rawPrompt))
  assert.ok(calls.every(item => item.images === references))
  assert.ok(calls.every(item => item.responseFormat === 'b64_json'))
})

test('image edit does not misclassify image_generation tool contract errors as response_format errors', async () => {
  const calls = []
  const upstreamError = "Tool choice 'image_generation' not found in 'tools' parameter."
  const image = await generateImageEditWithFallbacks([
    { name: 'broken-contract', apiUrl: 'https://broken.example/v1/images/edits', model: 'gpt-image-2', apiKey: 'broken-key' },
    { name: 'working-backup', apiUrl: 'https://backup.example/v1/images/edits', model: 'gpt-image-2', apiKey: 'backup-key' }
  ], '保持原始编辑要求', ['reference-image'], {
    async request(config, prompt, images, responseFormat) {
      calls.push([config.name, responseFormat || 'default'])
      return config.name === 'broken-contract'
        ? response(true, { error: { message: upstreamError } })
        : response(true, { data: [{ b64_json: 'edited-image' }] })
    },
    async parseResponse(res) {
      const data = JSON.parse(await res.text())
      if (data.error?.message) {
        return {
          ok: false,
          errorMessage: `未接收到有效图片，上游返回字段: top=[error] data0=[无] error=${data.error.message}`
        }
      }
      return { ok: true, image: `base64://${data.data[0].b64_json}` }
    }
  })

  assert.equal(image, 'base64://edited-image')
  assert.deepEqual(calls, [
    ['broken-contract', 'b64_json'],
    ['working-backup', 'b64_json']
  ])
})

test('image edit aggregates all provider failures without leaking api keys', async () => {
  const rawPrompt = '逐字保留这个提示词'
  const calls = []
  await assert.rejects(
    () => generateImageEditWithFallbacks([
      { name: 'primary', apiUrl: 'u1', model: 'gpt-image-2', apiKey: 'secret-primary' },
      { name: 'backup', apiUrl: 'u2', model: 'gpt-image-2', apiKey: 'secret-backup' }
    ], rawPrompt, ['reference'], {
      async request(config, prompt) {
        calls.push([config.name, prompt])
        throw new Error(`${config.name} unavailable`)
      },
      async parseResponse() {
        throw new Error('should not parse')
      }
    }),
    error => {
      assert.match(error.message, /所有图片编辑通道都失败/)
      assert.match(error.message, /primary/)
      assert.match(error.message, /backup/)
      assert.doesNotMatch(error.message, /secret-/)
      return true
    }
  )
  assert.ok(calls.every(([, prompt]) => prompt === rawPrompt))
})

test('final failure message contains provider labels but not api keys', async () => {
  await assert.rejects(
    () => generateImageWithFallbacks([
      { name: 'seedream', apiUrl: 'u1', model: 'm1', apiKey: 'secret-key-1', size: '2K' },
      { name: 'image2', apiUrl: 'u2', model: 'm2', apiKey: 'secret-key-2', size: '1024x1024' }
    ], '画一只猫', {
      async request(config) {
        throw new Error(`${config.name} unavailable`)
      },
      async parseResponse() {
        throw new Error('should not parse')
      }
    }),
    error => {
      assert.match(error.message, /seedream/)
      assert.match(error.message, /image2/)
      assert.doesNotMatch(error.message, /secret-key/)
      return true
    }
  )
})

test('detects response_format compatibility errors', () => {
  assert.equal(shouldRetryWithoutUrlResponseFormat('unknown parameter: response_format'), true)
  assert.equal(shouldRetryWithoutUrlResponseFormat("Tool choice 'image_generation' not found in 'tools' parameter."), false)
  assert.equal(shouldRetryWithoutUrlResponseFormat('service unavailable'), false)
  assert.equal(isImageToolContractError("Tool choice 'image_generation' not found in 'tools' parameter."), true)
})
