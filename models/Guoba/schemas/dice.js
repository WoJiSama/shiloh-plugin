export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "COC 骰娘"
  },
  {
    field: "diceSystem.enabled",
    label: "启用骰娘",
    component: "Switch",
    bottomHelpMessage: "纯命令式 COC 骰娘，不接入 AI 工具，不消耗模型 token"
  },
  {
    field: "diceSystem.customRulesEnabled",
    label: "启用自定义规则包",
    component: "Switch",
    bottomHelpMessage: "允许主人导入 YAML 规则包，并由群管理员在当前群启用；规则表达式不执行任意脚本"
  },
  {
    field: "diceSystem.defaultRule",
    label: "默认规则",
    component: "Select",
    componentProps: {
      options: [
        { label: "0: 默认", value: "0" },
        { label: "1: 技能>=50 时 1-5 大成功", value: "1" },
        { label: "2: 1-5且<=技能大成功；96-100且>技能大失败", value: "2" },
        { label: "3: 1-5大成功；96-100大失败", value: "3" },
        { label: "4: 1-5且<=技能大成功；100大失败", value: "4" },
        { label: "5: 1大成功；100大失败", value: "5" },
        { label: "无大失败", value: "nofumble" }
      ]
    }
  },
  {
    field: "diceSystem.maxDiceCount",
    label: "单次最大骰子数",
    component: "InputNumber",
    componentProps: { min: 1, max: 10000, step: 1, placeholder: "100" }
  },
  {
    field: "diceSystem.maxDiceSides",
    label: "最大骰面",
    component: "InputNumber",
    componentProps: { min: 2, max: 100000000, step: 100, placeholder: "100000" }
  },
  {
    field: "diceSystem.maxRounds",
    label: "多轮掷骰上限",
    component: "InputNumber",
    bottomHelpMessage: "例如 .r 5#1d100，限制 # 前面的轮数",
    componentProps: { min: 1, max: 1000, step: 1, placeholder: "20" }
  },
  {
    field: "diceSystem.allowHiddenRoll",
    label: "允许暗骰",
    component: "Switch",
    bottomHelpMessage: "开启后 .rh/.rah 会把结果私聊给发起者"
  },
  {
    field: "diceSystem.logAiSilent",
    label: "log 开启时静默 AI",
    component: "Switch",
    bottomHelpMessage: "开启跑团 log 后，本群主 AI 对话暂时关闭；.log off 后恢复。骰娘命令不受影响"
  },
  {
    field: "diceSystem.timeZone",
    label: "骰娘日期时区",
    component: "Input",
    bottomHelpMessage: "用于 SAN 每日累计和今日人品日期，例如 Asia/Shanghai；无效值会安全回退到 UTC 日期"
  },
  {
    field: "diceSystem.logExportMaxMb",
    label: "团录文件发送上限(MB)",
    component: "InputNumber",
    componentProps: { min: 1, max: 100, step: 1, placeholder: "8" },
    bottomHelpMessage: "超过上限会明确提示未发送，不会把截断文本冒充完整导出"
  },
  {
    field: "diceSystem.baseDir",
    label: "骰娘数据目录",
    component: "Input",
    bottomHelpMessage: "相对插件目录或绝对路径；存储人物卡、昵称和群规则"
  },
  {
    component: "Divider",
    label: "回复文案请到命令管理页骰子面板修改：按命令（含 .st）编辑发送，失败/大失败可改整句"
  }
]
