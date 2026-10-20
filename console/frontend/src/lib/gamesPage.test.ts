import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton, NInput, NInputNumber } from 'naive-ui'
import { compileStyle, parse } from '@vue/compiler-sfc'
import GamesPage from '../pages/GamesPage.vue'
import gamesPageSource from '../pages/GamesPage.vue?raw'
import { api } from './api'

vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return {
    ...actual,
    useDialog: () => ({ warning: vi.fn() }),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() })
  }
})
const domains = ['structure', 'playability', 'logic', 'simulation']
function makePuzzle() {
  return {
    id: 'p1',
    title: '晚归的人',
    difficulty: 'normal',
    tags: [],
    status: 'active',
    surface: '一个人每天晚归，今晚却提前到家。',
    solution: '固定真相',
    keyPoints: ['事实甲', '事实乙', '事实丙'],
    hints: ['方向', '原因', '核心'],
    ratingCount: 0,
    ratingAverage: null,
    plays: 0,
    createdAt: 1,
    manualScore: null as number | null,
    manualScoreReason: '',
    contentHash: 'hash-1',
    version: 1,
    eligible: true,
    audits: domains.map((domain) => ({
      domain,
      pass: true,
      reason: `原审核${domain}`,
      at: 1,
      contentHash: 'hash-1',
      holes: [] as string[]
    })),
    statusHistory: [],
    feedback: []
  }
}
function fixture() {
  return {
    puzzles: [makePuzzle()],
    sessions: [],
    generating: {
      id: '',
      kind: 'generate',
      running: false,
      total: 0,
      added: 0,
      failed: 0,
      skipped: 0,
      log: []
    },
    freshPoolTarget: 2,
    inventory: { fresh: 1, available: 1, pending: 0, retired: 0, needsAudit: 0 },
    diagnostics: {
      completed: 0,
      solved: 0,
      ratings: 0,
      averageQuestions: 0,
      averageHints: 0,
      feedbackCategories: {},
      endedBy: {}
    }
  }
}
let state: ReturnType<typeof fixture>
let candidateRows: unknown[]
let wrapper: VueWrapper | undefined
const requests: { path: string; options: RequestInit }[] = []
function button(text: string) {
  return wrapper!.findAllComponents(NButton).find((item) => item.text() === text)!
}
async function createPage() {
  wrapper = mount(GamesPage, {
    attachTo: document.body,
    global: {
      stubs: {
        SchemaPage: true,
        NModal: { props: ['show'], template: '<div v-if="show" class="test-modal"><slot /></div>' }
      }
    }
  })
  await flushPromises()
}
beforeEach(() => {
  state = fixture()
  candidateRows = []
  requests.length = 0
  vi.mocked(api).mockImplementation(async (path, options = {}) => {
    requests.push({ path, options })
    if (path.endsWith('/overview')) return structuredClone(state)
    if (path.endsWith('/candidates')) return { candidates: structuredClone(candidateRows) }
    if (path.endsWith('/audit')) {
      state.puzzles[0]!.status = 'pending'
      state.puzzles[0]!.eligible = false
      state.puzzles[0]!.audits.push({
        domain: 'logic',
        pass: false,
        reason: '时间线存在未解释的跳跃',
        holes: ['时间不符'],
        at: 2,
        contentHash: 'hash-1'
      })
      state.inventory.available = 0
      state.inventory.pending = 1
      return { eligible: false }
    }
    return { ok: true }
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})

describe('海龟汤运营闭环', () => {
  it('表格回调渲染的标题和操作区域应用组件布局样式', async () => {
    const { descriptor } = parse(gamesPageSource)
    const scopedStyle = descriptor.styles.find((style) => style.scoped)!
    const compiled = compileStyle({
      source: scopedStyle.content,
      filename: 'GamesPage.vue',
      id: (GamesPage as unknown as { __scopeId: string }).__scopeId,
      scoped: true
    })
    expect(compiled.errors).toEqual([])
    const style = document.createElement('style')
    style.textContent = compiled.code
    document.head.append(style)
    try {
      await createPage()
      expect(getComputedStyle(wrapper!.get('.soup-title').element).display).toBe('grid')
      expect(getComputedStyle(wrapper!.get('.soup-meta').element).fontSize).toBe('11px')
      expect(getComputedStyle(wrapper!.get('.soup-actions').element).display).toBe('flex')
    } finally {
      style.remove()
    }
  })

  it('重审后打开中的详情同步新结论并禁止直接投放', async () => {
    await createPage()
    // The first header row has no puzzle handler; select the visible body row.
    const row = wrapper!
      .findAll('.n-data-table-tr')
      .find((item) => item.text().includes('晚归的人'))!
    await row.trigger('click')
    await flushPromises()
    expect(document.body.textContent || '').toContain('原审核logic')
    await button('重新审核').trigger('click')
    await flushPromises()
    expect(document.body.textContent || '').toContain('时间线存在未解释的跳跃')
    expect(document.body.textContent || '').toContain('时间不符')
    expect(button('确认投放').props('disabled')).toBe(true)
    // 审核历史按版本分组,旧版结论保留可见(修复前也能看到)
  })

  it('低分必须附问题原因，提交后发送给评分API', async () => {
    await createPage()
    await wrapper!
      .findAll('.n-data-table-tr')
      .find((item) => item.text().includes('晚归的人'))!
      .trigger('click')
    await flushPromises()
    await button('评价并说明原因').trigger('click')
    await flushPromises()
    wrapper!.findAllComponents(NInputNumber).at(-1)!.vm.$emit('update:value', 2)
    await flushPromises()
    await button('保存').trigger('click')
    await flushPromises()
    expect(document.body.textContent || '').toContain('请填写原因或需要修复的问题')
    expect(requests.some((item) => item.path.endsWith('/score'))).toBe(false)
    wrapper!
      .findAllComponents(NInput)
      .find((input) => input.props('type') === 'textarea')!
      .vm.$emit('update:value', '提示没有给出可追问方向')
    await flushPromises()
    await button('保存').trigger('click')
    await flushPromises()
    const request = requests.find((item) => item.path.endsWith('/score'))!
    expect(JSON.parse(String(request.options.body))).toEqual({
      score: 2,
      reason: '提示没有给出可追问方向'
    })
  })

  it('失败候选保留版本和问题，提供继续重试入口', async () => {
    candidateRows = [
      {
        id: 'candidate-1',
        familyId: 'f1',
        status: 'failed',
        stage: 'logic',
        failureKind: 'technical',
        lastError: '模型响应超时',
        currentVersion: 1,
        updatedAt: 1,
        versions: [
          {
            version: 1,
            puzzle: makePuzzle(),
            issues: ['模型响应超时'],
            audits: [],
            contentHash: 'hash-1'
          }
        ]
      }
    ]
    await createPage()
    expect(document.body.textContent || '').toContain('候选回收区')
    expect(document.body.textContent || '').toContain('模型响应超时')
    expect(document.body.textContent || '').toContain('固定真相')
    await button('继续重试').trigger('click')
    await flushPromises()
    expect(
      requests.some(
        (item) =>
          item.path === '/api/games/turtle-soup/candidates/candidate-1/recover' &&
          item.options.method === 'POST'
      )
    ).toBe(true)
  })

  it('不可修复审核后即使发生技术故障，也不提供恢复入口', async () => {
    candidateRows = [
      {
        id: 'candidate-irreparable',
        familyId: 'f2',
        status: 'failed',
        stage: 'logic',
        failureKind: 'technical',
        lastError: '逻辑审核接口超时',
        currentVersion: 1,
        updatedAt: 1,
        versions: [
          {
            version: 1,
            puzzle: makePuzzle(),
            issues: ['核心因果无法成立'],
            audits: [
              {
                domain: 'playability',
                pass: false,
                repairable: false,
                reason: '核心因果无法成立',
                holes: ['核心因果无法成立'],
                at: 1,
                contentHash: 'hash-1'
              }
            ],
            contentHash: 'hash-1'
          }
        ]
      }
    ]
    await createPage()
    expect(document.body.textContent || '').toContain('核心因果无法成立')
    expect(document.body.textContent || '').toContain('逻辑审核接口超时')
    expect(button('继续重试')).toBeUndefined()
  })
})
