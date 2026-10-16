import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NTabs } from 'naive-ui'
import diceSchema from '../../../../src/modules/config/domain/schemas/shared/dice'
import trackingSchema from '../../../../src/modules/config/domain/schemas/shared/tracking'
import memorySchema from '../../../../src/modules/config/domain/schemas/shared/memory'
import type { ConfigSchemaItem } from '../../../../src/contracts/configSchema'
import SchemaPage from '../pages/SchemaPage.vue'
import ConversationPage from '../pages/ConversationPage.vue'
import SemanticPage from '../pages/SemanticPage.vue'
import CommandsPage from '../pages/CommandsPage.vue'
import SchemaField from '../components/SchemaField.vue'
import SaveBar from '../components/SaveBar.vue'
import { api } from './api'
import { clone, defaultValue, type SchemaFieldDefinition, type SchemaView } from './schemaState'
import { policySections, type PolicyKind } from './policySections'
import { hasUnsavedChanges } from '../composables/useUnsavedGuard'

vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
    useDialog: () => ({ warning: vi.fn() })
  }
})

function definition(item: ConfigSchemaItem): SchemaFieldDefinition {
  const props = item.componentProps
  return {
    field: item.field!,
    label: item.label!,
    component: item.component,
    props,
    required: item.required,
    help: item.bottomHelpMessage,
    subFields: props?.schemas?.map(definition),
    value:
      item.component === 'InputNumber'
        ? Number(props?.placeholder) || props?.min || 1
        : item.component === 'Select'
          ? props?.options?.[0]?.value
          : defaultValue(item.component)
  }
}
function view(kind: PolicyKind, schema: ConfigSchemaItem[]): SchemaView {
  const result: SchemaView = { key: kind, title: kind, revision: 'r1', groups: [] }
  let group = { label: kind as string, fields: [] as SchemaFieldDefinition[] }
  for (const item of schema) {
    if (['SOFT_GROUP_BEGIN', 'Divider'].includes(item.component)) {
      if (group.fields.length) result.groups.push(group)
      group = { label: item.label!, fields: [] }
    } else if (item.field) group.fields.push(definition(item))
  }
  if (group.fields.length) result.groups.push(group)
  return result
}
const fixtures = {
  dice: view('dice', diceSchema),
  tracking: view('tracking', trackingSchema),
  memory: view('memory', memorySchema)
}
const conversation: SchemaView = {
  key: 'conversation',
  title: '对话配置',
  revision: 'conversation-r1',
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
    }
  ]
}
const mounted: VueWrapper[] = []
function create(component: any, props?: Record<string, any>) {
  const wrapper = mount(component, { props, attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}
function field(wrapper: VueWrapper, key: string) {
  const found = wrapper
    .findAllComponents(SchemaField)
    .find((item) => item.props('field').field === key)
  expect(found, `field ${key} is reachable`).toBeTruthy()
  return found!
}
async function task(wrapper: VueWrapper, scope: string, label: string) {
  const button = wrapper
    .findAll(`[aria-label="${scope}"] button`)
    .find((item) => item.text().startsWith(label))!
  expect(button).toBeTruthy()
  await button.trigger('click')
  await flushPromises()
}
beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/config/conversation') return clone(conversation)
    for (const kind of ['dice', 'tracking', 'memory'] as const)
      if (path === `/api/config/${kind}`) return clone(fixtures[kind])
    if (path.endsWith('/stats')) return { enabled: false }
    if (path.endsWith('/eval-history')) return { history: [] }
    if (path.endsWith('/emoji-admission')) return { allow: [], reject: [] }
    if (path.endsWith('/data')) return { domains: [], commandCount: 0 }
    return {}
  })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
})

describe('migrated policy settings', () => {
  it.each([
    ['dice', 11],
    ['tracking', 55],
    ['memory', 35]
  ] as const)(
    'makes all %s fields reachable once, including advanced fields',
    async (kind, count) => {
      const fixture = fixtures[kind]
      const expected = fixture.groups.flatMap((group) => group.fields.map((field) => field.field))
      expect(expected).toHaveLength(count)
      expect(new Set(expected).size).toBe(count)
      const wrapper = create(SchemaPage, { kind })
      await flushPromises()
      const reached: string[] = []
      for (const section of policySections(kind, fixture.groups)) {
        wrapper.findComponent(NTabs).vm.$emit('update:value', section.id)
        await flushPromises()
        for (const header of wrapper.findAll('.n-collapse-item__header-main'))
          await header.trigger('click')
        await flushPromises()
        reached.push(
          ...wrapper
            .findAllComponents(SchemaField)
            .filter((item) => !item.props('field').field.includes('.schemas.'))
            .map((item) => item.props('field').field)
        )
      }
      expect(reached.sort()).toEqual(expected.sort())
      expect(api).toHaveBeenCalledWith(
        `/api/config/${kind}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    }
  )

  it('keeps newly added or renamed schema groups reachable', () => {
    for (const kind of ['tracking', 'memory'] as const) {
      const sections = policySections(kind, [
        {
          label: '将来新增的小节',
          fields: [{ field: 'future.setting', label: '新设置', component: 'Switch' }]
        }
      ])
      expect(sections).toHaveLength(1)
      expect(sections[0]!.id).toBe('other')
      expect(sections[0]!.groups[0]!.fields[0]!.field).toBe('future.setting')
    }
  })

  it('preserves independent conversation and tracking drafts while a tracking save completes on another tab', async () => {
    let completeSave!: (value: any) => void
    let saved = false
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (path === '/api/config/conversation') return clone(conversation)
      if (path === '/api/config/tracking' && options?.method === 'PUT')
        return new Promise((resolve) => {
          completeSave = resolve
        })
      const next = clone(fixtures.tracking)
      if (saved) next.groups[0]!.fields[0]!.value = true
      return next
    })
    const wrapper = create(ConversationPage)
    await flushPromises()
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(['/api/config/conversation'])
    field(wrapper, 'chatTriggerMode').vm.$emit('update:modelValue', 'smart')
    await task(wrapper, '对话设置任务分区', '对话追踪')
    field(wrapper, 'conversationTrackingEnabled').vm.$emit('update:modelValue', true)
    await flushPromises()
    const tracking = wrapper
      .findAllComponents(SchemaPage)
      .find((item) => item.props('kind') === 'tracking')!
    tracking.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    await task(wrapper, '对话设置任务分区', '对话配置')
    expect(field(wrapper, 'chatTriggerMode').props('modelValue')).toBe('smart')
    expect(tracking.findComponent(SaveBar).props('saving')).toBe(true)
    saved = true
    completeSave({ changed: 1 })
    await flushPromises()
    expect(tracking.findComponent(SaveBar).props('dirty')).toBe(0)
    expect(hasUnsavedChanges()).toBe(true)
    const request = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'PUT')!
    expect(JSON.parse(String(request[1]!.body))).toEqual({
      values: { conversationTrackingEnabled: true },
      secrets: {},
      revision: 'r1'
    })
    await task(wrapper, '对话设置任务分区', '对话追踪')
    expect(field(wrapper, 'conversationTrackingEnabled').props('modelValue')).toBe(true)
  })

  it('opens memory policy even when operational status fails, retaining drafts across task tabs', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.endsWith('/stats')) throw new Error('索引暂不可用')
      return clone(fixtures.memory)
    })
    const wrapper = create(SemanticPage)
    await flushPromises()
    await task(wrapper, '记忆任务分区', '记忆策略')
    expect(field(wrapper, 'memorySystem.enabled').exists()).toBe(true)
    field(wrapper, 'memorySystem.enabled').vm.$emit('update:modelValue', true)
    await task(wrapper, '记忆任务分区', '记忆运营')
    expect(wrapper.text()).toContain('索引暂不可用')
    await task(wrapper, '记忆任务分区', '记忆策略')
    expect(field(wrapper, 'memorySystem.enabled').props('modelValue')).toBe(true)
    expect(hasUnsavedChanges()).toBe(true)
    expect(
      vi.mocked(api).mock.calls.filter(([path]) => path === '/api/config/memory')
    ).toHaveLength(1)
  })

  it('separates dice basics from reply templates and only loads basic settings when opened', async () => {
    const wrapper = create(CommandsPage, undefined)
    await flushPromises()
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/api/config/dice')).toBe(false)
    await task(wrapper, '命令与骰子任务分区', '骰子基础')
    field(wrapper, 'diceSystem.allowHiddenRoll').vm.$emit('update:modelValue', true)
    await task(wrapper, '命令与骰子任务分区', '骰子回复')
    await task(wrapper, '命令与骰子任务分区', '骰子基础')
    expect(field(wrapper, 'diceSystem.allowHiddenRoll').props('modelValue')).toBe(true)
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/api/config/dice')).toHaveLength(
      1
    )
  })

  it('aborts an unfinished policy read when leaving and unregisters its draft guard', async () => {
    let signal!: AbortSignal
    let finish!: (value: SchemaView) => void
    vi.mocked(api).mockImplementationOnce((_path, options) => {
      signal = options!.signal as AbortSignal
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const wrapper = create(SchemaPage, { kind: 'tracking' })
    await flushPromises()
    wrapper.unmount()
    mounted.pop()
    expect(signal.aborted).toBe(true)
    finish(clone(fixtures.tracking))
    await flushPromises()
    expect(hasUnsavedChanges()).toBe(false)
  })
})
