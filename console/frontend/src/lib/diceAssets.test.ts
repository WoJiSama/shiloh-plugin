import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton, NInput } from 'naive-ui'
import DiceAssets from '../components/DiceAssets.vue'
import { api } from './api'

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => ({
  ...(await vi.importActual('naive-ui')),
  useDialog: () => ({ warning })
}))
let wrapper: VueWrapper | null = null
const emptyData = {
  templates: {},
  checkLevels: {},
  insanityTables: { temp: [], indefinite: [] },
  jrrpComments: [],
  builtin: [],
  checkLevelMeta: [],
  packs: [],
  decks: []
}
beforeEach(() => {
  vi.mocked(api).mockReset()
  warning.mockReset()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})
function button(text: string) {
  return wrapper!.findAllComponents(NButton).find((item) => item.text() === text)!
}
async function queue(name: string) {
  const inputs = wrapper!.findAllComponents(NInput)
  inputs[0].vm.$emit('update:value', name)
  inputs[1].vm.$emit('update:value', 'rules: []')
  await flushPromises()
  button('加入导入队列').vm.$emit('click')
  await flushPromises()
}

describe('rule import confirmation', () => {
  it('invalidates an earlier receipt when a newer precheck has the same package identity', async () => {
    let completeSecond!: (value: unknown) => void
    let uploads = 0
    vi.mocked(api).mockImplementation((path) => {
      if (path.endsWith('dice-data')) return Promise.resolve(emptyData)
      if (path.includes('/upload?')) {
        uploads++
        if (uploads === 1)
          return Promise.resolve({
            ok: true,
            kind: 'rule',
            packId: 'same-rule',
            packName: 'Same',
            stageId: 'stage-old',
            report: 'old report',
            staged: true
          })
        return new Promise((resolve) => {
          completeSecond = resolve
        })
      }
      return Promise.resolve({ ok: true, message: 'confirmed' })
    })
    wrapper = mount(DiceAssets)
    await flushPromises()
    await queue('first.yaml')
    button('导入待处理文件').vm.$emit('click')
    await flushPromises()
    button('确认导入 Same').vm.$emit('click')
    await flushPromises()
    const oldConfirmation = warning.mock.calls[0][0]
    await queue('second.yaml')
    button('导入待处理文件').vm.$emit('click')
    await flushPromises()
    expect(button('确认导入 Same').props('disabled')).toBe(true)
    await oldConfirmation.onPositiveClick()
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith('rule-confirm'))).toBe(false)
    completeSecond({
      ok: true,
      kind: 'rule',
      packId: 'same-rule',
      packName: 'Same',
      stageId: 'stage-new',
      report: 'new report',
      staged: true
    })
    await flushPromises()
    expect(wrapper.text()).toContain('暂存已被「second.yaml」的新预检替换')
    expect(
      wrapper.findAllComponents(NButton).filter((item) => item.text() === '确认导入 Same')
    ).toHaveLength(1)
    await oldConfirmation.onPositiveClick()
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith('rule-confirm'))).toBe(false)
    button('确认导入 Same').vm.$emit('click')
    await flushPromises()
    await warning.mock.calls[1][0].onPositiveClick()
    expect(
      vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('rule-confirm'))
    ).toHaveLength(1)
    const confirmationRequest = vi
      .mocked(api)
      .mock.calls.find(([path]) => path.endsWith('rule-confirm'))!
    expect(JSON.parse(String(confirmationRequest[1]?.body))).toEqual({
      id: 'same-rule',
      stageId: 'stage-new'
    })
  })
})
