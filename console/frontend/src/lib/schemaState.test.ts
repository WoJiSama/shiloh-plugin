import { describe, expect, it } from 'vitest'
import { initialValues, validateField, type SchemaView } from './schemaState'
import { hydrateProvider, previewAiUrl, providerPayload, rebaseAiProviders } from './schemaAi'

describe('schema edit contracts', () => {
  it('starts credentials in keep mode without importing a server value into the draft', () => {
    const view: SchemaView = {
      key: 'pipeline',
      title: '测试',
      groups: [
        {
          label: '授权',
          fields: [
            {
              field: 'youtubeRelay.cookieHeader',
              label: 'Cookie',
              component: 'InputPassword',
              secret: true,
              configured: true,
              value: 'a server must redact this'
            }
          ]
        }
      ]
    }
    expect(initialValues(view)).toEqual({
      'youtubeRelay.cookieHeader': { action: 'keep', value: '' }
    })
    expect(validateField(view.groups[0].fields[0], { action: 'replace', value: '' })).toHaveLength(
      1
    )
    expect(validateField(view.groups[0].fields[0], { action: 'clear', value: '' })).toEqual([])
  })
  it('rejects unknown components and enforces numeric bounds and schema step increments', () => {
    expect(
      validateField({ field: 'unknown', label: '新组件', component: 'Other' }, '')[0]
    ).toContain('暂不支持')
    const field = {
      field: 'limit',
      label: '上限',
      component: 'InputNumber',
      props: { min: 1, max: 60, step: 5 }
    }
    expect(validateField(field, null)).toHaveLength(1)
    expect(validateField(field, 0)).not.toEqual([])
    expect(validateField(field, 61)).not.toEqual([])
    expect(validateField(field, 6)).not.toEqual([])
    expect(validateField(field, 1)).toEqual([])
    expect(validateField(field, 30)).toEqual([])
  })
  it('accepts configured Select options and rejects an unsupported selection', () => {
    const field = {
      field: 'chatTriggerMode',
      label: '触发方式',
      component: 'Select',
      props: { options: [{ value: 'strict' }, { value: 'smart' }] }
    }
    expect(validateField(field, 'smart')).toEqual([])
    expect(validateField(field, 'other')).toEqual(['触发方式请选择有效选项'])
    expect(
      validateField({ ...field, props: { options: [{ value: '' }, { value: 'low' }] } }, '')
    ).toEqual([])
  })
  it('validates required nested mood fields and probabilities', () => {
    const field = {
      field: 'moods',
      label: '心情',
      component: 'GSubForm',
      subFields: [
        { field: 'name', label: '名字', component: 'Input', required: true },
        {
          field: 'probability',
          label: '概率',
          component: 'InputNumber',
          props: { min: 0.01, max: 1, step: 0.01 }
        }
      ]
    }
    expect(validateField(field, [{ name: '', probability: 1.2 }])).toHaveLength(2)
    expect(validateField(field, [{ name: '活泼', probability: 0.12 }])).toEqual([])
  })
})

describe('AI credential and URL contracts', () => {
  it('keeps the stable server identity on reorder while never submitting its masked credential as a replacement', () => {
    const first = hydrateProvider({
      _consoleId: 'stable-a',
      name: '甲',
      apiKey: 'masked…1234',
      apiKeyConfigured: true
    })
    const second = hydrateProvider({
      _consoleId: 'stable-b',
      name: '乙',
      apiKey: 'masked…6789',
      apiKeyConfigured: true
    })
    const reordered = [second, first].map(providerPayload)
    expect(
      reordered.map((provider) => [provider._consoleId, provider.apiKeyAction, provider.apiKey])
    ).toEqual([
      ['stable-b', 'keep', ''],
      ['stable-a', 'keep', '']
    ])
    expect(JSON.stringify(reordered)).not.toContain('masked')
    expect(JSON.stringify(reordered)).not.toContain('_clientId')
    first._keyAction = 'replace'
    first.apiKey = 'new-key'
    expect(providerPayload(first)).toMatchObject({ apiKeyAction: 'replace', apiKey: 'new-key' })
    first._keyAction = 'clear'
    expect(providerPayload(first)).toMatchObject({ apiKeyAction: 'clear', apiKey: '' })
  })
  it('previews chat, embedding and image edit URLs with their distinct completion rules', () => {
    const provider = hydrateProvider({ apiUrl: 'https://example.test/v1/' })
    expect(previewAiUrl({ configKey: 'chat', title: '聊天', kind: 'chat' }, provider)).toBe(
      'https://example.test/v1/chat/completions'
    )
    expect(
      previewAiUrl({ configKey: 'embedding', title: '向量', kind: 'embedding' }, provider)
    ).toBe('https://example.test/v1/embeddings')
    expect(
      previewAiUrl({ configKey: 'imageEditAiConfig', title: '编辑', kind: 'image' }, provider)
    ).toBe('https://example.test/v1/images/edits')
    provider.autoResolve = false
    expect(previewAiUrl({ configKey: 'chat', title: '聊天', kind: 'chat' }, provider)).toBe(
      'https://example.test/v1'
    )
  })
  it('refreshes untouched channel fields while retaining local edits, deletions and new channels', () => {
    const previous = [
      hydrateProvider({ _consoleId: 'a', name: '甲', model: 'old', priority: 1 }),
      hydrateProvider({ _consoleId: 'b', name: '乙', model: 'old', priority: 2 })
    ]
    const current = [
      { ...previous[0], name: '本地修改' },
      hydrateProvider({ name: '本地新建' }, 'local')
    ]
    const fresh = [
      { ...previous[0], model: 'server-new' },
      { ...previous[1] },
      hydrateProvider({ _consoleId: 'c', name: '服务器新建' })
    ]
    const result = rebaseAiProviders(fresh, current, previous)
    expect(result.map((provider) => provider._clientId)).toEqual(['a', 'c', 'local'])
    expect(result[0]).toMatchObject({ name: '本地修改', model: 'server-new' })
    result[1].name = '编辑新渠道'
    expect(fresh[2].name).toBe('服务器新建')
  })
})
