import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { api } from './api'
import { useAccountActions, useOpsResource } from './operations'

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => ({
  ...(await vi.importActual('naive-ui')),
  useDialog: () => ({ warning })
}))
const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.mocked(api).mockReset()
  warning.mockReset()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.useRealTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})

describe('operations request lifecycle', () => {
  it('aborts an unmounted page and ignores a slow response even when the transport resolves', async () => {
    let finish!: (value: string) => void
    let signal!: AbortSignal
    let resource!: ReturnType<typeof useOpsResource<string>>
    const wrapper = mount(
      defineComponent({
        setup() {
          resource = useOpsResource((requestSignal) => {
            signal = requestSignal
            return new Promise((resolve) => {
              finish = resolve
            })
          })
          return () => h('div')
        }
      })
    )
    wrappers.push(wrapper)
    await flushPromises()
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
    finish('stale')
    await flushPromises()
    expect(resource.data.value).toBeNull()
  })

  it('keeps the latest good result after refresh failure, and pauses polling while hidden', async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ count: 8 })
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValue({ count: 9 })
    let resource!: ReturnType<typeof useOpsResource<{ count: number }>>
    const wrapper = mount(
      defineComponent({
        setup() {
          resource = useOpsResource(fetcher, 30000)
          return () => h('div')
        }
      })
    )
    wrappers.push(wrapper)
    await vi.advanceTimersByTimeAsync(0)
    await resource.refresh()
    expect(resource.data.value).toEqual({ count: 8 })
    expect(resource.error.value).toBe('temporary outage')
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(resource.data.value).toEqual({ count: 9 })
    expect(resource.error.value).toBe('')
  })
})

describe('account operations', () => {
  it('requires confirmation, enforces the API limit, and suppresses duplicate submissions while busy', async () => {
    let finish!: (value: unknown) => void
    vi.mocked(api).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const refresh = vi.fn().mockResolvedValue(undefined)
    let actions!: ReturnType<typeof useAccountActions>
    const wrapper = mount(
      defineComponent({
        setup() {
          actions = useAccountActions(refresh, () => [
            { container: 'napcat', account: '100001', nickname: '主机器人' } as any
          ])
          return () => h('div')
        }
      })
    )
    wrappers.push(wrapper)
    actions.confirmAction(
      Array.from({ length: 11 }, (_, index) => `napcat-${index}`),
      'restart'
    )
    expect(actions.error.value).toContain('最多操作 10')
    expect(warning).not.toHaveBeenCalled()
    actions.confirmAction(['napcat'], 'restart')
    expect(api).not.toHaveBeenCalled()
    const confirmation = warning.mock.calls[0][0]
    expect(confirmation.content).toContain('100001 · 主机器人')
    const pending = confirmation.onPositiveClick()
    confirmation.onPositiveClick()
    actions.confirmAction(['napcat-10000'], 'stop')
    expect(api).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledTimes(1)
    finish({ results: [{ container: 'napcat-10000', ok: false, error: 'restart denied' }] })
    await pending
    expect(actions.hasFailures.value).toBe(true)
    expect(actions.results.value[0].error).toBe('restart denied')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(actions.busy.value).toBe(false)
  })
})
