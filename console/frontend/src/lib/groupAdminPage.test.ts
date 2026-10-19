import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, RouterView, type Router } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton, NDrawer, NSwitch, NTabs } from 'naive-ui'
import GroupAdminPage from '../pages/GroupAdminPage.vue'
import GroupsPage from '../pages/GroupsPage.vue'
import SchemaField from '../components/SchemaField.vue'
import SaveBar from '../components/SaveBar.vue'
import { confirmLeave, installUnsavedDialog } from '../composables/useUnsavedGuard'
import { api } from './api'
import { clone } from './schemaState'
import {
  groupAdminInitial,
  groupAdminPayload,
  resetGroupAdminField,
  type GroupAdminView
} from './groupAdminState'

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return {
    ...actual,
    useDialog: () => ({ warning }),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() })
  }
})
const fixture: GroupAdminView = {
  key: 'groupAdmin',
  title: '群管理',
  groupId: '123456',
  revision: 'r1',
  groups: [
    {
      label: '入群审核',
      fields: [
        {
          field: 'groupGuard.enabled',
          label: '本群入群验证',
          component: 'Switch',
          value: true,
          inheritance: 'custom',
          defaultValue: false,
          inheritedValue: false
        },
        {
          field: 'groupGuard.timeoutSeconds',
          label: '答题超时',
          component: 'InputNumber',
          props: { min: 30, max: 3600, step: 30 },
          value: 300,
          inheritance: 'default',
          defaultValue: 300,
          inheritedValue: 300
        },
        {
          field: 'groupGuard.maxWrongTimes',
          label: '错误次数',
          component: 'InputNumber',
          props: { min: 1, max: 5 },
          value: 1,
          inheritance: 'default',
          defaultValue: 1,
          inheritedValue: 1
        }
      ]
    },
    {
      label: '广告扫描',
      fields: [
        {
          field: 'groupModeration.enabled',
          label: '本群广告扫描',
          component: 'Switch',
          value: false,
          inheritance: 'default',
          defaultValue: false,
          inheritedValue: false
        },
        {
          field: 'groupModeration.admins',
          label: '本群通知 QQ',
          component: 'GTags',
          value: ['10001'],
          inheritance: 'legacy',
          defaultValue: [],
          inheritedValue: ['10001']
        }
      ]
    },
    {
      label: '超长消息折叠',
      fields: [
        {
          field: 'groupModeration.overlongMessage.maxLength',
          label: '超长判定字数',
          component: 'InputNumber',
          props: { min: 100, max: 20000, step: 50 },
          value: 1500,
          inheritance: 'default',
          defaultValue: 1500,
          inheritedValue: 1500
        }
      ]
    },
    {
      label: '群通知',
      fields: [
        {
          field: 'groupNotice.enabled',
          label: '本群群通知',
          component: 'Switch',
          value: true,
          inheritance: 'custom',
          defaultValue: false,
          inheritedValue: false
        },
        {
          field: 'groupNotice.welcomeMessage',
          label: '欢迎语',
          component: 'InputTextArea',
          value: '旧群欢迎',
          inheritance: 'legacy',
          defaultValue: '欢迎加入',
          inheritedValue: '旧群欢迎'
        }
      ]
    }
  ]
}
const groups = {
  groups: [
    {
      id: '123456',
      name: '测试群',
      whitelisted: true,
      today: { recv: 0, send: 0 },
      bots: [],
      groupAdmin: { groupGuard: false, groupModeration: false, groupNotice: true, customized: true }
    },
    {
      id: '654321',
      name: '另一个群',
      whitelisted: false,
      today: { recv: 1, send: 0 },
      bots: [],
      groupAdmin: {
        groupGuard: false,
        groupModeration: false,
        groupNotice: false,
        customized: false
      }
    }
  ]
}
let wrapper: VueWrapper | null
let router: Router
async function createPage(path = '/group-admin?group=123456') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/group-admin', component: GroupAdminPage },
      { path: '/groups', component: GroupsPage },
      { path: '/elsewhere', component: { template: '<div>Other page</div>' } },
      { path: '/conversation', component: { template: '<div>Conversation page</div>' } },
      { path: '/persona', component: { template: '<div>Persona page</div>' } }
    ]
  })
  router.beforeEach((to, from) => to.path === from.path || confirmLeave())
  await router.push(path)
  await router.isReady()
  wrapper = mount(
    defineComponent({
      setup() {
        installUnsavedDialog()
        return () => h(RouterView)
      }
    }),
    {
      global: { plugins: [router] },
      attachTo: document.body
    }
  )
  await flushPromises()
  return wrapper
}
function field(name: string) {
  return wrapper!.findAllComponents(SchemaField).find((item) => item.props('field').field === name)!
}
function enableSwitch(id: string) {
  return wrapper!.find(`section[data-module="${id}"]`).findComponent(NSwitch)
}
function button(text: string) {
  return wrapper!.findAllComponents(NButton).find((item) => item.text() === text)!
}
function switchTab(id: string) {
  wrapper!.findComponent(NTabs).vm.$emit('update:value', id)
  return flushPromises()
}
function resetButton(name: string) {
  return wrapper!
    .find(`[data-field="${name}"]`)
    .findAllComponents(NButton)
    .find((item: VueWrapper) => item.text() === '恢复默认')!
}
function putBody() {
  const call = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'PUT')!
  return JSON.parse(String(call[1]!.body))
}
beforeEach(() => {
  vi.mocked(api).mockReset()
  warning.mockReset()
  wrapper = null
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/groups') return clone(groups)
    if (path === '/api/config/groupAdmin') return clone(fixture)
    return { ...clone(fixture), groupId: path.split('/')[3] }
  })
})
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

describe('group administration draft lifecycle', () => {
  it('renders module tabs and bidirectional group links', async () => {
    await createPage()
    expect(wrapper!.findAll('.n-tabs-tab').map((tab) => tab.text())).toEqual([
      '入群验证',
      '广告与刷屏',
      '欢迎与退群'
    ])
    expect(wrapper!.find('a[href="/group-admin?scope=defaults"]').exists()).toBe(true)
    expect(wrapper!.find('a[href="/groups?group=123456"]').exists()).toBe(true)
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(300)
  })

  it('sends only edited values and explicit resets, including a custom value equal to its default', async () => {
    await createPage()
    wrapper!
      .find('[data-field="groupGuard.timeoutSeconds"]')
      .findComponent(NButton)
      .vm.$emit('click')
    enableSwitch('groupGuard').vm.$emit('update:value', false)
    await switchTab('groupModeration')
    resetButton('groupModeration.admins').vm.$emit('click')
    await flushPromises()
    vi.mocked(api).mockImplementationOnce(() => new Promise(() => {}))
    wrapper!.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(putBody()).toEqual({
      revision: 'r1',
      values: { 'groupGuard.enabled': false, 'groupGuard.timeoutSeconds': 300 },
      resets: ['groupModeration.admins']
    })
  })

  it('restores legacy and custom fields while keeping each module enable flag', async () => {
    await createPage()
    field('groupGuard.timeoutSeconds').vm.$emit('update:modelValue', 90)
    button('恢复本群默认').vm.$emit('click')
    warning.mock.calls[0][0].onPositiveClick()
    await flushPromises()
    expect(enableSwitch('groupGuard').props('value')).toBe(true)
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(300)
    expect(wrapper!.findComponent(SaveBar).props('dirty')).toBe(2)
    await switchTab('groupNotice')
    expect(field('groupNotice.welcomeMessage').props('modelValue')).toBe('欢迎加入')
    vi.mocked(api).mockImplementationOnce(() => new Promise(() => {}))
    wrapper!.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(putBody()).toEqual({
      revision: 'r1',
      values: {},
      resets: ['groupModeration.admins', 'groupNotice.welcomeMessage']
    })
  })

  it('switches sub-tabs inside a module and keeps hidden group drafts', async () => {
    await createPage()
    await switchTab('groupModeration')
    expect(wrapper!.findAll('.group-tab').map((tab) => tab.text())).toEqual([
      '广告扫描',
      '超长消息折叠'
    ])
    expect(
      wrapper!.findAllComponents(SchemaField).some((item) => item.props('field').field === 'groupModeration.overlongMessage.maxLength')
    ).toBe(false)
    await wrapper!.findAll('.group-tab')[1]!.trigger('click')
    expect(
      field('groupModeration.overlongMessage.maxLength').props('modelValue')
    ).toBe(1500)
    field('groupModeration.overlongMessage.maxLength').vm.$emit('update:modelValue', 800)
    await flushPromises()
    expect(wrapper!.findComponent(SaveBar).props('dirty')).toBe(1)
    expect(wrapper!.findAll('.group-tab')[1]!.text()).toContain('· 1')
    await wrapper!.findAll('.group-tab')[0]!.trigger('click')
    expect(
      wrapper!.findAllComponents(SchemaField).some((item) => item.props('field').field === 'groupModeration.overlongMessage.maxLength')
    ).toBe(false)
    await wrapper!.findAll('.group-tab')[1]!.trigger('click')
    expect(
      field('groupModeration.overlongMessage.maxLength').props('modelValue')
    ).toBe(800)
  })

  it('retains edits made during a save without resubmitting already saved values', async () => {
    await createPage()
    let complete!: (value: unknown) => void
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    field('groupGuard.timeoutSeconds').vm.$emit('update:modelValue', 90)
    await flushPromises()
    wrapper!.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    field('groupGuard.maxWrongTimes').vm.$emit('update:modelValue', 2)
    const next = clone(fixture)
    next.revision = 'r2'
    Object.assign(next.groups[0].fields[1], { value: 90, inheritance: 'custom' })
    complete({ ...next, changed: 1 })
    await flushPromises()
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(90)
    expect(field('groupGuard.maxWrongTimes').props('modelValue')).toBe(2)
    expect(wrapper!.findComponent(SaveBar).props('dirty')).toBe(1)
  })

  it('keeps a conflicting reset when refreshing server defaults and uses the new revision', async () => {
    await createPage()
    await switchTab('groupNotice')
    resetButton('groupNotice.welcomeMessage').vm.$emit('click')
    await flushPromises()
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error('配置冲突'), { status: 409 }))
    wrapper!.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(wrapper!.findComponent(SaveBar).props('disabled')).toBe(true)
    const next = clone(fixture)
    next.revision = 'r3'
    next.groups[3].fields[1].defaultValue = '新默认欢迎'
    vi.mocked(api).mockResolvedValueOnce(next)
    button('刷新并保留草稿').vm.$emit('click')
    await flushPromises()
    expect(field('groupNotice.welcomeMessage').props('modelValue')).toBe('新默认欢迎')
    expect(wrapper!.findComponent(SaveBar).props('dirty')).toBe(1)
    expect(wrapper!.findComponent(SaveBar).props('disabled')).toBe(false)
    vi.mocked(api).mockImplementationOnce(() => new Promise(() => {}))
    wrapper!.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    const puts = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'PUT')
    expect(JSON.parse(String(puts[1][1]!.body))).toEqual({
      revision: 'r3',
      values: {},
      resets: ['groupNotice.welcomeMessage']
    })
  })

  it('discards pre-refresh drafts while retaining new edits made during a group reload', async () => {
    await createPage()
    field('groupGuard.timeoutSeconds').vm.$emit('update:modelValue', 90)
    await flushPromises()
    button('刷新配置').vm.$emit('click')
    let complete!: (value: unknown) => void
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    void warning.mock.calls[0][0].onPositiveClick()
    await flushPromises()
    field('groupGuard.maxWrongTimes').vm.$emit('update:modelValue', 2)
    complete(clone(fixture))
    await flushPromises()
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(300)
    expect(field('groupGuard.maxWrongTimes').props('modelValue')).toBe(2)
    expect(wrapper!.findComponent(SaveBar).props('dirty')).toBe(1)
  })

  it('cancels switching groups without losing the draft and loads another group only after confirmation', async () => {
    await createPage()
    field('groupGuard.timeoutSeconds').vm.$emit('update:modelValue', 90)
    await flushPromises()
    let navigation = router.push('/group-admin?group=654321')
    await flushPromises()
    warning.mock.calls[0][0].onNegativeClick()
    await navigation
    expect(router.currentRoute.value.query.group).toBe('123456')
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(90)
    navigation = router.push('/group-admin?group=654321')
    await flushPromises()
    warning.mock.calls[1][0].onPositiveClick()
    await navigation
    await flushPromises()
    expect(router.currentRoute.value.query.group).toBe('654321')
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(300)
  })

  it('protects default-policy drafts when switching back to per-group configuration', async () => {
    await createPage('/group-admin?scope=defaults')
    field('groupGuard.timeoutSeconds').vm.$emit('update:modelValue', 90)
    await flushPromises()
    const navigation = router.push('/group-admin?group=123456')
    await flushPromises()
    warning.mock.calls[0][0].onNegativeClick()
    await navigation
    expect(router.currentRoute.value.query.scope).toBe('defaults')
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(90)
  })

  it('refreshes default policies while keeping edits made after the reload request begins', async () => {
    await createPage('/group-admin?scope=defaults')
    field('groupGuard.timeoutSeconds').vm.$emit('update:modelValue', 90)
    await flushPromises()
    button('刷新默认策略').vm.$emit('click')
    let complete!: (value: unknown) => void
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    void warning.mock.calls[0][0].onPositiveClick()
    await flushPromises()
    field('groupGuard.maxWrongTimes').vm.$emit('update:modelValue', 2)
    complete(clone(fixture))
    await flushPromises()
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(300)
    expect(field('groupGuard.maxWrongTimes').props('modelValue')).toBe(2)
    expect(wrapper!.findComponent(SaveBar).props('dirty')).toBe(1)
  })

  it('guards a default-policy save even when the last draft edit is reverted during the request', async () => {
    await createPage('/group-admin?scope=defaults')
    vi.mocked(api).mockImplementationOnce(() => new Promise(() => {}))
    field('groupGuard.timeoutSeconds').vm.$emit('update:modelValue', 90)
    await flushPromises()
    wrapper!.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    field('groupGuard.timeoutSeconds').vm.$emit('update:modelValue', 300)
    await flushPromises()
    expect(wrapper!.findComponent(SaveBar).props('dirty')).toBe(0)
    expect(wrapper!.findComponent(SaveBar).props('saving')).toBe(true)
    const navigation = router.push('/group-admin?group=123456')
    await flushPromises()
    warning.mock.calls[0][0].onNegativeClick()
    await navigation
    expect(router.currentRoute.value.query.scope).toBe('defaults')
    expect(wrapper!.findComponent(SaveBar).props('saving')).toBe(true)
  })

  it('aborts a prior group load and ignores its response after switching groups', async () => {
    let oldComplete!: (value: unknown) => void
    let oldSignal!: AbortSignal
    vi.mocked(api).mockImplementation((path, options = {}) => {
      if (path === '/api/groups') return Promise.resolve(clone(groups))
      if (path === '/api/groups/123456/admin')
        return new Promise((resolve) => {
          oldComplete = resolve
          oldSignal = options.signal as AbortSignal
        })
      return Promise.resolve({ ...clone(fixture), groupId: '654321' })
    })
    await createPage()
    await router.push('/group-admin?group=654321')
    await flushPromises()
    expect(oldSignal.aborted).toBe(true)
    const old = clone(fixture)
    old.groups[0].fields[1].value = 999
    oldComplete(old)
    await flushPromises()
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(300)
    expect(wrapper!.text()).toContain('另一个群')
  })

  it('aborts a departed save and does not apply its response to another group', async () => {
    await createPage()
    let complete!: (value: unknown) => void
    let signal!: AbortSignal
    vi.mocked(api).mockImplementationOnce(
      (_path, options = {}) =>
        new Promise((resolve) => {
          complete = resolve
          signal = options.signal as AbortSignal
        })
    )
    field('groupGuard.timeoutSeconds').vm.$emit('update:modelValue', 90)
    await flushPromises()
    wrapper!.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    const navigation = router.push('/group-admin?group=654321')
    await flushPromises()
    warning.mock.calls[0][0].onPositiveClick()
    await navigation
    await flushPromises()
    expect(signal.aborted).toBe(true)
    const next = clone(fixture)
    next.groups[0].fields[1].value = 90
    complete({ ...next, changed: 1 })
    await flushPromises()
    expect(field('groupGuard.timeoutSeconds').props('modelValue')).toBe(300)
    expect(wrapper!.findComponent(SaveBar).props('dirty')).toBe(0)
  })

  it('opens group details from the management return link and exposes the matching management link', async () => {
    await createPage('/groups?group=123456')
    expect(wrapper!.findComponent(NDrawer).props('show')).toBe(true)
    expect(wrapper!.find('a[href="/group-admin?group=123456"]').exists()).toBe(true)
    expect(
      wrapper!
        .findAllComponents(RouterLink)
        .some(
          (link) =>
            link.text() === '配置本群管理 →' && link.props('to') === '/group-admin?group=123456'
        )
    ).toBe(true)
    wrapper!.findComponent(NDrawer).vm.$emit('update:show', false)
    button('刷新群聊').vm.$emit('click')
    await flushPromises()
    expect(wrapper!.findComponent(NDrawer).props('show')).toBe(false)
  })
})

describe('group administration payload semantics', () => {
  it('treats matching an inherited value as an explicit custom override', () => {
    const baseline = groupAdminInitial(fixture)
    const draft = clone(baseline)
    draft['groupGuard.timeoutSeconds'].custom = true
    const fields = fixture.groups.flatMap((group) => group.fields)
    expect(groupAdminPayload(fields, draft, baseline, 'r1').values).toEqual({
      'groupGuard.timeoutSeconds': 300
    })
    draft['groupGuard.timeoutSeconds'] = resetGroupAdminField(fields[1])
    expect(groupAdminPayload(fields, draft, baseline, 'r1').resets).toEqual([])
    expect(groupAdminPayload(fields, draft, baseline, 'r1').values).toEqual({})
  })
})
