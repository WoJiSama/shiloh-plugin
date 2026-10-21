import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'
const schema: ConfigSchemaItem[] = [
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
    field: "groupModeration.adScan.enabled",
    label: "广告与刷屏检测",
    component: "Switch",
    bottomHelpMessage: "默认开启。关闭后不再做广告/刷屏检测与处置，只保留超长和连发消息折叠（两者另有独立开关）"
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
  },
  {
    component: "Divider",
    label: "超长消息折叠"
  },
  {
    field: "groupModeration.overlongMessage.enabled",
    label: "超长消息折叠开关",
    component: "Switch",
    bottomHelpMessage: "开启后，未命中广告风控的超长消息会被自动撤回，并把原内容转成一条合并聊天记录发出"
  },
  {
    field: "groupModeration.overlongMessage.maxLength",
    label: "超长判定字数",
    component: "InputNumber",
    bottomHelpMessage: "消息可见文本超过该字数即视为超长。默认 1500 字",
    componentProps: { min: 100, max: 20000, step: 50, placeholder: "1500" }
  },
  {
    field: "groupModeration.overlongMessage.maxLines",
    label: "超长判定行数",
    component: "InputNumber",
    bottomHelpMessage: "单条消息换行行数超过该值即视为超长（按原文计不裁首尾），可拦几十个换行符的刷屏。0 = 不启用。默认 0",
    componentProps: { min: 0, max: 2000, placeholder: "30" }
  },
  {
    field: "groupModeration.overlongMessage.forwardEnabled",
    label: "撤回后转发聊天记录",
    component: "Switch",
    bottomHelpMessage: "默认开启。关闭后只撤回超长消息不再转发；命中广告/刷屏规则的消息始终不会被转发"
  },
  {
    component: "Divider",
    label: "连发消息折叠"
  },
  {
    field: "groupModeration.burstMessage.enabled",
    label: "连发消息折叠开关",
    component: "Switch",
    bottomHelpMessage: "开启后，同一成员在时间窗内连发达到条数上限，这批消息会被全部撤回并合并成一条聊天记录，可附带禁言"
  },
  {
    field: "groupModeration.burstMessage.maxMessages",
    label: "连发条数上限",
    component: "InputNumber",
    bottomHelpMessage: "时间窗内发送达到该条数即触发折叠。默认 6 条",
    componentProps: { min: 3, max: 100, placeholder: "6" }
  },
  {
    field: "groupModeration.burstMessage.windowSeconds",
    label: "连发时间窗(秒)",
    component: "InputNumber",
    bottomHelpMessage: "统计连发的滑动窗口长度。默认 5 秒",
    componentProps: { min: 2, max: 600, placeholder: "5" }
  },
  {
    field: "groupModeration.burstMessage.totalLength",
    label: "窗口总字数",
    component: "InputNumber",
    bottomHelpMessage: "时间窗内所有消息合计字数超过该值也触发折叠（不必等条数凑满）。0 = 不启用。默认 0",
    componentProps: { min: 0, max: 50000, placeholder: "0" }
  },
  {
    field: "groupModeration.burstMessage.totalLines",
    label: "窗口总行数",
    component: "InputNumber",
    bottomHelpMessage: "时间窗内所有消息合计行数超过该值也触发折叠。0 = 不启用。默认 0",
    componentProps: { min: 0, max: 20000, placeholder: "0" }
  },
  {
    field: "groupModeration.burstMessage.muteSeconds",
    label: "禁言秒数",
    component: "InputNumber",
    bottomHelpMessage: "触发连发折叠后对发送者的禁言时长，默认 30 秒；填 0 表示只折叠不禁言",
    componentProps: { min: 0, max: 2592000, step: 30, placeholder: "30" }
  },
  {
    field: "groupModeration.burstMessage.forwardEnabled",
    label: "折叠后转发聊天记录",
    component: "Switch",
    bottomHelpMessage: "默认开启。关闭后只撤回连发消息并禁言，不再合并转发"
  },
  {
    component: "Divider",
    label: "复合规则"
  },
  {
    field: "groupModeration.compoundRules",
    label: "复合规则列表",
    component: "GSubForm",
    componentProps: {
      multiple: true,
      modalProps: { title: "复合规则（最多 5 条，越靠后优先级越高）" },
      schemas: [
        {
          field: "name",
          label: "规则名",
          component: "Input",
          required: true,
          componentProps: { placeholder: "例如 长文刷屏" }
        },
        { field: "enabled", label: "启用", component: "Switch" },
        {
          field: "burstCount",
          label: "连发条数≥",
          component: "InputNumber",
          componentProps: { min: 2, max: 100, placeholder: "10" }
        },
        {
          field: "windowSeconds",
          label: "时间窗(秒)",
          component: "InputNumber",
          componentProps: { min: 2, max: 600, placeholder: "5" }
        },
        {
          field: "maxLength",
          label: "单条最长字数>",
          component: "InputNumber",
          componentProps: { min: 0, max: 20000, placeholder: "160，0=不启用该条件" }
        },
        {
          field: "totalLength",
          label: "窗口总字数>",
          component: "InputNumber",
          componentProps: { min: 0, max: 50000, placeholder: "0=不启用该条件" }
        },
        {
          field: "maxLines",
          label: "单条最多行数>",
          component: "InputNumber",
          componentProps: { min: 0, max: 2000, placeholder: "30，0=不启用该条件" }
        },
        {
          field: "totalLines",
          label: "窗口总行数>",
          component: "InputNumber",
          componentProps: { min: 0, max: 20000, placeholder: "0=不启用该条件" }
        },
        { field: "recall", label: "撤回", component: "Switch" },
        { field: "forward", label: "合并转发", component: "Switch" },
        {
          field: "muteSeconds",
          label: "禁言秒数",
          component: "InputNumber",
          componentProps: { min: 0, max: 2592000, step: 30, placeholder: "60，0=不禁言" }
        }
      ]
    },
    bottomHelpMessage:
      "条件组合：几件事同时发生才处理。例：条数填 10、时间窗 5、单条最长字数 160、禁言 60，即『5 秒内连发 10 条且单条超过 160 字 → 撤回全部+合并转发+禁言 60 秒』——单独刷短句或单发长文都不触发。行数条件按消息换行计数（不裁剪首尾），可拦几十个换行符的刷屏，例：单条最多行数 30 即单条超过 30 行就计入条件。字数/行数条件填 0 = 不启用；最多 5 条；多条同时命中取列表靠后（最新）的"
  }
]

export default schema
