// 回合会话存储:apps/test.js 的 sessionMap 原是一张裸 Map,字段在主链路里随手挂,
// 谁也不知道完整形状;回合异常退出时条目无人清理,随机 UUID 键会无限累积。
// 此模块保持"裸对象 + 自由字段"的既有语义(100+ 处 session.X 调用点零改动),
// 只收紧存储层:
// - 每个会话附带 __createdAt/__lastActiveAt 元数据;
// - sweep() 按 TTL 与容量淘汰(挂 hourly 扫描器),防泄漏;
// - TURN_SESSION_FIELDS 是字段注册表,tests/turnSession.test.js 有漂移防护:
//   apps/test.js 里新增 session.X 访问而未登记注册表时,测试会失败,逼着写字段的归属。
export const TURN_SESSION_TTL_MS = 30 * 60 * 1000
export const TURN_SESSION_MAX = 300

// 字段注册表:登记 = 承认这个字段存在并注明归属。新字段先来这里加一行。
export const TURN_SESSION_FIELDS = [
  { name: "tools", owner: "回合可用工具集;创建时注入,updateToolsList 全量刷新" },
  { name: "groupUserMessages", owner: "本回合注入的群聊历史消息" },
  { name: "actionOutcomes", owner: "本轮已确认的动作产出(recordActionOutcomes)" },
  { name: "toolName", owner: "本轮选定的工具名" },
  { name: "toolResults", owner: "工具执行结果累积" },
  { name: "toolContent", owner: "工具消息内容" },
  { name: "rawArgs", owner: "原始命令参数" },
  { name: "userContent", owner: "构造后的用户消息内容(buildMessageContent)" },
  { name: "turnPlan", owner: "回合执行计划(turnPlan.js)" },
  { name: "turnTrace", owner: "回合观测 trace" },
  { name: "images", owner: "本轮图片素材" },
  { name: "editAssets", owner: "改图参考素材(editReferencePipeline)" },
  { name: "avatarEditBase", owner: "头像改图底图" },
  { name: "avatarDrawReference", owner: "头像绘制参考" },
  { name: "avatarInspection", owner: "头像检查目标" },
  { name: "imageVerificationMode", owner: "图片核实模式" },
  { name: "imageVerificationNeedsSearch", owner: "图片核实是否需要搜索" },
  { name: "imageVerificationSearchDone", owner: "图片核实搜索已执行" },
  { name: "imageVerificationFinalInstructionAdded", owner: "图片核实最终指令已注入" },
  { name: "recentImageContinuation", owner: "近期图片延续上下文" },
  { name: "recentUserImage", owner: "用户近期图片" },
  { name: "groupContextAssets", owner: "群上下文素材" },
  { name: "groupContextImagePrompt", owner: "群上下文绘图提示" },
  { name: "promptLayerProfile", owner: "提示词分层画像(promptLayers)" },
  { name: "promptLayerReport", owner: "提示词分层组装报告(turnPromptComposer)" },
  { name: "modelIntentDecision", owner: "模型意图判定结果" },
  { name: "turnDrawRequested", owner: "本轮是否为画图请求" },
  { name: "addresseeSignal", owner: "对象指认信号(addresseeSignals)" },
  { name: "historySelectionMode", owner: "历史选取模式(agentIntelligence)" },
  { name: "selectedGroupHistoryCount", owner: "已选历史条数" },
  { name: "cardPresentation", owner: "卡面呈现形态(turnPresentation)" },
  { name: "cardAcknowledged", owner: "卡面确认消息已发送" },
  { name: "modrinthCardItems", owner: "Modrinth 卡面条目" },
  { name: "emojiToolSentThisTurn", owner: "本轮已实际发送的本地表情数(每轮上限用)" },
  { name: "lastFinalReply", owner: "最终回复文本(供延续判定)" },
  { name: "taskContext", owner: "任务上下文" },
  { name: "taskDedupeToolTouched", owner: "任务去重:工具已触碰标记" },
  { name: "responseAttempted", owner: "本回合已尝试过回复" },
  { name: "initialExecutionRoute", owner: "回合初始执行路由" },
  { name: "outboundArbiter", owner: "出站仲裁器(messagePipeline)" },
  { name: "backgroundTerminalToolTouched", owner: "后台终结工具已触碰" }
]

export function createTurnSessionStore({
  map = new Map(),
  ttlMs = TURN_SESSION_TTL_MS,
  maxSessions = TURN_SESSION_MAX
} = {}) {
  return {
    // 原始 Map 引用:sharedState 持久化与其他既有遍历兼容
    map,
    getOrCreate(sessionId, tools) {
      let session = map.get(sessionId)
      if (!session) {
        session = {
          tools,
          groupUserMessages: [],
          actionOutcomes: [],
          __createdAt: Date.now()
        }
        map.set(sessionId, session)
      }
      session.__lastActiveAt = Date.now()
      return session
    },
    get(sessionId) {
      return map.get(sessionId)
    },
    clear(sessionId) {
      map.delete(sessionId)
    },
    refreshTools(tools) {
      for (const session of map.values()) session.tools = tools
    },
    // TTL + 容量淘汰;返回清除数量。now 可注入便于测试。
    sweep(now = Date.now()) {
      let removed = 0
      for (const [sessionId, session] of map) {
        const lastActiveAt = session.__lastActiveAt || session.__createdAt || 0
        if (now - lastActiveAt > ttlMs) {
          map.delete(sessionId)
          removed += 1
        }
      }
      while (map.size > maxSessions) {
        let oldestId = null
        let oldestAt = Infinity
        for (const [sessionId, session] of map) {
          const at = session.__lastActiveAt || session.__createdAt || 0
          if (at < oldestAt) {
            oldestAt = at
            oldestId = sessionId
          }
        }
        if (oldestId == null) break
        map.delete(oldestId)
        removed += 1
      }
      return removed
    },
    stats() {
      return { sessions: map.size }
    }
  }
}
