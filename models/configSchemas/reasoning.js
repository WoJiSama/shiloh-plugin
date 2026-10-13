const options = [
  { label: "模型默认", value: "" },
  { label: "关闭思考 · none（模型支持时）", value: "none" },
  ...["minimal", "low", "medium", "high", "max"].map(value => ({ label: value, value }))
]
const help = "各模型支持的档位不同；必须思考的模型不能选 none。low 适合日常回复，high/max 适合复杂推理。"
export default [
  { component: "Divider", label: "思考程度" },
  { field: "chatAiConfig.chatReasoningEffort", label: "全局聊天思考程度", component: "Select", componentProps: { options }, bottomHelpMessage: help + " 模型默认表示不指定档位。" },
  { field: "taskAiConfig.casual.reasoningEffort", label: "短闲聊思考程度", component: "Select", componentProps: { options: options.map(option => option.value === "" ? { label: "继承全局聊天", value: "" } : option) }, bottomHelpMessage: help + " 留空时继承全局聊天；单独配置短闲聊后端时使用该模型默认。" },
  { field: "chatAiConfig.complexReasoningEffort", label: "复杂请求思考程度", component: "Select", componentProps: { options: [{ label: "保持全局档位，不自动升档", value: "none" }, ...["minimal", "low", "medium", "high", "max"].map(value => ({ label: value, value }))] }, bottomHelpMessage: "对比、排障、推导等复杂请求自动使用此档位。关闭升档只保留全局设置，不会向模型发送 none。" }
]
