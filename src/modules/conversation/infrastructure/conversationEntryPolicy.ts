import type {ConversationEvent,ConversationState} from '../application/smartConversation.js'
import {evaluatePrivateChatGate,type PrivateConfig} from '../domain/privateChat.js'
import {summarizeForLog,messageQuotesUser} from '../domain/messageContext.js'
import {messageMentionsUser} from '../domain/mentionTargets.js'
import {normalizeIntentText,isImageGenerationRequest,isImageCompositionEditRequest,isImageAnalysisRequest,isRealtimeInfoRequest,isExplicitSearchRequest,isExplicitToolIntent} from '../domain/messageIntent.js'
import type {ForbiddenConfig} from '../domain/forbiddenWordGuard.js'
import {renderPersonaTemplate,type PersonaText} from '../domain/personaSource.js'
import {detectAndPenalize} from '../../memory/infrastructure/memorySelfCorrection.js'
interface EntryEvent extends ConversationEvent {isMaster?:boolean}
interface CorrectionRuntime {config?:{selfCorrection?:{enabled?:boolean;penalty?:number;ttlMinutes?:number}};store?:{penalizeChunks(groupId:string,ids:string[],options:{penalty:number}):number}}
export interface EntryHost {
 config:{privateChat?:PrivateConfig;forbiddenWords?:ForbiddenConfig & {replyText?:string};triggerPrefixes:string[];torrentDownload?:{autoDetect?:boolean};userBlacklist?:{enabled?:boolean;users?:unknown[]}};
 isCommand(e:EntryEvent):boolean;isUserBlacklisted(e:EntryEvent):boolean;handleForbiddenWordHit(e:EntryEvent):boolean;handleTool(e:EntryEvent):Promise<unknown>;
 cancelPendingConversation(groupId:string|number,e:EntryEvent):void;sendObservedReply(e:EntryEvent,text:string,quote:boolean,kind:string):Promise<unknown>;
 getPersonaFor(e:EntryEvent):PersonaText;getSmartState(groupId:string|number,e:EntryEvent):ConversationState
}
export interface EntryPorts {
 logger:{info(message:string):void;warn(message:string):void;mark(message:string):void};bot():{uin?:string|number};
 anchorEventConversation(e:EntryEvent):unknown;findForbiddenWord(text:string,config?:ForbiddenConfig):string|null;chatScopeKey(e:EntryEvent):string;markConversationInterrupted(key:string):unknown;
 getSemanticMemoryRuntime():CorrectionRuntime|null;resolveNaturalDeltaForceToolCall(text:string):unknown;shouldUseExcelWorkbookTool(text:string):boolean;extractValidBtihMagnetUri(text:string):unknown
}
export function createConversationEntryPolicy(ports:EntryPorts) {
const {logger,anchorEventConversation,findForbiddenWord,chatScopeKey,markConversationInterrupted,getSemanticMemoryRuntime,resolveNaturalDeltaForceToolCall,shouldUseExcelWorkbookTool,extractValidBtihMagnetUri}=ports

async function handlePrivateChat(host:EntryHost,e:EntryEvent) {
    if (host.isCommand(e)) return false // #指令仍走指令规则(人设列表等本就支持私聊)
    const gate = evaluatePrivateChatGate({ config: host.config, e, isMaster: e?.isMaster === true })
    if (!gate.allowed) {
      if (gate.reason === "disabled" || gate.reason === "master_only" || gate.reason === "not_allowed") {
        logger.info(`[私聊] user=${e.user_id} 忽略(${gate.reason})`)
      }
      return false
    }
    if (host.isUserBlacklisted(e)) return false
    if (host.handleForbiddenWordHit(e)) return false
    anchorEventConversation(e)
    e._triggerContext = { mode: "private_chat" }
    logger.info(`[私聊] user=${e.user_id} 进入私聊回合 msg="${summarizeForLog(e.msg || "")}"`)
    return await host.handleTool(e)
  }

function handleForbiddenWordHit(host:EntryHost,e:EntryEvent) {
    const cfg = host.config?.forbiddenWords
    if (cfg?.enabled === false) return false
    const text = String(e?.msg || e?.raw_message || "")
    const word = findForbiddenWord(text, cfg)
    if (!word) return false
    const scopeKey = chatScopeKey(e)
    markConversationInterrupted(scopeKey)
    if (e?.group_id) host.cancelPendingConversation(e.group_id, e)
    logger.mark(`[违禁词] scope=${scopeKey} user=${e?.user_id} word=${word} 已中断当前对话 msg="${summarizeForLog(text)}"`)
    const replyText = String(cfg?.replyText || "").trim()
    if (replyText) {
      host.sendObservedReply(e, renderPersonaTemplate(replyText, host.getPersonaFor(e)), false, "forbidden_notice")
        .catch(error => logger.warn(`[违禁词] 提示语发送失败: ${error instanceof Error ? error.message : String(error)}`))
    }
    return true
  }

function handleMemorySelfCorrection(host:EntryHost,e:EntryEvent) {
    try {
      const groupId = e?.group_id
      if (!groupId) return false
      const runtime = getSemanticMemoryRuntime()
      if (!runtime || runtime.config?.selfCorrection?.enabled === false) return false
      const state = host.getSmartState(groupId, e)
      detectAndPenalize({
        text: e?.msg || e?.raw_message || "",
        groupId:String(groupId),
        quotesBot: (() => { try { return messageQuotesUser(e, e?.bot?.uin || ports.bot().uin) } catch { return false } })(),
        senderUserId: e?.user_id ?? "",
        lastBotReplyToUserId: state?.lastBotReplyToUserId ?? "",
        runtime,
        penalty: Number(runtime.config?.selfCorrection?.penalty) || 0.5,
        ttlMs: (Number(runtime.config?.selfCorrection?.ttlMinutes) || 10) * 60 * 1000
      })
    } catch {}
    return false
  }

function checkTriggers(host:EntryHost,e:EntryEvent) {
    try {
      const hasMessage = e.msg && typeof e.msg === "string" &&
        host.config.triggerPrefixes.some(p => p && String(e.msg).toLowerCase().includes(p.toLowerCase()))

      const botId = e?.bot?.uin || ports.bot().uin
      const hasAt = messageMentionsUser(e, botId)
      const hasReplyToBot = messageQuotesUser(e, botId)

      return Boolean(hasMessage || hasAt || hasReplyToBot)
    } catch {
      return false
    }
  }

function isLikelyToolRequestText(host:EntryHost,text = "") {
    const content = normalizeIntentText(text)
    if (!content) return false
    return Boolean(
      isImageGenerationRequest(content) ||
      isImageCompositionEditRequest(content) ||
      isImageAnalysisRequest(content) ||
      isRealtimeInfoRequest(content) ||
      isExplicitSearchRequest(content) ||
      isExplicitToolIntent(content) ||
      resolveNaturalDeltaForceToolCall(content) ||
      shouldUseExcelWorkbookTool(content)
    )
  }

function isAutomaticTorrentDownloadEvent(host:EntryHost,e:EntryEvent) {
    if (!e?.group_id || String(e?.user_id || "") === String(e?.self_id || e?.bot?.uin || ports.bot().uin || "")) return false
    if (host.config?.torrentDownload?.autoDetect === false) return false
    return Boolean(extractValidBtihMagnetUri(e?.msg || ""))
  }

function isCommand(host:EntryHost,e:EntryEvent) {
    return e.msg?.startsWith("#") === true
  }

function isUserBlacklisted(host:EntryHost,e:EntryEvent) {
    const blacklist = host.config?.userBlacklist
    if (!blacklist?.enabled) return false
    const userId = e?.user_id
    if (userId === undefined || userId === null) return false
    const users = Array.isArray(blacklist.users) ? blacklist.users : []
    return users.some(id => String(id).trim() === String(userId))
  }

return {handlePrivateChat,handleForbiddenWordHit,handleMemorySelfCorrection,checkTriggers,isLikelyToolRequestText,isAutomaticTorrentDownloadEvent,isCommand,isUserBlacklisted}
}
