import basic from "./basic.js"
import permission from "./permission.js"
import aiCore from "./aiCore.js"
import reasoning from "./reasoning.js"
import triggers from "./triggers.js"

// 控制台按用途组合共同声明，不依赖锅巴组件入口。
// 人设与三类主要思考档已有专门管理入口，避免同时编辑同一个字段。
const fields = new Map([...basic, ...permission, ...aiCore, ...triggers]
  .filter(item => item.field)
  .map(item => [item.field, item]))
const reasoningFields = new Set(reasoning.filter(item => item.field).map(item => item.field))
const section = (label, names) => [
  { component: "Divider", label },
  ...names.map(name => fields.get(name))
]
const byPrefix = prefix => [...fields.keys()].filter(name => name.startsWith(prefix) && !reasoningFields.has(name))

export default [
  ...section("对话开关与触发", ["enabled", "chatTriggerMode", "triggerPrefixes", "excludeMessageTypes", "useTools", "maxToolRounds", "concurrentLimit"]),
  ...section("私聊功能", byPrefix("privateChat.")),
  ...section("群聊权限", ["enableGroupWhitelist", "allowedGroups"]),
  ...section("用户黑名单", byPrefix("userBlacklist.")),
  ...section("违禁词拦截", byPrefix("forbiddenWords.")),
  ...section("聊天上下文", ["groupHistory", "groupMaxMessages", "groupChatMemoryMinutes"]),
  ...section("上下文选择与智能路由", byPrefix("agentIntelligence.")),
  ...section("短闲聊模型", byPrefix("taskAiConfig.casual.")),
  ...section("进度回复模型", byPrefix("taskAiConfig.progress.")),
  ...section("翻译任务模型", byPrefix("taskAiConfig.translation.")),
  ...section("回复节奏", byPrefix("replyRhythm.")),
  ...section("理解增强", byPrefix("understandingEnhancement."))
]
