import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton, NInput } from 'naive-ui'
import DrawPage from '../pages/DrawPage.vue'
import { api } from './api'

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('./api', () => ({
  api: vi.fn(),
  imageUrl: (path: string) => path,
  ApiError: class extends Error {}
}))
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }),
    useDialog: () => ({ warning })
  }
})

interface Pending {
  signal: AbortSignal
  complete: (value: unknown) => void
}
let wrapper: VueWrapper | null = null
let jobs: Pending[]
let completeCancel: ((value: unknown) => void) | null
const generated = { provider: 'fixture-image', count: 0, tookMs: 100, images: [], attempts: [] }

beforeEach(() => {
  jobs = []
  completeCancel = null
  warning.mockReset()
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((path, options = {}) => {
    if (path === '/api/image/providers') return Promise.resolve({ generation: [], edit: [] })
    if (path === '/api/image/history') return Promise.resolve([])
    if (path === '/api/image/generate')
      return new Promise((resolve) => {
        jobs.push({ signal: options.signal as AbortSignal, complete: resolve })
      })
    if (path === '/api/image/cancel')
      return new Promise((resolve) => {
        completeCancel = resolve
      })
    return Promise.resolve({})
  })
  wrapper = mount(DrawPage)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})
function generateButton() {
  return wrapper!.findAllComponents(NButton).find((button) => button.props('size') === 'large')!
}
function cancelButton() {
  return wrapper!.findAllComponents(NButton).find((button) => button.text() === '取消任务')!
}
async function start() {
  await flushPromises()
  wrapper!.findAllComponents(NInput)[0].vm.$emit('update:value', 'A quiet lake at sunset')
  await flushPromises()
  generateButton().vm.$emit('click')
  await flushPromises()
}

describe('image cancellation ownership', () => {
  it('blocks starting another image while cancellation is pending even if the previous image has completed', async () => {
    await start()
    expect(jobs).toHaveLength(1)
    cancelButton().vm.$emit('click')
    await flushPromises()
    const pendingCancel = warning.mock.calls[0][0].onPositiveClick()
    await flushPromises()
    expect(completeCancel).not.toBeNull()

    jobs[0].complete(generated)
    await flushPromises()
    expect(generateButton().props('loading')).toBe(false)
    expect(generateButton().props('disabled')).toBe(true)
    // Force the click handler to verify the method guard, in addition to the disabled UI.
    generateButton().vm.$emit('click')
    await flushPromises()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].signal.aborted).toBe(false)

    completeCancel!({ ok: true, cancelled: 1 })
    await pendingCancel
    await flushPromises()
    expect(jobs[0].signal.aborted).toBe(true)
    expect(generateButton().props('disabled')).toBe(false)
    generateButton().vm.$emit('click')
    await flushPromises()
    expect(jobs).toHaveLength(2)
    expect(jobs[1].signal.aborted).toBe(false)
    jobs[1].complete(generated)
    await flushPromises()
  })

  it('ignores an old cancellation dialog after its image completes and another image starts', async () => {
    await start()
    cancelButton().vm.$emit('click')
    await flushPromises()
    const oldConfirmation = warning.mock.calls[0][0]
    jobs[0].complete(generated)
    await flushPromises()
    generateButton().vm.$emit('click')
    await flushPromises()
    expect(jobs).toHaveLength(2)

    await oldConfirmation.onPositiveClick()
    await flushPromises()
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/api/image/cancel')).toHaveLength(
      0
    )
    expect(jobs[1].signal.aborted).toBe(false)
    expect(generateButton().props('loading')).toBe(true)
    jobs[1].complete(generated)
    await flushPromises()
  })
})
