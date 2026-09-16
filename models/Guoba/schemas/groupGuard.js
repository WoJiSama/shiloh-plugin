export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "群管理模块"
  },
  {
    component: "Divider",
    label: "入群审核"
  },
  {
    field: "groupGuard.enabled",
    label: "入群审核开关",
    component: "Switch",
    bottomHelpMessage: "开启后，仅对下方群列表中的群生效；机器人必须是群主或管理员才会发起验证和踢人"
  },
  {
    field: "groupGuard.enabledGroups",
    label: "启用群号",
    component: "GTags",
    bottomHelpMessage: "需要入群验证的群组 ID（按回车添加）。为空时不对任何群生效",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "groupGuard.verifyInviteJoin",
    label: "验证邀请入群",
    component: "Switch",
    bottomHelpMessage: "开启后，通过邀请进群的用户也需要答题；关闭后只验证主动申请/普通入群事件"
  },
  {
    field: "groupGuard.timeoutSeconds",
    label: "答题超时（秒）",
    component: "InputNumber",
    bottomHelpMessage: "用户进群后必须在该时间内答对。默认 300 秒",
    componentProps: { min: 30, max: 3600, step: 30, placeholder: "300" }
  },
  {
    field: "groupGuard.questionMaxNumber",
    label: "题目数字范围",
    component: "InputNumber",
    bottomHelpMessage: "生成 0 到该数字范围内的加减法题。10 表示十以内加减法",
    componentProps: { min: 1, max: 100, step: 1, placeholder: "10" }
  },
  {
    field: "groupGuard.questionOperators",
    label: "题型",
    component: "GTags",
    bottomHelpMessage: "可填 add / sub，分别表示加法 / 减法。为空时默认加减法都启用",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "groupGuard.maxWrongTimes",
    label: "允许错误次数",
    component: "InputNumber",
    bottomHelpMessage: "达到该次数后按配置踢出。默认 1 次，即答错一次就踢",
    componentProps: { min: 1, max: 5, placeholder: "1" }
  },
  {
    field: "groupGuard.kickOnTimeout",
    label: "超时踢出",
    component: "Switch",
    bottomHelpMessage: "关闭后超时只取消验证，不踢人"
  },
  {
    field: "groupGuard.kickOnWrongAnswer",
    label: "答错踢出",
    component: "Switch",
    bottomHelpMessage: "关闭后答错达到次数只提示失败，不踢人"
  },
  {
    field: "groupGuard.promptTemplate",
    label: "验证提示",
    component: "InputTextArea",
    bottomHelpMessage: "支持变量：{at}、{userId}、{question}、{timeout}"
  },
  {
    field: "groupGuard.passMessage",
    label: "通过提示",
    component: "Input",
    bottomHelpMessage: "用户答对后的提示。留空则不发送"
  },
  {
    field: "groupGuard.retryMessage",
    label: "重试提示",
    component: "InputTextArea",
    bottomHelpMessage: "允许多次错误时，未达到上限的提示。支持变量：{at}、{userId}、{question}、{timeout}、{wrongTimes}、{maxWrongTimes}"
  },
  {
    field: "groupGuard.failMessage",
    label: "答错踢出提示",
    component: "InputTextArea",
    bottomHelpMessage: "答错达到上限后的提示。支持变量：{userId}、{question}"
  },
  {
    field: "groupGuard.timeoutMessage",
    label: "超时踢出提示",
    component: "InputTextArea",
    bottomHelpMessage: "超时后的提示。支持变量：{userId}、{question}、{timeout}"
  },
  {
    component: "Divider",
    label: "广告扫描"
  },
  {
    field: "groupModeration.enabled",
    label: "广告扫描开关",
    component: "Switch",
    bottomHelpMessage: "检测群内广告、外链和招募话术；机器人必须是该群管理员或群主"
  },
  {
    field: "groupModeration.enabledGroups",
    label: "启用群号",
    component: "GTags",
    bottomHelpMessage: "需要启用复合群管的群组 ID（按回车添加）。为空时不生效",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "groupModeration.globalAdmins",
    label: "全局通知 QQ",
    component: "GTags",
    bottomHelpMessage: "所有启用群都只向这些 QQ 通知或私发证据；不会自动读取 QQ 群管理员",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "groupModeration.groupAdmins",
    label: "每群通知 QQ",
    component: "GSubForm",
    bottomHelpMessage: "为不同群单独配置通知名单；只有这里和全局通知 QQ 中填写的人会收到通知",
    componentProps: {
      multiple: true,
      schemas: [
        { field: "groupId", label: "群号", component: "Input" },
        {
          field: "admins",
          label: "通知 QQ",
          component: "GTags",
          componentProps: { allowAdd: true, allowDel: true }
        }
      ]
    }
  },
  {
    field: "groupModeration.minActiveLevel",
    label: "低活跃等级阈值",
    component: "InputNumber",
    bottomHelpMessage: "默认检测群活跃等级小于等于 5 的成员",
    componentProps: { min: 0, max: 100, step: 1, placeholder: "5" }
  },
  {
    field: "groupModeration.inspectLowLevelOnly",
    label: "只检测低活跃成员",
    component: "Switch",
    bottomHelpMessage: "开启后，活跃等级高于阈值的普通成员不会进入广告检测"
  },
  {
    field: "groupModeration.publicReportEnabled",
    label: "群内提醒",
    component: "Switch",
    bottomHelpMessage: "命中报告阈值后在群内发自然语言提醒"
  },
  {
    field: "groupModeration.mentionConfiguredAdminsInGroup",
    label: "群内艾特通知名单",
    component: "Switch",
    bottomHelpMessage: "群内提醒时仅艾特上方填写的 QQ；不会艾特 QQ 群原生管理员，名单为空时只发送提醒文本"
  },
  {
    field: "groupModeration.forwardEvidenceToAdmins",
    label: "私聊证据给通知名单",
    component: "Switch",
    bottomHelpMessage: "命中后仅向上方填写的 QQ 私聊证据；不会私发给 QQ 群原生管理员"
  },
  {
    field: "groupModeration.modelReviewEnabled",
    label: "启用模型复核",
    component: "Switch",
    bottomHelpMessage: "开启后使用 toolsAiConfig 对疑似内容做语义复核，会增加模型调用量"
  },
  {
    field: "groupModeration.floodEnabled",
    label: "刷屏检测",
    component: "Switch",
    bottomHelpMessage: "低等级成员在时间窗内发送超过条数上限即命中「刷屏」规则；默认 10 秒内 8 条、等级≤5 生效"
  },
  {
    field: "groupModeration.floodMaxMessages",
    label: "刷屏条数上限",
    component: "InputNumber",
    bottomHelpMessage: "时间窗内发送达到该条数即命中，默认 8",
    componentProps: { min: 3, max: 100, placeholder: "8" }
  },
  {
    field: "groupModeration.floodWindowSeconds",
    label: "刷屏时间窗(秒)",
    component: "InputNumber",
    bottomHelpMessage: "滑动窗口长度，默认 10 秒",
    componentProps: { min: 3, max: 600, placeholder: "10" }
  },
  {
    field: "groupModeration.floodMaxLevel",
    label: "刷屏检测等级上限",
    component: "InputNumber",
    bottomHelpMessage: "只检测成员等级≤该值的成员，默认 5",
    componentProps: { min: 0, max: 100, placeholder: "5" }
  },
  {
    field: "groupModeration.adTemplateSimilarityThreshold",
    label: "模板相似阈值",
    component: "InputNumber",
    bottomHelpMessage: "越低越容易命中相似广告，默认 0.58",
    componentProps: { min: 0, max: 1, step: 0.01, placeholder: "0.58" }
  },
  {
    field: "groupModeration.adTemplateWeight",
    label: "模板命中加权",
    component: "InputNumber",
    bottomHelpMessage: "命中广告模板后增加的置信度，默认 0.55",
    componentProps: { min: 0, max: 1, step: 0.01, placeholder: "0.55" }
  },
  {
    field: "groupModeration.thresholds.report",
    label: "提醒阈值",
    component: "InputNumber",
    componentProps: { min: 0, max: 1, step: 0.01, placeholder: "0.70" }
  },
  {
    field: "groupModeration.thresholds.recall",
    label: "撤回阈值",
    component: "InputNumber",
    componentProps: { min: 0, max: 1, step: 0.01, placeholder: "0.85" }
  },
  {
    field: "groupModeration.thresholds.mute",
    label: "禁言阈值",
    component: "InputNumber",
    componentProps: { min: 0, max: 1, step: 0.01, placeholder: "0.90" }
  },
  {
    field: "groupModeration.thresholds.kick",
    label: "踢出阈值",
    component: "InputNumber",
    componentProps: { min: 0, max: 1, step: 0.01, placeholder: "0.97" }
  },
  {
    field: "groupModeration.actions.recallEnabled",
    label: "允许自动撤回",
    component: "Switch",
    bottomHelpMessage: "默认关闭。开启后达到撤回阈值会尝试撤回消息"
  },
  {
    field: "groupModeration.actions.muteEnabled",
    label: "允许自动禁言",
    component: "Switch",
    bottomHelpMessage: "默认关闭。开启后达到禁言阈值会尝试禁言"
  },
  {
    field: "groupModeration.actions.kickEnabled",
    label: "允许自动踢出",
    component: "Switch",
    bottomHelpMessage: "默认关闭。开启后达到踢出阈值会尝试踢人"
  },
  {
    field: "groupModeration.actions.muteSeconds",
    label: "禁言秒数",
    component: "InputNumber",
    componentProps: { min: 60, max: 2592000, step: 60, placeholder: "600" }
  },
  {
    field: "groupModeration.reportTemplate",
    label: "群内提醒模板",
    component: "InputTextArea",
    bottomHelpMessage: "支持变量：{rules}、{confidence}、{action}、{actionText}、{evidenceText}"
  }
]
