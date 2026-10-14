import type {ForbiddenConfig,ForbiddenEvent} from '../domain/forbiddenWordGuard.js'
import type {createForbiddenWordGuard} from '../domain/forbiddenWordGuard.js'
interface ThinkingSession {thinkingChars?:number;thinkingChunks?:string[];thinkingForwardAttempted?:boolean}
interface ThinkingEvent extends ForbiddenEvent {group_id?:string|number;self_id?:string|number;bot?:{uin?:string|number};group?:{makeForwardMsg(nodes:{user_id:string|number;nickname:string;message:string}[]):Promise<unknown>}}
interface ThinkingHost {config?:{forbiddenWords?:ForbiddenConfig};sendObservedReply(event:ThinkingEvent,payload:unknown,quote:boolean,channel:string):Promise<unknown>}

import { safeTruncateUnicode, splitUnicodeText } from "../../models/domain/unicodeText.js"


export function createThinkingForward(ports:{enabled(groupId:string|number):boolean;botId():string|number|undefined;warn(message:string):void;guard:Pick<ReturnType<typeof createForbiddenWordGuard>,'findForbiddenWord'|'isConversationInterrupted'>}) {
const isThinkingForwardEnabled=ports.enabled
const {findForbiddenWord,isConversationInterrupted}=ports.guard
const MAX_CHARS = 12000

// Keep provider reasoning outside conversation history and ordinary reply content.
function collectThinking(session:ThinkingSession|null|undefined, message:{reasoning_content?:unknown}|null|undefined, e:ThinkingEvent|null|undefined, enabled = isThinkingForwardEnabled) {
  if (!session || !e?.group_id || !enabled(e.group_id)) return
  const text = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : ""
  if (!text) return
  const remaining = MAX_CHARS - (session.thinkingChars || 0)
  if (remaining <= 0) return
  const bounded = safeTruncateUnicode(text, remaining, "\n（思考内容过长，已截断）")
  session.thinkingChunks ||= []
  session.thinkingChunks.push(bounded)
  session.thinkingChars = (session.thinkingChars || 0) + Array.from(bounded).length
}

async function sendThinkingForward(host:ThinkingHost, e:ThinkingEvent, session:ThinkingSession|null|undefined, enabled = isThinkingForwardEnabled) {
  if (!session || session.thinkingForwardAttempted) return null
  session.thinkingForwardAttempted = true
  const chunks = session.thinkingChunks || []
  // Dispose even when disabled during the turn; nothing is persisted in history.
  delete session.thinkingChunks
  delete session.thinkingChars
  if (!e?.group_id || !enabled(e.group_id) || !chunks.length || isConversationInterrupted(e)) return null
  if (typeof e.group?.makeForwardMsg !== "function") return null
  const text = chunks.join("\n\n")
  const cfg = host?.config?.forbiddenWords
  if (cfg?.enabled !== false && cfg?.blockOutput !== false && findForbiddenWord(text, cfg)) return null
  try {
    const identity = { user_id: e.self_id || e.bot?.uin || ports.botId() || 80000000, nickname: "模型思考过程" }
    const nodes = [{ ...identity, message: "本次回答的模型思考过程（接口返回内容，仅供参考）" }]
    chunks.forEach((chunk, index) => {
      splitUnicodeText(chunk, 1800).forEach(part => nodes.push({ ...identity, message: `第 ${index + 1} 轮\n${part}` }))
    })
    const forward = await e.group.makeForwardMsg(nodes)
    if (!enabled(e.group_id) || isConversationInterrupted(e)) return null
    return await host.sendObservedReply(e, forward, false, "agent_thinking_forward")
  } catch {
    ports.warn("[思考过程] 合并转发发送失败，正常回答不受影响")
    return null
  }
}

return {collectThinking,sendThinkingForward}
}
