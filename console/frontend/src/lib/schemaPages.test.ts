import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton, NTabs } from 'naive-ui'
import SchemaPage from '../pages/SchemaPage.vue'
import PersonaPage from '../pages/PersonaPage.vue'
import AiPage from '../pages/AiPage.vue'
import SchemaField from '../components/SchemaField.vue'
import SaveBar from '../components/SaveBar.vue'
import { api } from './api'
import { confirmLeave, installUnsavedDialog } from '../composables/useUnsavedGuard'
import { clone, type SchemaView } from './schemaState'

const { dialogWarning } = vi.hoisted(() => ({ dialogWarning: vi.fn() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
    useDialog: () => ({ warning: dialogWarning })
  }
})

const fixture: SchemaView = {
  key: 'pipeline',
  title: '消息管道',
  revision: 'r1',
  groups: [
    {
      label: '消息可靠管道',
      fields: [
        { field: 'messagePipeline.enabled', label: '启用管道', component: 'Switch', value: false },
        {
          field: 'messagePipeline.deliveryMaxAttempts',
          label: '最大尝试次数',
          component: 'InputNumber',
          props: { min: 1, max: 32, step: 1 },
          value: 8
        }
      ]
    },
    {
      label: 'YouTube',
      fields: [
        {
          field: 'youtubeRelay.cookieHeader',
          label: 'Cookie',
          component: 'InputPassword',
          secret: true,
          configured: true,
          value: ''
        }
      ]
    }
  ]
}
const mounted: VueWrapper[] = []
function createPage(withGuardDialog = false) {
  const component = withGuardDialog
    ? defineComponent({
        setup() {
          installUnsavedDialog()
          return () => h(SchemaPage, { kind: 'pipeline' })
        }
      })
    : SchemaPage
  const wrapper = mount(component, {
    props: withGuardDialog ? {} : { kind: 'pipeline' },
    attachTo: document.body
  })
  mounted.push(wrapper)
  return wrapper
}
function field(wrapper: VueWrapper, name: string) {
  return wrapper.findAllComponents(SchemaField).find((item) => item.props('field').field === name)!
}
beforeEach(() => {
  vi.mocked(api).mockReset()
  dialogWarning.mockReset()
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('configuration draft lifecycle', () => {
  it('renders readable task navigation labels in schema, persona and AI pages', async () => {
    vi.mocked(api).mockResolvedValueOnce(clone(fixture))
    const schema = createPage()
    await flushPromises()
    expect(schema.findAll('.n-tabs-tab').map((tab) => tab.text())).toEqual(['可靠管道', '平台授权'])
    vi.mocked(api)
      .mockResolvedValueOnce({
        personas: [],
        groupBindings: {},
        accountBindings: {},
        privateBinding: ''
      })
      .mockResolvedValueOnce({ accounts: [] })
    const persona = mount(PersonaPage, { attachTo: document.body })
    mounted.push(persona)
    await flushPromises()
    expect(persona.findAll('.n-tabs-tab').map((tab) => tab.text())).toEqual([
      '人设库',
      '账号与会话绑定',
      '默认人设与画像'
    ])
    vi.mocked(api)
      .mockResolvedValueOnce({ key: 'reasoning', title: '思考程度', revision: 'r1', groups: [] })
      .mockResolvedValueOnce({
        definitions: [{ configKey: 'chatAiConfig', title: '聊天 chatAiConfig' }],
        sections: { chatAiConfig: [] },
        revisions: { chatAiConfig: 'r1' }
      })
    const ai = mount(AiPage, { attachTo: document.body })
    mounted.push(ai)
    await flushPromises()
    expect(ai.findAll('.n-tabs-tab').map((tab) => tab.text())).toEqual(['聊天'])
  })

  it('retains an edit made while saving and only clears the submitted change', async () => {
    let completeSave!: (value: unknown) => void
    const next = clone(fixture)
    next.revision = 'r2'
    next.groups[0].fields[0].value = true
    vi.mocked(api)
      .mockResolvedValueOnce(clone(fixture))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeSave = resolve
          })
      )
      .mockResolvedValueOnce(next)
    const wrapper = createPage()
    await flushPromises()
    field(wrapper, 'messagePipeline.enabled').vm.$emit('update:modelValue', true)
    await flushPromises()
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(wrapper.findComponent(SaveBar).props('saving')).toBe(true)
    field(wrapper, 'messagePipeline.deliveryMaxAttempts').vm.$emit('update:modelValue', 9)
    completeSave({ changed: 1, revision: 'r2' })
    await flushPromises()
    expect(field(wrapper, 'messagePipeline.enabled').props('modelValue')).toBe(true)
    expect(field(wrapper, 'messagePipeline.deliveryMaxAttempts').props('modelValue')).toBe(9)
    expect(wrapper.findComponent(SaveBar).props('dirty')).toBe(1)
    const options = vi.mocked(api).mock.calls[1][1]!
    expect(JSON.parse(String(options.body))).toEqual({
      values: { 'messagePipeline.enabled': true },
      secrets: {},
      revision: 'r1'
    })
  })

  it('keeps drafts across task tabs and sends explicit credential replacement without other untouched values', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(clone(fixture))
      .mockImplementationOnce(() => new Promise(() => {}))
    const wrapper = createPage()
    await flushPromises()
    field(wrapper, 'messagePipeline.enabled').vm.$emit('update:modelValue', true)
    wrapper.findComponent(NTabs).vm.$emit('update:value', 'authorization')
    await flushPromises()
    expect(field(wrapper, 'youtubeRelay.cookieHeader').props('modelValue')).toEqual({
      action: 'keep',
      value: ''
    })
    field(wrapper, 'youtubeRelay.cookieHeader').vm.$emit('update:modelValue', {
      action: 'replace',
      value: 'new-cookie'
    })
    wrapper.findComponent(NTabs).vm.$emit('update:value', 'pipeline')
    await flushPromises()
    expect(field(wrapper, 'messagePipeline.enabled').props('modelValue')).toBe(true)
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    const body = JSON.parse(String(vi.mocked(api).mock.calls[1][1]!.body))
    expect(body.values).toEqual({ 'messagePipeline.enabled': true })
    expect(body.secrets).toEqual({
      'youtubeRelay.cookieHeader': { action: 'replace', value: 'new-cookie' }
    })
  })

  it('cancelling the leave dialog does not reload or discard the draft', async () => {
    vi.mocked(api).mockResolvedValueOnce(clone(fixture))
    const wrapper = createPage(true)
    await flushPromises()
    field(wrapper, 'messagePipeline.enabled').vm.$emit('update:modelValue', true)
    await flushPromises()
    const leaving = confirmLeave()
    expect(dialogWarning).toHaveBeenCalledOnce()
    dialogWarning.mock.calls[0][0].onNegativeClick()
    expect(await leaving).toBe(false)
    expect(field(wrapper, 'messagePipeline.enabled').props('modelValue')).toBe(true)
    expect(wrapper.findComponent(SaveBar).props('dirty')).toBe(1)
    expect(api).toHaveBeenCalledOnce()
  })

  it('preserves the draft after a conflict and allows rebasing onto a refreshed revision', async () => {
    const next = clone(fixture)
    next.revision = 'r3'
    next.groups[0].fields[1].value = 12
    vi.mocked(api)
      .mockResolvedValueOnce(clone(fixture))
      .mockRejectedValueOnce(Object.assign(new Error('配置已变化'), { status: 409 }))
      .mockResolvedValueOnce(next)
    const wrapper = createPage()
    await flushPromises()
    field(wrapper, 'messagePipeline.enabled').vm.$emit('update:modelValue', true)
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(field(wrapper, 'messagePipeline.enabled').props('modelValue')).toBe(true)
    expect(wrapper.findComponent(SaveBar).props('disabled')).toBe(true)
    const refresh = wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '刷新并保留草稿')!
    await refresh.trigger('click')
    await flushPromises()
    expect(field(wrapper, 'messagePipeline.enabled').props('modelValue')).toBe(true)
    expect(field(wrapper, 'messagePipeline.deliveryMaxAttempts').props('modelValue')).toBe(12)
    expect(wrapper.findComponent(SaveBar).props('disabled')).toBe(false)
  })
})

describe('HTTP creation actions', () => {
  it('adds channels, personas and schema rows without randomUUID', async () => {
    const original = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) })
    vi.mocked(api).mockImplementation(async (url: string) => {
      if (url === '/api/config/reasoning') return { key: 'reasoning', groups: [] }
      if (url === '/api/ai/config')
        return {
          definitions: [{ configKey: 'chatAiConfig', title: '聊天' }],
          sections: { chatAiConfig: [] }
        }
      if (url === '/api/persona/library')
        return { personas: [], groupBindings: {}, accountBindings: {}, privateBinding: '' }
      return { accounts: [] }
    })
    const ai = mount(AiPage, { attachTo: document.body })
    mounted.push(ai)
    await flushPromises()
    await ai.find('.add-provider').trigger('click')
    expect(ai.findAll('.provider-heading')).toHaveLength(1)
    const persona = mount(PersonaPage, { attachTo: document.body })
    mounted.push(persona)
    await flushPromises()
    const button = persona
      .findAllComponents(NButton)
      .find((button) => button.text() === '新建人设')!
    await button.trigger('click')
    expect(persona.text()).toContain('新人设')
    const rows = mount(SchemaField, {
      props: {
        field: {
          field: 'rows',
          label: '条目',
          component: 'GSubForm',
          subFields: [{ field: 'name', label: '名称', component: 'Input' }]
        },
        modelValue: []
      },
      attachTo: document.body
    })
    mounted.push(rows)
    await rows.findComponent(NButton).trigger('click')
    const next = rows.emitted('update:modelValue')![0][0]
    await rows.setProps({ modelValue: next })
    expect(rows.findAll('.subform-row')).toHaveLength(1)
  })
})

describe('conversation settings', () => {
  it('keeps edits across purpose tabs and saves a Select choice without touching credentials', async () => {
    const fixture: SchemaView = {
      key: 'conversation',
      title: '对话设置',
      revision: 'r1',
      groups: [
        {
          label: '对话开关与触发',
          fields: [
            {
              field: 'chatTriggerMode',
              label: '触发方式',
              component: 'Select',
              props: {
                options: [
                  { label: '严格', value: 'strict' },
                  { label: '智能', value: 'smart' }
                ]
              },
              value: 'strict'
            }
          ]
        },
        {
          label: '群聊权限',
          fields: [
            { field: 'enableGroupWhitelist', label: '白名单', component: 'Switch', value: true }
          ]
        },
        {
          label: '短闲聊模型',
          fields: [
            {
              field: 'taskAiConfig.casual.apiKey',
              label: '密钥',
              component: 'InputPassword',
              configured: true,
              secret: true,
              value: ''
            }
          ]
        }
      ]
    }
    const next = clone(fixture)
    next.groups[0].fields[0].value = 'smart'
    vi.mocked(api)
      .mockResolvedValueOnce(fixture)
      .mockResolvedValueOnce({ changed: 1 })
      .mockResolvedValueOnce(next)
    const wrapper = mount(SchemaPage, { props: { kind: 'conversation' }, attachTo: document.body })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.findAll('.n-tabs-tab').map((tab) => tab.text())).toEqual([
      '触发与私聊',
      '访问权限',
      '任务模型'
    ])
    field(wrapper, 'chatTriggerMode').vm.$emit('update:modelValue', 'smart')
    await flushPromises()
    const tabs = wrapper.findComponent(NTabs)
    tabs.vm.$emit('update:value', 'models')
    await flushPromises()
    expect(field(wrapper, 'taskAiConfig.casual.apiKey').props('modelValue')).toEqual({
      action: 'keep',
      value: ''
    })
    expect(wrapper.findComponent(SaveBar).props('disabled')).toBe(false)
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(JSON.parse(String(vi.mocked(api).mock.calls[1][1]!.body))).toEqual({
      values: { chatTriggerMode: 'smart' },
      secrets: {},
      revision: 'r1'
    })
  })
})
