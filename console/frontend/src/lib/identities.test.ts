import { afterEach, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { NInput } from 'naive-ui'
import IdentityLabel from '../components/IdentityLabel.vue'
import SchemaField from '../components/SchemaField.vue'
import { identities, clearIdentities, botLabel, groupLabel } from './identities'

afterEach(clearIdentities)
it('updates names already on screen, retains full IDs and safely renders arbitrary nicknames', async () => {
  const label = mount(IdentityLabel, { props: { kind: 'bot', id: '100001' } })
  expect(label.text()).toContain('昵称未获取')
  identities.value = {
    bots: [{ id: '100001', name: '<img src=x onerror=alert(1)>' }],
    groups: [{ id: '200002', name: '桌游群' }]
  }
  await nextTick()
  expect(label.text()).toContain('<img src=x onerror=alert(1)>')
  expect(label.find('img').exists()).toBe(false)
  expect(label.find('.identity-id').text()).toBe('100001')
  expect(botLabel('100001')).toContain('<img')
  expect(groupLabel('200002')).toBe('200002 · 桌游群')
  expect(groupLabel('300003')).toBe('300003 · 群名未获取')
  label.unmount()
})
it('adds group name hints to editable IDs while emitting only the raw value', async () => {
  identities.value = { bots: [], groups: [{ id: '100001', name: '桌游群' }] }
  const field = mount(SchemaField, {
    props: {
      field: { field: 'groupProfiles-0-groupId', label: '群号', component: 'Input' },
      modelValue: '100001'
    }
  })
  expect(field.find('.identity-hints').text()).toContain('桌游群')
  expect(field.find('input').element.value).toBe('100001')
  field.findComponent(NInput).vm.$emit('update:value', '200002')
  expect(field.emitted('update:modelValue')).toEqual([['200002']])
  await field.setProps({
    field: { field: 'userProfiles-0-qq', label: '用户 QQ', component: 'Input' }
  })
  expect(field.find('.identity-hints').exists()).toBe(false)
  field.unmount()
})
