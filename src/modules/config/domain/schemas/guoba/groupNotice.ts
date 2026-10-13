import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'
const schema: ConfigSchemaItem[] = [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "群通知"
  },
  {
    field: "groupNotice.enabled",
    label: "群通知总开关",
    component: "Switch",
    bottomHelpMessage: "控制入群欢迎和退群提示。只对下方启用群号生效"
  },
  {
    field: "groupNotice.enabledGroups",
    label: "默认文案启用群号",
    component: "GTags",
    bottomHelpMessage: "这些群使用下面的默认欢迎语/退群提示。需要每群不同文案时，用下方「每群独立配置」",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "groupNotice.welcomeEnabled",
    label: "入群欢迎",
    component: "Switch",
    bottomHelpMessage: "开启后，新成员入群时发送欢迎语"
  },
  {
    field: "groupNotice.leaveEnabled",
    label: "退群提示",
    component: "Switch",
    bottomHelpMessage: "开启后，成员退群时发送提示"
  },
  {
    field: "groupNotice.suppressWelcomeWhenGroupGuardEnabled",
    label: "入群验证时不重复欢迎",
    component: "Switch",
    bottomHelpMessage: "同一群已开启入群验证时，欢迎语默认不再额外发送，避免和验证提示重复"
  },
  {
    field: "groupNotice.welcomeMessage",
    label: "欢迎语",
    component: "InputTextArea",
    bottomHelpMessage: "支持变量：{at}、{userId}、{nickname}、{card}、{displayName}、{groupId}、{groupName}"
  },
  {
    field: "groupNotice.leaveMessage",
    label: "退群提示语",
    component: "InputTextArea",
    bottomHelpMessage: "支持变量：{at}、{userId}、{nickname}、{card}、{displayName}、{groupId}、{groupName}"
  },
  {
    component: "Divider",
    label: "每群独立配置"
  },
  {
    field: "groupNotice.groupRules",
    label: "群规则",
    component: "GSubForm",
    componentProps: {
      multiple: true,
      modalProps: { title: "群通知规则" },
      schemas: [
        {
          field: "groupId",
          label: "群号",
          component: "Input",
          required: true,
          componentProps: { placeholder: "例如 123456789" }
        },
        {
          field: "welcomeMessage",
          label: "本群欢迎语",
          component: "InputTextArea",
          componentProps: { placeholder: "留空则使用默认欢迎语" }
        },
        {
          field: "leaveMessage",
          label: "本群退群提示语",
          component: "InputTextArea",
          componentProps: { placeholder: "留空则使用默认退群提示语" }
        }
      ]
    },
    bottomHelpMessage: "添加后该群会启用群通知，并优先使用本群文案；留空字段会回退到默认文案"
  }
]

export default schema
