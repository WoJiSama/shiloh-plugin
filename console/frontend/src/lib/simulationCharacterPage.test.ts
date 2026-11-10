import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton } from 'naive-ui'
import SimulationPage from '../pages/SimulationPage.vue'
import { api } from './api'

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => ({
  ...await vi.importActual<typeof import('naive-ui')>('naive-ui'), useDialog: () => ({ warning })
}))
let wrapper: VueWrapper
let row: any
const clone = (value: any) => JSON.parse(JSON.stringify(value))
beforeEach(() => {
  vi.mocked(api).mockReset()
  warning.mockReset()
  row = {
    groupId: '10086', active: true, running: false, mode: 'diving', unreadCount: 0,
    budget: { turns: 1, maxTurnsPerDay: 40, tokens: 10, dailyCostCny: 5, todayCostCny: 0.01 },
    lastWakeReason: null, historyLength: 1, pendingEvents: [], memes: [], affinity: [], initialPrompt: '',
    activities: {
      works: [{ id: 'w1', title: '地图研究笔记', kind: 'research', status: 'draft', updatedAt: 1794170000000, versions: [
        { revision: 1, content: '<img src=x onerror="window.__unsafe=1">第一版草稿', evidenceRefs: ['memory:m1'], createdAt: 1794160000000 },
        { revision: 2, content: '第二版研究内容', evidenceRefs: ['memory:m1'], createdAt: 1794170000000 }
      ] }],
      subscriptions: [{ id: 'sub1', title: '游戏更新', kind: 'rss', status: 'active', url: 'https://example.org/feed', nextPollAt: 1794171000000, failures: 1, items: [{ id: 'item1', title: '地图更新', summary: '<script>不可信订阅内容</script>', receivedAt: 1794170000000 }] }],
      reflection: { lastRunAt: 1794170000000, nextRunAt: 1794171000000, lastOutcome: '基于新资料修正了观点', runsToday: 1 },
      shared: [{ id: 's1', content: '喜欢先研究玩法', kind: 'interest', createdAt: 1794170000000 }],
      sharedPending: [{ id: 'p1', content: '对地图设计有兴趣', kind: 'interest', sourceMemoryId: 'm1', createdAt: 1794170000000 }],
      capabilities: [{ name: '作品空间', description: '保存和修改草稿', available: true }, { name: '外部工作器', description: '受限任务接口', available: false }]
    },
    character: {
      scope: { botId: 'bot-1', personaId: 'persona-1', groupId: '10086' }, paused: false,
      decision: { kind: 'unwilling', reason: '想先把手头这张图画完', at: 1794170000000 },
      memories: [{ id: 'm1', kind: 'opinion', content: '先把机制弄懂再推荐游戏', epistemic: 'inferred', evidenceRefs: ['message:1'], createdAt: 1794170000000, updatedAt: 1794170000000 }],
      goals: [
        { id: 'g1', title: '研究游戏机制', motivation: '上次推荐弄错了', nextStep: '查原始说明', completionCriteria: '查清计分规则', status: 'waiting', nextCheckAt: 1794171000000, expiresAt: 1794770000000, attempts: 1, maxAttempts: 3 },
        { id: 'g2', title: '已经完成的目标', motivation: '做张图', nextStep: '', completionCriteria: '完成图片', status: 'completed', nextCheckAt: 0, expiresAt: 1794770000000, attempts: 1, maxAttempts: 3 }
      ],
      receipts: [{ id: 'r1', toolName: 'searchInformationTool', status: 'unknown', summary: '上次查询结果未确认', at: 1794170000000 }]
    }
  }
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/api/simulation/overview') return { enabled: true, allGroups: false, disabled: [], budgetDefaultCny: 5, groups: [clone(row)] }
    if (options?.method === 'POST') {
      const payload = JSON.parse(String(options.body))
      if (payload.operation === 'pause') row.character.paused = true
      if (payload.operation === 'resume') row.character.paused = false
      if (payload.operation === 'cancel-goal') row.character.goals.find((g: any) => g.id === payload.id).status = 'abandoned'
      if (payload.operation === 'delete-memory') row.character.memories = []
      if (payload.operation === 'subscription-pause') row.activities.subscriptions[0].status = 'paused'
      if (payload.operation === 'subscription-resume') row.activities.subscriptions[0].status = 'active'
      if (payload.operation === 'work-archive') row.activities.works[0].status = 'archived'
      if (payload.operation === 'work-delete') row.activities.works = []
      if (payload.operation === 'shared-approve') {
        row.activities.shared.push({ id: 'approved1', content: row.activities.sharedPending[0].content, kind: 'interest', createdAt: 1794170000000 })
        row.activities.sharedPending = []
      }
      if (payload.operation === 'shared-delete') row.activities.shared = row.activities.shared.filter((entry: any) => entry.id !== payload.id)
      return { message: '已更新角色状态' }
    }
    return clone(row)
  })
  wrapper = mount(SimulationPage, { attachTo: document.body })
})
afterEach(() => { wrapper.unmount(); document.body.innerHTML = '' })
function button(text: string) {
  return wrapper.findAllComponents(NButton).find(item => item.text() === text)!
}
async function open() {
  await flushPromises()
  await button('详情').trigger('click')
  await flushPromises()
}
function mutations() {
  return vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST').map(([, options]) => JSON.parse(String(options!.body)))
}

describe('character controls in simulation detail', () => {
  it('shows decisions, provenance and uncertain outcomes without presenting plans as success', async () => {
    await open()
    const content = document.querySelector('[aria-label="角色与自主目标"]')!.textContent!
    expect(content).toContain('bot-1')
    expect(content).toContain('persona-1')
    expect(content).toContain('不愿意')
    expect(content).toContain('想先把手头这张图画完')
    expect(content).toContain('暂时判断')
    expect(content).toContain('1 条依据')
    expect(content).toContain('结果未知')
    expect(content).toContain('已尝试 1/3 次')
    expect(wrapper.findAllComponents(NButton).filter(item => item.text() === '取消目标')).toHaveLength(1)
  })
  it('sends pause, resume and cancellation to the displayed group and record', async () => {
    await open()
    await button('暂停自主行动').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('自主行动已暂停')
    await button('恢复自主行动').trigger('click')
    await flushPromises()
    await button('取消目标').trigger('click')
    await flushPromises()
    expect(mutations()).toEqual([
      { group: '10086', action: 'character', operation: 'pause' },
      { group: '10086', action: 'character', operation: 'resume' },
      { group: '10086', action: 'character', operation: 'cancel-goal', id: 'g1' }
    ])
    expect(document.body.textContent).toContain('已放弃')
    expect(document.body.textContent).toContain('已更新角色状态')
  })
  it('confirms memory deletion and keeps a failed control visible', async () => {
    await open()
    await button('删除记忆').trigger('click')
    expect(mutations()).toEqual([])
    await warning.mock.calls[0]![0].onPositiveClick()
    await flushPromises()
    expect(mutations()).toEqual([{ group: '10086', action: 'character', operation: 'delete-memory', id: 'm1' }])
    expect(document.body.textContent).toContain('还没有带来源的角色记忆')
    vi.mocked(api).mockRejectedValueOnce(new Error('角色存储暂时不可用'))
    await button('暂停自主行动').trigger('click')
    await flushPromises()
    expect(document.querySelector('[role="status"]')!.textContent).toContain('角色存储暂时不可用')
    expect(button('暂停自主行动').exists()).toBe(true)
  })
})

describe('character activities in simulation detail', () => {
  it('renders versions and subscription content as plain text with reflection and capability status', async () => {
    await open()
    const content = document.querySelector('[aria-label="角色活动与作品"]')!
    expect(content.textContent).toContain('地图研究笔记')
    expect(content.textContent).toContain('第一版草稿')
    expect(content.textContent).toContain('<img src=x')
    expect(content.querySelector('img')).toBeNull()
    expect(content.querySelector('script')).toBeNull()
    expect(content.textContent).toContain('连续失败 1 次')
    expect(content.textContent).toContain('基于新资料修正了观点')
    expect(content.textContent).toContain('外部工作器')
    expect(content.textContent).toContain('未接入')
    expect(content.textContent).not.toContain('sourceMemoryId')
  })
  it('dispatches restore, archive, subscription and reflection operations without resetting the group', async () => {
    await open()
    await button('恢复此版本').trigger('click')
    await flushPromises()
    await button('归档作品').trigger('click')
    await flushPromises()
    await button('暂停订阅').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('已暂停')
    await button('恢复订阅').trigger('click')
    await flushPromises()
    await button('重置反思调度').trigger('click')
    await flushPromises()
    expect(mutations()).toEqual([
      { group: '10086', action: 'activity', operation: 'work-restore', id: 'w1', payload: { revision: 1 } },
      { group: '10086', action: 'activity', operation: 'work-archive', id: 'w1' },
      { group: '10086', action: 'activity', operation: 'subscription-pause', id: 'sub1' },
      { group: '10086', action: 'activity', operation: 'subscription-resume', id: 'sub1' },
      { group: '10086', action: 'activity', operation: 'reflection-reset' }
    ])
  })
  it('requires confirmation for sharing and destructive operations, and exposes failed activity requests', async () => {
    await open()
    await button('批准共享').trigger('click')
    expect(mutations()).toEqual([])
    await warning.mock.calls[0]![0].onPositiveClick()
    await flushPromises()
    expect(mutations()[0]).toEqual({ group: '10086', action: 'activity', operation: 'shared-approve', id: 'p1' })
    expect(document.body.textContent).not.toContain('批准共享')
    await button('删除作品').trigger('click')
    expect(mutations()).toHaveLength(1)
    await warning.mock.calls[1]![0].onPositiveClick()
    await flushPromises()
    expect(document.body.textContent).toContain('还没有作品')
    vi.mocked(api).mockRejectedValueOnce(new Error('订阅存储暂不可用'))
    await button('暂停订阅').trigger('click')
    await flushPromises()
    expect(document.querySelector('[aria-label="角色活动与作品"] [role="status"]')!.textContent).toContain('订阅存储暂不可用')
    expect(button('暂停订阅').exists()).toBe(true)
  })
})
