import {buildCommittedActionReply} from '../domain/actionOutcomes.js'
import {buildMentionMembersFailureReply} from '../domain/mentionFailureReply.js'
import {buildImageFailureReply} from '../../image/domain/imageFailurePolicy.js'
import {appendVisibleFailureDetail,buildVisibleFailureDetail} from '../../models/domain/visibleFailure.js'
import {classifyChatRequestFailure} from '../../models/application/chatRequestRecovery.js'
import {isCasualBotGreeting} from '../domain/messageIntent.js'
interface FailureContext {session?:FinalSession & NonNullable<Parameters<typeof buildCommittedActionReply>[0]>;error?:unknown;failedResult?:unknown;e?:{msg?:string}}
import {messageMentionsUser} from '../domain/mentionTargets.js'
import {extractDeliveryMessageId} from '../../messaging/domain/deliveryObservability.js'
import {redactInternalStatusLeaks} from '../domain/internalStatusLeak.js'
import {splitNarrativeReply} from '../domain/narrativeReply.js'
import {looksLikeCodeOrMarkdown} from '../domain/textPolicy.js'
import {resolvePersonaName} from '../domain/personaSource.js'
import {ROLE_MAP as roleMap} from '../domain/messageContext.js'
import {safeTruncateUnicode} from '../../models/domain/unicodeText.js'
import {isImageGenerationRequest,isImageAnalysisRequest} from '../domain/messageIntent.js'
import {recordDrawTextFallback,clearDrawFailureNote} from '../domain/drawFailureNote.js'
import type {ReplyEvent} from './replyRendering.js'
import type {TurnInteractionContext} from '../../../contracts/turnInteraction.js'
import type {PersonaIdentity, PersonaScope, PersonaSnapshot} from '../../../contracts/persona.js'
import type {MemoryExtractionMeta,MemoryExtractionMessage} from '../../../contracts/memoryEngine.js'
import type {SocialContinuity} from '../../../contracts/turnInteraction.js'
import type {ForwardCompleteness} from '../../../contracts/forwardContext.js'
import {buildSocialContinuity} from '../domain/turnInteractionContext.js'
export interface Message {role:string;content:string;tool_call_id?:string;name?:string}
export interface FinalEvent extends ReplyEvent {_personaSnapshot?:PersonaSnapshot;message_id?:string|number;time?:number;_receivedAt?:number;sender?:{card?:string;nickname?:string;role?:string};message_type?:string;message?:import('../../../contracts/chatEvent.js').MessageSegment[]}
export interface FinalSession {personaSnapshot?:PersonaSnapshot;userContent?:string;rawArgs?:string;rawUserText?:string;interactionContext?:TurnInteractionContext;modrinthCardItems?:unknown[]|null;responseAttempted?:boolean;turnDrawRequested?:boolean;lastFinalReply?:string;modelIntentDecision?:{intent?:string};initialExecutionRoute?:{mode?:string};turnPlan?:{outcomes?:{toolName:string;success?:boolean}[]};toolResults?:{toolCall?:{id?:string};toolName:string;result:string}[];groupUserMessages?:Message[]}
interface Config {personaGuard?:{enabled?:boolean;badPatterns?:string[]};episodicMemory?:{enabled?:boolean;maxPerGroup?:number};conversationTrackingEnabled?:boolean;globalStyleLearning?:unknown;emotionSystem?:{enabled?:boolean}|undefined;memorySystem?:{enabled?:boolean}|undefined}
interface ArchivedMessage {self_id?:string|number;source?:string;sender?:{self_id?:string|number;user_id?:string|number|undefined;nickname?:string|undefined};content?:string;raw_message?:string;message?:{type?:string;text?:string;data?:{text?:string}}[];at?:unknown;time?:unknown;forwardCompleteness?:ForwardCompleteness}
export interface FinalReplyHost {
 config:Config;processToolSpecificMessage(content:string,toolName?:string):string|Promise<string>;getPersonaFor(event:FinalEvent):{name?:string};
 getTextImageTemplateForFinalReply(context:{content:string;output:string;session:FinalSession;toolName?:string|undefined;e:FinalEvent}):string|false|null;
 sendModrinthForwardCards(event:FinalEvent,items:unknown[]):Promise<unknown>;sendModrinthForwardItems(event:FinalEvent,items:string[]):Promise<unknown>;sendFinalReplyAsTextImage(event:FinalEvent,text:string,template:string):Promise<unknown>;sendSegmentedMessage(event:FinalEvent,text:string,chance:number,options:{alreadyGuarded:boolean}):Promise<unknown>;
 formatTime():string;setTrackingWithTimer(key:string,options:{chatHistory:Message[]}):unknown;
 messageManager:{recordMessage(record:import('../../../contracts/recentMessages.js').MessageEvent):Promise<unknown>;getMessages(type:string,groupId:string|number):Promise<ArchivedMessage[]>};
 trimMessageHistory(messages:Message[]):Message[];saveGroupUserMessages(groupId:string|number|undefined,userId:string|number|undefined,messages:Message[]):Promise<unknown>;
 updateEnhancedSystems(event:FinalEvent,userMessage:string,reply:string,personaSnapshot?:PersonaSnapshot):Promise<unknown>;
 emotionManager:{updateEmotionFromMessage(groupId:string|number|undefined,text:string,isAtBot:boolean,selfId:string):Promise<unknown>};
 memoryManager:{extractAndSaveMemories(groupId:string|number|undefined,userId:string|number|undefined,text:string,reply:string,context:MemoryExtractionMeta):unknown;extractAndSaveGroupMemories(groupId:string|number,history:MemoryExtractionMessage[],context:MemoryExtractionMeta):unknown}
}
interface FinalPorts {
 randomUUID():string;
 logger:{warn(...args:unknown[]):void;info(...args:unknown[]):void;error(...args:unknown[]):void};bot():{uin:string|number;nickname?:string};
 buildGenericChatFailureReply(text:string,options:{failureKind:string;isGreeting?:boolean;failureDetail?:string}):string;
 extractModrinthForwardItems(text:string):string[];stripModrinthForwardMarkers(text:string):string;
 applyOutputPersonaGuards(text:string,options:{userText:string;toolName?:string|undefined;botNames:string[];personaGuard?:Config['personaGuard'];polish:boolean;interactionContext?:TurnInteractionContext}):string;
 findRecentBotImage(event:FinalEvent,options:{botId:string|number;maxAgeMs:number;limit:number}):Promise<unknown>;
 recordEpisode(options:{groupId:string|number;userId?:string|number|undefined;userName:string;summary:string;reply:string;maxPerGroup:number;source?:PersonaScope}):unknown;
 recordTurnContinuity(options:{groupId?:string|number|undefined;userId?:string|number|undefined;botId:string|number;intent:string;route:string;tools:string[];lastReply:string;persona?:PersonaIdentity;social?:SocialContinuity|undefined}):Promise<unknown>;
 getActiveConversation(event:FinalEvent):{chatHistory?:Message[]}|undefined;trackingKey(event:FinalEvent):string;
 rememberPersonaReply(event:FinalEvent & {message_id?:unknown},text:string,source?:PersonaScope):unknown;rememberStyleReply(event:FinalEvent,text:string,config:unknown):unknown;
}
export function createFinalReply(ports:FinalPorts) {
const {logger,extractModrinthForwardItems,stripModrinthForwardMarkers,applyOutputPersonaGuards,findRecentBotImage,recordEpisode,recordTurnContinuity}=ports
function buildInternalStatusSafeReply(toolName = '', session:FinalSession = {}) {
 const text=[session.rawArgs,session.userContent].filter(Boolean).join('\n')
 if(toolName === 'bananaTool'||isImageGenerationRequest(text))return '这次图片没有完成，不代表你的描述有问题。你可以稍后按原话再试。'
 if(toolName === 'googleImageAnalysisTool'||isImageAnalysisRequest(text))return '图片我收到了，但这次识图服务没有返回可用结果。不是你没发图，我先不乱猜。'
 return ports.buildGenericChatFailureReply(text,{failureKind:'upstream'})
}

async function handleTextResponse(host:FinalReplyHost, content:string, e:FinalEvent, session:FinalSession, messages:Message[], toolName?:string) {
    const personaSnapshot = session.personaSnapshot ?? e._personaSnapshot
    const personaName = personaSnapshot?.personaName ?? resolvePersonaName(host.getPersonaFor(e))
    const replySelfId = personaSnapshot?.botId || e.self_id || e.bot?.uin || ports.bot().uin
    const turnEvent:FinalEvent = personaSnapshot ? Object.assign(Object.create(e), {_personaSnapshot: personaSnapshot}) : e
    e = turnEvent
    const rawUserText = session.rawUserText ?? session.interactionContext?.rawUserText ?? session.rawArgs ?? e.msg ?? ''
    let output = await host.processToolSpecificMessage(content, toolName)
    if (!output) {
      logger.warn("[最终回复清理] 模型回复只包含伪工具格式，已跳过发送")
      return
    }
    const cleaned = redactInternalStatusLeaks(output)
    if (cleaned.redactedChars > 0) {
      if (cleaned.heavy) {
        logger.warn(`[最终回复清理] 内部信息占比过高(${cleaned.kinds.join(",")} ${(cleaned.ratio * 100).toFixed(0)}%)，整段回退: ${output.slice(0, 120)}`)
        output = buildInternalStatusSafeReply(toolName, session)
      } else {
        logger.warn(`[最终回复清理] 已脱敏内部片段(${cleaned.kinds.join(",")} ${cleaned.redactedChars}字)，保留其余回复`)
        output = cleaned.text
      }
    }
    const modrinthItems = toolName === "modrinthTool" ? extractModrinthForwardItems(output) : []
    const modrinthCardItems = modrinthItems.length && Array.isArray(session?.modrinthCardItems)
      ? session.modrinthCardItems
      : []
    if (session?.modrinthCardItems) session.modrinthCardItems = null
    if (toolName === "modrinthTool") output = stripModrinthForwardMarkers(output)
    if (!modrinthItems.length) {
      output = applyOutputPersonaGuards(output, {
        userText: rawUserText,
        ...(session.interactionContext ? {interactionContext: session.interactionContext} : {}),
        toolName,
        botNames: [personaName, ports.bot().nickname].filter((name):name is string=>typeof name === "string"),
        personaGuard: personaSnapshot ? personaSnapshot.personaGuard : host.config.personaGuard,
        polish: true
      })
    } else {
      output = modrinthItems.join("\n\n")
    }
    if (!output) {
      logger.warn("[最终回复清理] 风格拦截后回复为空，已跳过发送")
      return
    }
    const narrativeReply = !modrinthItems.length
      ? splitNarrativeReply(output, rawUserText)
      : null
    if (narrativeReply?.lead) {
      output = narrativeReply.story
      logger.info(`[叙事呈现] 已剥离模型开场 lead=${narrativeReply.lead.length} story=${output.length}`)
    }
    const textImageTemplate = !modrinthItems.length && host.getTextImageTemplateForFinalReply({
      content,
      output,
      session,
      toolName,
      e
    })
    session.responseAttempted = true
    // 最终出口 markdown 兜底:无论上游路径如何判定,只要最终文本含
    // markdown 结构(粗体/列表/围栏)就转卡面——绝不让 **星号裸发到 QQ
    const markdownFallback = !modrinthItems.length && !narrativeReply?.lead && !textImageTemplate && looksLikeCodeOrMarkdown(output)
    const botMessageId = modrinthItems.length
      ? modrinthCardItems.length === modrinthItems.length
        ? await host.sendModrinthForwardCards(e, modrinthCardItems)
        : await host.sendModrinthForwardItems(e, modrinthItems)
      : narrativeReply?.lead
        ? await host.sendFinalReplyAsTextImage(e, output, "document")
        : textImageTemplate || markdownFallback
        ? await host.sendFinalReplyAsTextImage(e, output, textImageTemplate || "document")
        : await host.sendSegmentedMessage(e, output, 0.5, { alreadyGuarded: true })

    const deliveredMessageId = typeof botMessageId === 'string' || typeof botMessageId === 'number' ? botMessageId : extractDeliveryMessageId(botMessageId)
    if (deliveredMessageId === null) {
      logger.warn('[最终回复] 无确认回执，保留已尝试状态，不重发或登记为已发送')
      return
    }

    // 画图请求最终走了纯文字回复且本回合没有出图：给下一轮留失败标记，让模型能接住用户的不满
    if (session?.turnDrawRequested && e.group_id) {
      try {
        const delivered = await findRecentBotImage(e, { botId: e?.bot?.uin || e?.self_id || ports.bot().uin, maxAgeMs: 90000, limit: 12 })
        if (delivered) {
          clearDrawFailureNote(e.group_id)
        } else {
          recordDrawTextFallback(e.group_id, session.rawArgs || session.userContent || e?.msg || "")
          logger.info(`[画图失败标记] group=${e.group_id} 画图请求只得到文字回复，已记录失败标记`)
        }
      } catch (noteError) {
        logger.warn(`[画图失败标记] group=${e.group_id} 记录失败: ${noteError instanceof Error ? noteError.message : noteError}`)
      }
    }

    // 轮末延续摘要：同用户 10 分钟内再来说话时注入上一轮做了什么、回了什么
    session.lastFinalReply = String(output || "").slice(0, 240)
    if (host.config?.episodicMemory?.enabled !== false && e?.group_id) {
      recordEpisode({
        groupId: e.group_id,
        userId: e?.user_id,
        userName: e?.sender?.card || e?.sender?.nickname || "",
        summary: safeTruncateUnicode(rawUserText, 120),
        reply: session.lastFinalReply,
        ...(personaSnapshot ? {source: personaSnapshot} : {}),
        maxPerGroup: Number(host.config?.episodicMemory?.maxPerGroup) || 200
      })
    }
    await recordTurnContinuity({
      groupId: e?.group_id,
      userId: e?.user_id,
      botId: replySelfId,
      ...(personaSnapshot ? {persona: personaSnapshot} : {}),
      intent: session?.modelIntentDecision?.intent || "",
      route: session?.initialExecutionRoute?.mode || "",
      tools: (session?.turnPlan?.outcomes || []).map(outcome => `${outcome.toolName}${outcome.success === false ? "(失败)" : "(成功)"}`).slice(0, 6),
      social:buildSocialContinuity(session.interactionContext, session.lastFinalReply),
      lastReply: session.lastFinalReply
    }).catch(() => {})

    // 更新会话追踪中的对话历史
    if (host.config.conversationTrackingEnabled && e.group_id && e.user_id) {
      const conversationKey = ports.trackingKey(e)
      const activeConv = ports.getActiveConversation(e)
      if (activeConv) {
        // 获取当前对话历史
        let chatHistory = activeConv.chatHistory || []

        // 添加用户消息
        const senderRole = roleMap[e.sender?.role || ""] || "member"
        const senderName = e.sender?.card || e.sender?.nickname || "未知用户"
        const userMsg = `${host.formatTime()} ${senderName}(qq号: ${e.user_id})[群身份: ${senderRole}]: 在群里说: ${safeTruncateUnicode(rawUserText, 200)}`
        chatHistory.push({ role: 'user', content: userMsg })

        // 添加机器人回复
        const turnSelfId = replySelfId
        const botMsg = `${host.formatTime()} ${personaName}(qq号:${turnSelfId})[群身份: member]: 在群里说: ${safeTruncateUnicode(output, 200)}`
        chatHistory.push({ role: 'bot', content: botMsg })

        // 只保留最近10条
        if (chatHistory.length > 10) {
          chatHistory = chatHistory.slice(-10)
        }

        // 重置定时器并更新数据
        host.setTrackingWithTimer(conversationKey, { chatHistory })
      }
    }

    const now = Math.floor(Date.now() / 1000)

    try {
      // 工具结果只保留在本轮上下文和日志中，不写入群聊历史，避免后续普通回复泄露内部状态。
      // 多账号:回复归档用事件自身的 bot 身份与人设名,不再写死主号
      const replyPersonaName = personaName
      await host.messageManager.recordMessage({
        ...(e.message_type?{message_type:e.message_type}:{}),
        ...(e.group_id!==undefined?{group_id:e.group_id}:{}),
        message_id: deliveredMessageId,
        self_id: replySelfId,
        time: now + 1,
        message: [{ type: "text", text: output }],
        source: "send",
        ...(personaSnapshot ? {personaSource: personaSnapshot} : {}),
        sender: { user_id: replySelfId, nickname: replyPersonaName, card: replyPersonaName, role: "member" }
      })
    } catch (error) {
      logger.error("[MessageRecord] 记录消息失败：", error)
    }

    try {
      ports.rememberPersonaReply(Object.assign(Object.create(turnEvent), {message_id: deliveredMessageId}), output, personaSnapshot)
      ports.rememberStyleReply(e, output, host.config.globalStyleLearning)
    } catch (error) {
      logger.warn(`[希洛反馈] 记录最近回复或自主风格轮次失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 保存到 messages 数组
    if (session.toolResults?.length) {
      const existingToolResultIds = new Set(
        messages
          .filter(msg => msg.role === "tool" && msg.tool_call_id)
          .map(msg => msg.tool_call_id)
      )
      for (const { toolCall, toolName: tName, result } of session.toolResults) {
        if (result && result.trim() !== '') {
          const toolCallId = toolCall?.id || ports.randomUUID()
          if (existingToolResultIds.has(toolCallId)) continue
          existingToolResultIds.add(toolCallId)
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            name: tName,
            content: result
          })
        }
      }
    }

    messages.push({ role: "assistant", content: output })
    session.groupUserMessages = host.trimMessageHistory(messages)
    await host.saveGroupUserMessages(e.group_id, e.user_id, messages)

    // 更新情感、记忆、表达学习（异步，不阻塞）
    host.updateEnhancedSystems(turnEvent, rawUserText, output, personaSnapshot).catch(err => {
      logger.error('[增强系统] 更新失败:', err)
    })
  }

async function updateEnhancedSystems(host:FinalReplyHost, e:FinalEvent, userMessage:string, botReply:string, snapshot?:PersonaSnapshot) {
    const personaSource = snapshot ?? e._personaSnapshot
    const heardFrom = personaSource?.personaName ?? resolvePersonaName(host.getPersonaFor(e))
    const at = messageTimestamp(e.time) ?? messageTimestamp(e._receivedAt) ?? Date.now()
    const { group_id: groupId, user_id: userId } = e
    let emotionState = null

    // 1. 更新情感系统
    if (host.config.emotionSystem?.enabled) {
      const isAtBot = messageMentionsUser(e, e?.bot?.uin || e?.self_id || ports.bot().uin)
      emotionState = await host.emotionManager.updateEmotionFromMessage(groupId, userMessage, isAtBot, String(e.self_id || ports.bot().uin || ""))
    }

    // 2. 提取并保存长期记忆（后台异步）
    if (host.config.memorySystem?.enabled) {
      // 不 await，让它在后台执行
      Promise.resolve(host.memoryManager.extractAndSaveMemories(groupId, userId, userMessage, botReply, {
        source: "user",
        messageId: e.message_id,
        senderName: e.sender?.card || e.sender?.nickname,
        at,
        ...(personaSource ? {personaSource} : {}),
        // 共享记忆盖源:这条事实是"当前 bot"在场时听来的,其他 bot 引用时可说"听XX说过"
        heardFrom
      })).catch(error=>logger.warn("[记忆] 用户提取失败",error))
      // 提取群全局记忆（传入聊天记录）
      if (groupId) {
        const history = await host.messageManager.getMessages('group', groupId)
        const eventBotId = String(e?.self_id || e?.bot?.uin || ports.bot().uin)
        const chatHistory = (history || []).slice(0, 40).filter(msg =>
          !msg.forwardCompleteness || msg.forwardCompleteness.state === 'complete'
        ).filter(msg => !(msg.source === 'forward' || /转发了合并聊天记录|转发记录内容|嵌套转发记录|【转发读取范围】/.test(String(msg.content || ''))) || msg.forwardCompleteness?.state === 'complete').flatMap(msg => {
          // self_id identifies the receiving account on inbound group messages;
          // it does not identify the author of that public statement.
          const isBotMsg = msg.source === "send" ||
            String(msg.sender?.user_id || "") === eventBotId
          const at = messageTimestamp(msg.at) ?? messageTimestamp(msg.time)
          const segments = msg.message || []
          const ownText = segments.filter(segment=>segment.type === 'text').map(segment=>segment.text ?? segment.data?.text ?? '').join('')
          const forwardText = segments.filter(segment=>segment.type === 'forward_context').map(segment=>segment.text ?? '').filter(Boolean).join('\n')
          const content = ownText || (!msg.forwardCompleteness ? msg.raw_message : '') || (!segments.length ? msg.content : '') || ''
          const isForward = Boolean(msg.forwardCompleteness && !ownText)
          const rows:MemoryExtractionMessage[] = content ? [{
            role: isBotMsg ? 'assistant' : 'user',
            source: isForward ? 'forward' : msg.source || (isBotMsg ? "send" : "user"),
            ...(msg.sender?.user_id !== undefined ? {authorQQ: String(msg.sender.user_id)} : {}),
            ...(!isForward && at !== undefined ? {at} : {}),
            content: `${isForward ? '[以下为第三方转发，不能归为转发者自述]' : ''}${msg.sender?.nickname || '未知'}(QQ:${msg.sender?.user_id}): ${content}`
          }] : []
          if (forwardText) rows.push({role:'user',source:'forward',...(msg.sender?.user_id !== undefined ? {authorQQ: String(msg.sender.user_id)} : {}),content:`[以下为第三方转发，不能归为转发者自述；原日期仅按记录中明确时间理解]\n${forwardText}`})
          return rows
        })
        Promise.resolve(host.memoryManager.extractAndSaveGroupMemories(groupId, chatHistory, {
          heardFrom, at, ...(personaSource ? {personaSource} : {})
        })).catch(error=>logger.warn("[记忆] 群提取失败",error))
      }
    }

    // 表达学习已移至 handleRandomReply 静默收集，不在此处调用
  }
function messageTimestamp(value:unknown):number|undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return undefined
  const text=value.trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return messageTimestamp(Number(text))
  const local=/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  const parsed=Date.parse(local ? `${local[1]}-${local[2]!.padStart(2,'0')}-${local[3]!.padStart(2,'0')}T${local[4]!.padStart(2,'0')}:${local[5]}:${local[6] || '00'}+08:00` : text)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}
function getFriendlyFailureMessage(toolName = "", context:FailureContext = {}) {
    const committedReply = buildCommittedActionReply(context?.session)
    if (committedReply) return committedReply
    if (toolName === "mentionMembersTool") {
      return buildMentionMembersFailureReply(String(context?.error || context?.failedResult || ""))
    }
    if (toolName === "bananaTool") {
      const errorText = String(context?.error || context?.failedResult || "")
      return buildImageFailureReply(errorText)
    }
    if (toolName === "googleImageAnalysisTool") {
      return appendVisibleFailureDetail(
        "图片我收到了，但这次识图服务没有返回可用结果。不是你没发图，我先不乱猜。",
        context?.error || context?.failedResult || ""
      )
    }
    if (toolName === "googleImageEditTool") {
      const errorText = String(context?.error || context?.failedResult || "")
      return buildImageFailureReply(errorText, { operation: "edit" })
    }
    if (toolName === "searchInformationTool" || toolName === "webParserTool" || toolName === "githubRepoTool") {
      return appendVisibleFailureDetail(
        "你的问题我收到了，但检索服务这次没有完成。我不拿不完整的结果凑答案，也不会说成是你没发清楚。",
        context?.error || context?.failedResult || ""
      )
    }
    if (toolName === "deltaForceTool") {
      const text = String(context?.error || context?.failedResult || "").replace(/^error:\s*/i, "").replace(/^工具\s+deltaForceTool\s+执行失败:\s*/i, "").trim()
      return text ? `三角洲查询失败：${buildVisibleFailureDetail(text)}` : "三角洲接口这次没查成，但你的查询条件已经收到了。"
    }
    if (toolName === "modrinthTool") {
      return appendVisibleFailureDetail(
        "Modrinth 排名数据已经查到，但简介翻译服务这次没有返回完整结果。我先不把缺字段或错位译文发出来。",
        context?.error || context?.failedResult || ""
      )
    }
    if (toolName === "torrentDownloadTool") {
      const rawFailure = String(context?.error || context?.failedResult || "")
        .replace(/^error[:：]\s*/i, "")
        .replace(/^工具\s+torrentDownloadTool\s+执行失败[:：]\s*/i, "")
      const detail = rawFailure.trim()
        ? buildVisibleFailureDetail(rawFailure, { fallback: "没有拿到可下载的文件" })
        : ""
      return detail ? `这个磁链没有开始或完成下载：${detail}` : "这个磁链没有完成下载，我不会把未完成的文件说成已经发出。"
    }

    const userText = [
      context?.session?.rawArgs,
      context?.session?.userContent,
      context?.e?.msg
    ].filter(Boolean).join("\n")
    const failure = classifyChatRequestFailure({ error: context?.error || context?.failedResult || "" })
    return ports.buildGenericChatFailureReply(userText, {
      isGreeting: isCasualBotGreeting(userText),
      failureKind: failure?.kind || "unknown",
      failureDetail: buildVisibleFailureDetail(context?.error || context?.failedResult || "")
    })
  }
async function sendFinalReplyAsTextImage(host:{sendObservedReply(event:FinalEvent,payload:unknown,quote?:boolean,channel?:string):Promise<unknown>;toolInstances?:{textImageTool?:{execute(payload:{text:string;template:string},event:FinalEvent):Promise<unknown>}};sendSegmentedMessage(event:FinalEvent,text:string):Promise<unknown>},e:FinalEvent,output:string,template='chat') {
 let attempted=false
 let receipt:unknown=null
 try {
  const tool=host.toolInstances?.textImageTool
  if(!tool)throw new Error('textImageTool unavailable')
  const cardEvent:FinalEvent=Object.assign(Object.create(e),{_personaSnapshot:e._personaSnapshot,reply:async(payload:unknown,quote?:boolean)=>{attempted=true;receipt=await host.sendObservedReply(e,payload,quote,"agent_final_card");return receipt}})
  const result=await tool.execute({text:output,template},cardEvent)
  if(typeof result === 'string' && result.trim().startsWith('error:'))throw new Error(result)
  return extractDeliveryMessageId(receipt)
 } catch(error) {
  if(attempted){logger.warn('[最终卡面] 投递已尝试，不再自动重发',error);return extractDeliveryMessageId(receipt)}
  logger.warn('[最终卡面] 准备失败，回退为普通文本',error)
  return host.sendSegmentedMessage(e,output)
 }
}
return {handleTextResponse,updateEnhancedSystems,getFriendlyFailureMessage,sendFinalReplyAsTextImage}
}
