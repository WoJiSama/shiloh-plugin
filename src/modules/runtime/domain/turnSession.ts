import type { ConversationContext } from '../../../contracts/conversation.js'
import type {PersonaSnapshot} from '../../../contracts/persona.js'
import type { TurnInteractionContext } from '../../../contracts/turnInteraction.js'
import type { SemanticDecision, ToolDefinition } from '../../../contracts/toolExecution.js'
import type { ActionFactsQuery } from '../../../contracts/turnActionFacts.js'

/** Legacy payloads remain opaque until their owning domain is migrated. No arbitrary fields. */
export interface TurnSession {
  context?: ConversationContext
  personaSnapshot?: PersonaSnapshot
  tools?: unknown[]
  groupUserMessages?: unknown[]
  actionOutcomes?: unknown[]
  toolName?: string
  toolResults?: unknown[]
  toolContent?: unknown
  rawArgs?: string
  rawUserText?: string
  interactionContext?: TurnInteractionContext
  actionFactsQuery?: ActionFactsQuery
  /** Opaque to the lifecycle store; the final-reply application owns its audit. */
  replyGrounding?: unknown
  toolDecision?: SemanticDecision | null
  executionTools?: ToolDefinition[]
  userContent?: unknown
  turnPlan?: unknown
  turnTrace?: unknown
  thinkingChunks?: string[]
  thinkingChars?: number
  thinkingForwardAttempted?: boolean
  images?: unknown[]
  editAssets?: unknown
  avatarEditBase?: unknown
  avatarDrawReference?: unknown
  memberMap?: unknown
  atQq?: Array<string | number>
  avatarInspection?: unknown
  imageVerificationMode?: string
  imageVerificationNeedsSearch?: boolean
  imageVerificationSearchDone?: boolean
  imageVerificationFinalInstructionAdded?: boolean
  recentImageContinuation?: unknown
  recentUserImage?: unknown
  groupContextAssets?: unknown
  groupContextImagePrompt?: string
  promptLayerProfile?: unknown
  promptLayerReport?: unknown
  modelIntentDecision?: unknown
  turnDrawRequested?: boolean
  addresseeSignal?: unknown
  historySelectionMode?: string
  selectedGroupHistoryCount?: number
  cardPresentation?: unknown
  cardAcknowledged?: boolean
  modrinthCardItems?: unknown[]
  emojiToolSentThisTurn?: number
  lastFinalReply?: string
  taskContext?: unknown
  taskDedupeToolTouched?: boolean
  responseAttempted?: boolean
  initialExecutionRoute?: unknown
  outboundArbiter?: unknown
  backgroundTerminalToolTouched?: boolean
  __createdAt?: number
  __lastActiveAt?: number
}

/** UUIDs are current callers; numeric keys remain supported for shared legacy Maps. */
export type SessionId = string | number
export interface TurnSessionStoreOptions {
  map?: Map<SessionId, TurnSession>
  ttlMs?: number
  maxSessions?: number
  now?: () => number
}
export interface TurnSessionStore {
  map: Map<SessionId, TurnSession>
  getOrCreate(sessionId: SessionId, tools?: unknown[]): TurnSession
  get(sessionId: SessionId): TurnSession | undefined
  clear(sessionId: SessionId): void
  refreshTools(tools: unknown[]): void
  sweep(now?: number): number
  stats(): { sessions: number }
}

export const TURN_SESSION_TTL_MS = 30 * 60 * 1000
export const TURN_SESSION_MAX = 300

// 字段注册表:登记 = 承认这个字段存在并注明归属。新字段先来这里加一行。
export const TURN_SESSION_FIELDS = [
  { name: "context", owner: "已校验的机器人/群聊/私聊身份;不保存原始平台事件" },
  { name: "personaSnapshot", owner: "回合开始时冻结的人设及版本;生成/出口/记忆共用,热切换只影响下一轮" },
  { name: "tools", owner: "回合可用工具集;创建时注入,updateToolsList 全量刷新" },
  { name: "groupUserMessages", owner: "本回合注入的群聊历史消息" },
  { name: "actionOutcomes", owner: "本轮已确认的动作产出(recordActionOutcomes)" },
  { name: "toolName", owner: "本轮选定的工具名" },
  { name: "toolResults", owner: "工具执行结果累积" },
  { name: "toolContent", owner: "工具消息内容" },
  { name: "rawArgs", owner: "原始命令参数" },
  { name: "rawUserText", owner: "本轮当前正文;与时间/身份/引用前缀分开保留" },
  { name: "interactionContext", owner: "本轮互动线索、对象与证据;主提示/感知续轮/最终出口共用" },
  { name: "actionFactsQuery", owner: "本轮任务原请求或明确回执范围;每轮开始清理,工具执行后更新" },
  { name: "replyGrounding", owner: "最终回复事实校验审计;由最终出口维护,每轮开始清理,不作为历史证据" },
  { name: "toolDecision", owner: "本轮已选动作或明确无工具决策;只约束当前回合并在创建时重置" },
  { name: "executionTools", owner: "本轮执行与工具续轮的固定能力定义;不随注册表刷新扩权,新回合清理" },
  { name: "userContent", owner: "构造后的用户消息内容(buildMessageContent)" },
  { name: "turnPlan", owner: "回合执行计划(turnPlan.js)" },
  { name: "turnTrace", owner: "回合观测 trace" },
  { name: "thinkingChunks", owner: "本回合接口返回的思考内容;转发后清理" },
  { name: "thinkingChars", owner: "思考转发内容的字符预算" },
  { name: "thinkingForwardAttempted", owner: "每回合只尝试一次思考合并转发" },
  { name: "images", owner: "本轮图片素材" },
  { name: "editAssets", owner: "改图参考素材(editReferencePipeline)" },
  { name: "avatarEditBase", owner: "头像改图底图" },
  { name: "avatarDrawReference", owner: "头像绘制参考" },
  { name: "memberMap", owner: "本轮群成员表(供语义分类器成员候选与 references 幻觉校验)" },
  { name: "atQq", owner: "本轮被@成员QQ列表(同上,LLM 头像参考规划的机械候选)" },
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
] as const satisfies ReadonlyArray<{ name: keyof TurnSession; owner: string }>

export interface LifecycleSession<Tool> {tools?:Tool[];__createdAt?:number;__lastActiveAt?:number}
export interface TypedTurnSessionStore<T,Tool> {map:Map<SessionId,T>;getOrCreate(id:SessionId,tools?:Tool[]):T;get(id:SessionId):T|undefined;clear(id:SessionId):void;refreshTools(tools:Tool[]):void;sweep(now?:number):number;stats():{sessions:number}}
export function createTurnSessionStore(options:TurnSessionStoreOptions = {}):TurnSessionStore {
 return createTypedTurnSessionStore<TurnSession,unknown>({...options,createSession:tools=>({...tools===undefined?{}:{tools},groupUserMessages:[],actionOutcomes:[]})})
}
export function createTypedTurnSessionStore<T extends LifecycleSession<Tool>,Tool>({
  map = new Map<SessionId,T>(),
  ttlMs = TURN_SESSION_TTL_MS,
  maxSessions = TURN_SESSION_MAX,
  now = Date.now,
  createSession
}: {map?:Map<SessionId,T>;ttlMs?:number;maxSessions?:number;now?:()=>number;createSession:(tools:Tool[]|undefined)=>T}):TypedTurnSessionStore<T,Tool> {
  return {
    // 原始 Map 引用:sharedState 持久化与其他既有遍历兼容
    map,
    getOrCreate(sessionId, tools) {
      let session = map.get(sessionId)
      if (!session) {
        session = createSession(tools)
        session.__createdAt = now()
        map.set(sessionId, session)
      }
      session.__lastActiveAt = now()
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
    sweep(sweepAt = now()) {
      let removed = 0
      for (const [sessionId, session] of map) {
        const lastActiveAt = session.__lastActiveAt ?? session.__createdAt ?? 0
        if (sweepAt - lastActiveAt > ttlMs) {
          map.delete(sessionId)
          removed += 1
        }
      }
      while (map.size > maxSessions) {
        let oldestId: SessionId | undefined
        let oldestAt = Infinity
        for (const [sessionId, session] of map) {
          const at = session.__lastActiveAt ?? session.__createdAt ?? 0
          if (at < oldestAt) {
            oldestAt = at
            oldestId = sessionId
          }
        }
        if (oldestId === undefined) break
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
