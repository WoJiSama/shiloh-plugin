import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'
import guard from './groupGuard.js'
import notice from './groupNotice.js'

const extra: ConfigSchemaItem[] = [
  { component: 'Divider', label: '广告扫描高级设置' },
  { field: 'groupModeration.ignoredBotIds', label: '豁免机器人 QQ', component: 'GTags', bottomHelpMessage: '这些机器人不参与广告和刷屏检测。官方 Q 群管家已内置豁免。' },
  { field: 'groupModeration.whitelist', label: '白名单 QQ', component: 'GTags', bottomHelpMessage: '白名单成员的消息完全跳过群管检测（复合规则/连发/超长/刷屏/广告）。群内可用 .群管 白名单 添加/删除 <QQ> 维护。' },
  { field: 'groupModeration.evidenceMaxChars', label: '证据文字上限', component: 'InputNumber', componentProps: { min: 200, max: 5000, step: 1 } },
  { field: 'groupModeration.modelThreshold', label: '模型复核置信度', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.01 } },
  { field: 'groupModeration.floodConfidence', label: '刷屏命中置信度', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.01 } },
  { field: 'groupModeration.adCorpusAutoCollect', label: '自动收集广告样本', component: 'Switch', bottomHelpMessage: '确认命中的广告进入共享样本库；纯刷屏不入库。' },
  { field: 'groupModeration.adTemplates', label: '广告种子模板', component: 'GTags', bottomHelpMessage: '与群内 .广告入库 维护的共享样本共同参与检测；样本库仍使用原有群内命令维护。' }
]

// 只有模块级启用字段参与「总开关/在本群启用」的语义改写；
// 子功能开关（超长/连发折叠等）保留自己的标签和帮助文案
const MODULE_ENABLE_FIELDS = new Set(['groupGuard.enabled', 'groupModeration.enabled', 'groupNotice.enabled'])

const scopeFields = new Set(['groupGuard.enabledGroups', 'groupModeration.enabledGroups', 'groupModeration.groupAdmins', 'groupNotice.enabledGroups', 'groupNotice.groupRules'])
export const groupAdminDefaultSchema: ConfigSchemaItem[] = [...guard, ...extra, ...notice].filter(item => !item.field || !scopeFields.has(item.field)).map(item => {
  if (!item.field || !MODULE_ENABLE_FIELDS.has(item.field)) return item
  return { ...item, label: `${item.label?.replace(/总开关|开关/g, '')}默认启用`, bottomHelpMessage: '默认值：开启后未单独配置的群默认启用；单群可用「在本群启用」显式开启或关闭，优先于本默认' }
})

export const groupAdminGroupSchema: ConfigSchemaItem[] = groupAdminDefaultSchema.filter(item => item.field !== 'groupModeration.globalAdmins').map(item => {
  if (!item.field || !MODULE_ENABLE_FIELDS.has(item.field)) return item
  return { ...item, label: '在本群启用', bottomHelpMessage: '显式控制当前群，优先于默认策略：开着就生效（默认关也生效），关闭则不生效（默认开也不生效）' }
}).concat({
  component: 'Divider', label: '本群通知名单'
}, {
  field: 'groupModeration.admins', label: '本群通知 QQ', component: 'GTags',
  bottomHelpMessage: '与默认策略中的全局通知 QQ 合并，只有明确配置的人会收到通知；不会自动使用 QQ 群原生管理员。'
})

export default groupAdminDefaultSchema
