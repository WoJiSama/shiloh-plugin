import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton, NInput, NPagination } from 'naive-ui'
import SemanticPage from '../pages/SemanticPage.vue'
import { api } from './api'

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
    useDialog: () => ({ warning })
  }
})
let wrapper: VueWrapper
const item = { id: 'shared-id', text: 'remember this', messages: 2, recallCount: 0 }
beforeEach(() => {
  vi.mocked(api).mockReset()
  warning.mockReset()
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/stats'))
      return { enabled: true, store: { groups: 2, chunks: 42 }, config: {} }
    if (path.endsWith('/eval-history')) return { history: [] }
    if (path.includes('/playground?')) return { items: [{ ...item }] }
    if (path.includes('/chunks?')) return { chunks: [{ ...item }], total: 42 }
    return { ok: true, message: 'done' }
  })
  wrapper = mount(SemanticPage)
})
afterEach(() => wrapper.unmount())
async function setGroup(value: string) {
  wrapper.findAllComponents(NInput)[0]!.vm.$emit('update:value', value)
  await flushPromises()
}
async function search() {
  await flushPromises()
  await setGroup('100001')
  wrapper.findAllComponents(NInput)[1]!.vm.$emit('update:value', 'original query')
  await flushPromises()
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}
function button(label: string) {
  return wrapper.findAllComponents(NButton).find((button) => button.text() === label)!
}
describe('semantic result ownership', () => {
  it('keeps the confirmation bound to the original group even after another group is browsed', async () => {
    await search()
    await button('忘记').trigger('click')
    expect(warning.mock.calls[0][0].content).toContain('100001')
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await setGroup('200002')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    await warning.mock.calls[0][0].onPositiveClick()
    await flushPromises()
    const request = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/forget'))!
    expect(JSON.parse(String(request[1]!.body))).toEqual({ group: '100001', id: 'shared-id' })
    expect(wrapper.findAll('.memory-item')).toHaveLength(1)
  })
  it('refreshes reinforcement with the query that produced the displayed result', async () => {
    await search()
    await setGroup('200002')
    wrapper.findAllComponents(NInput)[1]!.vm.$emit('update:value', 'different query')
    await button('强化').trigger('click')
    await flushPromises()
    const calls = vi.mocked(api).mock.calls
    const request = calls.find(([path]) => path.endsWith('/reinforce'))!
    expect(JSON.parse(String(request[1]!.body)).group).toBe('100001')
    expect(calls.at(-1)![0]).toContain('group=100001&q=original%20query')
  })
  it('paginates the displayed group and resets a new browse to page one', async () => {
    await flushPromises()
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await setGroup('100001')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    await setGroup('200002')
    wrapper.findComponent(NPagination).vm.$emit('update:page', 2)
    await flushPromises()
    expect(vi.mocked(api).mock.calls.at(-1)![0]).toContain('group=100001&offset=20')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(vi.mocked(api).mock.calls.at(-1)![0]).toContain('group=200002&offset=0')
  })
  it('lets a newer search finish while an older reinforcement completes', async () => {
    await search()
    let completeAction!: (value: any) => void, completeSearch!: (value: any) => void
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeAction = resolve
        })
    )
    await button('强化').trigger('click')
    await flushPromises()
    await setGroup('200002')
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeSearch = resolve
        })
    )
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    const searchCount = vi
      .mocked(api)
      .mock.calls.filter(([path]) => path.includes('/playground?')).length
    completeAction({ ok: true })
    await flushPromises()
    expect(
      vi.mocked(api).mock.calls.filter(([path]) => path.includes('/playground?'))
    ).toHaveLength(searchCount)
    completeSearch({ items: [{ ...item, text: 'new group result' }] })
    await flushPromises()
    expect(wrapper.find('.memory-item').text()).toContain('new group result')
  })
})
