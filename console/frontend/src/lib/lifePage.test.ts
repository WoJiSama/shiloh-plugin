import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton, NInputNumber } from 'naive-ui'
import LifePage from '../pages/LifePage.vue'
import { api } from './api'

const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => ({
  ...await vi.importActual<typeof import('naive-ui')>('naive-ui'), useMessage: () => ({ success, error })
}))
let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); vi.mocked(api).mockReset(); success.mockReset(); error.mockReset() })
const overview = (setBy?: string) => ({
  rhythm: { sleepFrom: 1, sleepTo: 8, ...(setBy ? { setBy } : {}) },
  now: { hour: 4, sleeping: true },
  threads: ['10086', '20086'].map(groupId => ({
    groupId, title: '同一部作品', status: 'active', lastEpisode: 3,
    notes: ['〔官方〕第3集已更新'], kind: 'anime', addedAt: 1, lastSyncAt: 2
  }))
})

describe('life overview scope and evidence', () => {
  it('shows default hours and keeps the same work from different groups distinct', async () => {
    vi.mocked(api).mockResolvedValue(overview('admin'))
    wrapper = mount(LifePage)
    await flushPromises()
    expect(wrapper.text()).toContain('默认窗口内')
    expect(wrapper.text()).toContain('管理员默认')
    expect(wrapper.text()).toContain('不代表所有角色此刻都在睡眠')
    const threads = wrapper.findAll('.thread-card')
    expect(threads).toHaveLength(2)
    expect(threads[0]!.text()).toContain('群 10086')
    expect(threads[1]!.text()).toContain('群 20086')
    expect(threads[0]!.text()).toContain('更新至 3 集')
    expect(wrapper.text()).not.toContain('看到第')
    expect(wrapper.text()).not.toContain('AI 自设')
  })
  it('saves the administrator default and reloads the aggregate view', async () => {
    vi.mocked(api).mockImplementation(async (path, options) => options?.method === 'POST' ? { message: '默认作息已更新' } : overview())
    wrapper = mount(LifePage)
    await flushPromises()
    expect(wrapper.text()).toContain('配置默认')
    wrapper.findAllComponents(NInputNumber)[0]!.vm.$emit('update:value', 2)
    wrapper.findAllComponents(NInputNumber)[1]!.vm.$emit('update:value', 9)
    await wrapper.findAllComponents(NButton).find(button => button.text() === '保存')!.trigger('click')
    await flushPromises()
    expect(JSON.parse(String(vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')![1]!.body))).toEqual({ sleepFrom: 2, sleepTo: 9 })
    expect(success).toHaveBeenCalledWith('默认作息已更新')
    expect(vi.mocked(api).mock.calls.at(-1)![0]).toBe('/api/life/overview')
  })
})
