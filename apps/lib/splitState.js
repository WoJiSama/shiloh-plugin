// P2 拆分后仍需在 apps/test.js 与拆分模块之间共享的可变状态与常量。
// 只放共享状态,不放逻辑;从任何一侧 import 拿到的是同一个对象引用。
export const lastIncomingMsgAt = new Map() // groupId -> 最近一条群消息时间戳
export const activeDedupeToolRuns = new Map() // 工具运行去重: toolRunKey -> toolRunValue
export const LOCAL_EMOJI_TOOL_NAME = "sendLocalEmojiTool"
