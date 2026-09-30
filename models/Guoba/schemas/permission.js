export default [
  {
    field: "enableGroupWhitelist",
    label: "群聊白名单开关",
    component: "Switch",
    bottomHelpMessage: "建议开启防止滥用。关闭时所有群都可使用 AI 对话功能"
  },
  {
    field: "allowedGroups",
    label: "白名单群号",
    component: "GTags",
    bottomHelpMessage: "允许使用 AI 功能的群组 ID（按回车添加）",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "userBlacklist.enabled",
    label: "用户黑名单开关",
    component: "Switch",
    bottomHelpMessage: "开启后，黑名单 QQ 用户的消息会被静默忽略，不触发对话、工具、记忆或表达学习"
  },
  {
    field: "userBlacklist.users",
    label: "黑名单 QQ",
    component: "GTags",
    bottomHelpMessage: "需要屏蔽的 QQ 号（按回车添加）",
    componentProps: { allowAdd: true, allowDel: true }
  },
  { component: "Divider", label: "违禁词黑名单" },
  {
    field: "forbiddenWords.enabled",
    label: "违禁词开关",
    component: "Switch",
    bottomHelpMessage: "消息命中违禁词时立即中断该群当前对话，本条不回复、不进工具和学习"
  },
  {
    field: "forbiddenWords.words",
    label: "违禁词列表",
    component: "GTags",
    bottomHelpMessage: "支持 /正则/i 写法；也可在 QQ 里用 #加违禁词/#删违禁词 管理",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "forbiddenWords.replyText",
    label: "命中后提示语",
    component: "Input",
    componentProps: { placeholder: "留空=完全静默，可用 {personaName} 占位" }
  },
  {
    field: "forbiddenWords.blockOutput",
    label: "出站同样拦截",
    component: "Switch",
    bottomHelpMessage: "机器人自己要说的话含违禁词时拦截该条并中断本回合"
  }
]
