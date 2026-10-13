export default [
  { component: "SOFT_GROUP_BEGIN", label: "出站风控闸门" },
  {
    field: "riskControl.enabled",
    label: "启用出站闸门",
    component: "Switch",
    bottomHelpMessage: "所有机器人的消息类发送(聊天/骰子/命令/搬运/说说)统一过闸:先随机延迟再过令牌桶;非消息类 API 不受影响。保存后 10 秒内热生效"
  },
  {
    field: "riskControl.delayMinMs",
    label: "随机延迟下限(ms)",
    component: "InputNumber",
    componentProps: { min: 0, max: 5000, step: 50, placeholder: "0" }
  },
  {
    field: "riskControl.delayMaxMs",
    label: "随机延迟上限(ms)",
    component: "InputNumber",
    bottomHelpMessage: "每条消息发出前随机睡[下限,上限]毫秒,模拟人工打字节奏(豹骰默认 0~400)",
    componentProps: { min: 0, max: 10000, step: 50, placeholder: "400" }
  },
  { component: "SOFT_GROUP_BEGIN", label: "群聊令牌桶" },
  {
    field: "riskControl.groupIntervalSeconds",
    label: "回令牌间隔(秒)",
    component: "InputNumber",
    bottomHelpMessage: "每个群独立桶:每过这么久回 1 个令牌,1 条消息消耗 1 个",
    componentProps: { min: 1, max: 600, step: 1, placeholder: "3" }
  },
  {
    field: "riskControl.groupBurst",
    label: "突发上限",
    component: "InputNumber",
    bottomHelpMessage: "桶最多积攒的令牌数,即允许的瞬时连发条数",
    componentProps: { min: 1, max: 50, step: 1, placeholder: "3" }
  },
  { component: "SOFT_GROUP_BEGIN", label: "私聊令牌桶" },
  {
    field: "riskControl.privateIntervalSeconds",
    label: "回令牌间隔(秒)",
    component: "InputNumber",
    componentProps: { min: 1, max: 600, step: 1, placeholder: "3" }
  },
  {
    field: "riskControl.privateBurst",
    label: "突发上限",
    component: "InputNumber",
    componentProps: { min: 1, max: 50, step: 1, placeholder: "3" }
  },
  { component: "SOFT_GROUP_BEGIN", label: "丢弃策略" },
  {
    field: "riskControl.maxWaitSeconds",
    label: "排队等待上限(秒)",
    component: "InputNumber",
    bottomHelpMessage: "令牌不足时最多排队这么久,超时丢弃该条并计入健康报告失败码 throttled_dropped(搬运任务会按退避自动重试)",
    componentProps: { min: 1, max: 300, step: 1, placeholder: "8" }
  },
  { component: "SOFT_GROUP_BEGIN", label: "出站内容审查" },
  {
    field: "riskControl.censorEnabled",
    label: "启用出站审查",
    component: "Switch",
    bottomHelpMessage: "所有出站文本先过双级词表(与闸门开关联独立);只处理文本,CQ 码/图片/视频段不受影响"
  },
  {
    field: "riskControl.censorMark",
    label: "脱敏替换符",
    component: "Input",
    bottomHelpMessage: "替换级词命中后用什么字符替换(默认 *)",
    componentProps: { placeholder: "*" }
  },
  {
    field: "riskControl.censorReplaceWords",
    label: "替换级词表",
    component: "GTags",
    bottomHelpMessage: "命中后替换为脱敏符、消息照发(青骰路线);计入失败码 censor_hit。支持 /正则/ 写法"
  },
  {
    field: "riskControl.censorBlockWords",
    label: "拦截级词表",
    component: "GTags",
    bottomHelpMessage: "命中后整条丢弃、不消耗令牌,并立即通知管理群(10分钟冷却聚合);计入失败码 censored_dropped。支持 /正则/ 写法"
  },
  { component: "SOFT_GROUP_BEGIN", label: "风控信号感知" },
  {
    field: "riskControl.signalMonitorEnabled",
    label: "启用信号感知",
    component: "Switch",
    bottomHelpMessage: "识别 send 失败特征(风控码100/风控/频率/禁言/冻结)与机器人被禁言事件:log+失败码 suspected_risk_control+立即告警到健康报告管理群(同号10分钟冷却)"
  },
  {
    field: "riskControl.signalQuietMinutes",
    label: "低调模式时长(分钟)",
    component: "InputNumber",
    bottomHelpMessage: "检测到疑似风控后,该号的发送延迟与令牌间隔自动加倍,期满自动恢复;期间再有新信号则续期",
    componentProps: { min: 1, max: 720, step: 1, placeholder: "30" }
  }
]
