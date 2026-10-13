// 触发模式的共同声明；智能模式的细项仍在原对话追踪模块。
export default [
  {
    field: "chatTriggerMode",
    label: "对话触发模式",
    component: "Select",
    bottomHelpMessage: "严格模式通过 @ 或触发关键词开始对话；智能模式按群内消息判断是否接话，需要先在 AI 模型页面配置对话追踪模型。智能模式的频率等高级参数暂沿用现有配置",
    componentProps: {
      options: [
        { label: "严格模式（@ 或关键词触发）", value: "strict" },
        { label: "智能模式（自动判断接话时机）", value: "smart" }
      ]
    }
  }
]
