// 回复渲染:分段发送/长文切分/@转换/工具专属后处理。
// 从 apps/test.js 原样迁出(P2),行为不变;this 依赖以 host(插件实例)注入。
import { logDeliveryOutcome, extractDeliveryMessageId } from "../../messaging/domain/deliveryObservability.js"



import { sanitizeFinalReplyText, stripChatLogSpeakerPrefixes } from "../domain/replySanitizer.js"
import { containsCodeFence, flattenCodeFences } from "../domain/qqCodeFenceText.js"
import { extractChatKeywords } from "../domain/messageIntent.js"
import { planTextReplyMessages } from "../domain/replyRhythm.js"

import { ThinkingProcessor } from "../../models/domain/thinkingProcessor.js"


// 统计埋点经全局 runtime 符号读取(与 utils/messagePipeline/runtime.js 的 RUNTIME_KEY 约定一致)。
// 不静态 import runtime.js:那会拖入 Yunzai 专属依赖链,破坏本模块在测试环境的独立加载。
// 发送节流器挂在 host 上,配置引用变化时重建(message.yaml 改动重启后生效)
import { SendPacer } from "../domain/sendPacing.js"
type Id = string | number
interface Member {card?:string;nickname?:string}
interface Group {getMemberMap():Promise<Map<number,Member>>}
export interface ReplyEvent {group_id?:Id;user_id?:Id;self_id?:Id;bot?:{uin?:Id};group?:Group;msg?:string;_proactiveReply?:boolean;_proactiveReplyAnchorAt?:number;_forbiddenAnchorAt?:number;message_type?:string;reply(payload:unknown,quote?:boolean):Promise<unknown>}
interface ReplyConfig {sendPacing?:ConstructorParameters<typeof SendPacer>[0];forbiddenWords?:import('../domain/forbiddenWordGuard.js').ForbiddenConfig;persona?:{name?:string};personaGuard?:{enabled?:boolean;badPatterns?:string[]};chatTriggerMode?:string;smartTrigger?:{continuationKeywordMaxCount?:number;proactiveReplyNoQuote?:boolean;typingSpeed?:number};replyRhythm?:Parameters<typeof planTextReplyMessages>[1];messageSplitMaxChars?:number;messageSplitMaxSegments?:number}
export interface ReplyDeliveryPort {
 config:ReplyConfig;_sendPacer?:SendPacer;_sendPacerSource?:ReplyConfig['sendPacing'];
 claimTurnReply?(event:ReplyEvent):Promise<{claimed?:boolean}|null>;sendObservedReply(event:ReplyEvent,payload:unknown,quote:boolean,channel:string):Promise<unknown>;
 getPersonaFor?(event:ReplyEvent):{name?:string};getSmartState(groupId:Id,event:ReplyEvent):{lastBotReplyAt:number;lastBotReplyToUserId:string|null;lastBotReplyKeywords:string[]};
 splitMessage(text:string):string[];splitLongMessageByPunctuation(text:string,maxChars:number,maxSegments:number):string[];
 convertAtInString(text:string,group:Group):Promise<{hasAt:boolean;msgSegments:unknown[]|null}>;
 findMember(target:string,members:Map<number,Member>):{qq:number;info:Member}|null
}
interface SendStatsContext {botId?:Id|undefined;groupId:string;channel:string}
interface RenderingPorts {
 logger:{info(message:string):void;warn(message:string):void;mark(message:string):void;error(message:string):void};bot:()=>{uin?:Id;nickname?:string};at(qq:number):unknown;
 lastIncoming(groupId:Id|undefined,event:ReplyEvent):number;shouldCancelProactiveReply(event:ReplyEvent,last:number):boolean;
 guard:ReturnType<typeof import('../domain/forbiddenWordGuard.js').createForbiddenWordGuard>;
 applyOutputPersonaGuards(text:string,options:{userText:string;botNames:string[];personaGuard?:ReplyConfig['personaGuard']}):string;
 TotalTokens(text:string):Promise<{total_tokens:number}>;
 stats():{recordSend(context:SendStatsContext):void;recordFailure(context:SendStatsContext & {code:string}):void}|null;
}
export function createReplyRendering(ports:RenderingPorts) {
const {logger,TotalTokens,shouldCancelProactiveReply,applyOutputPersonaGuards}=ports
const {findForbiddenWord,isConversationInterrupted,markConversationInterrupted,extractReplyText}=ports.guard
function pacerFor(host:ReplyDeliveryPort) {
    if (!host) return null
    const configSource = host.config?.sendPacing
    if (!host._sendPacer || host._sendPacerSource !== configSource) {
        host._sendPacer = new SendPacer(configSource || {})
        host._sendPacerSource = configSource
    }
    return host._sendPacer
}

// 出站违禁词黑名单统一咽喉检查:
// 1) 该群会话已被违禁词中断且中断晚于本回合锚点 → 丢弃(中断当前对话);
// 2) bot 自己要说的话含违禁词(blockOutput) → 拦截本条并同样中断本回合。
// 返回 true 表示已拦截,调用方应放弃本次发送。
function shouldBlockByForbiddenWords(host:ReplyDeliveryPort, e:ReplyEvent, text:unknown, where:string) {
    const cfg = host?.config?.forbiddenWords
    if (cfg?.enabled === false) return false
    const groupId = e?.group_id
    if (isConversationInterrupted(e)) {
      logger.info(`[违禁词中断] group=${groupId || ""} ${where} 本回合已被中断，丢弃发送`)
      return true
    }
    if (cfg && cfg.blockOutput !== false) {
      const word = findForbiddenWord(extractReplyText(text), cfg)
      if (word) {
        markConversationInterrupted(groupId)
        logger.mark(`[违禁词拦截] group=${groupId || ""} ${where} 出站内容命中「${word}」，已拦截并中断本回合`)
        return true
      }
    }
    return false
  }

async function sendObservedReply(host:ReplyDeliveryPort, e:ReplyEvent, payload:unknown, quote = false, channel = "command") {
    const stats = ports.stats()
    const statsContext = {
      botId: e?.self_id || e?.bot?.uin || ports.bot().uin,
      groupId: e?.group_id ? String(e.group_id) : "",
      channel
    }
    try {
      if (shouldBlockByForbiddenWords(host, e, payload, `channel=${channel}`)) return null
      const pacer = pacerFor(host)
      try {
        await pacer?.before(e, channel)
      } catch {
        // 节流 fail-open,绝不阻断发送
      }
      const result = await e.reply(payload, quote)
      try {
        pacer?.markSent(e, channel)
      } catch {}
      logDeliveryOutcome(logger, {
        status: extractDeliveryMessageId(result) === null ? "unknown" : "sent",
        channel,
        groupId: e?.group_id ?? "",
        userId: e?.user_id ?? "",
        messageId: extractDeliveryMessageId(result)
      })
      if(extractDeliveryMessageId(result) === null) stats?.recordFailure({...statsContext,code:"delivery_unknown"})
      else stats?.recordSend(statsContext)
      return result
    } catch (error) {
      logDeliveryOutcome(logger, {
        status: "failed",
        channel,
        groupId: e?.group_id ?? "",
        userId: e?.user_id ?? "",
        error
      })
      stats?.recordFailure({ ...statsContext, code: "reply_error" })
      throw error
    }
  }

async function sendSegmentedMessage(host:ReplyDeliveryPort, e:ReplyEvent, output:string, quoteChance = 0.5, { alreadyGuarded = false } = {}) {
    let deliveryAttempted = false
    try {
      const groupId = e?.group_id
      if (shouldCancelProactiveReply(e, ports.lastIncoming(groupId,e) || 0)) {
        logger.info(`[回复新鲜度] group=${groupId || ""} cancelled anchor=${e?._proactiveReplyAnchorAt || 0} latest=${ports.lastIncoming(groupId,e) || 0}`)
        return null
      }
      if (shouldBlockByForbiddenWords(host, e, output, "分段回复")) return null
      // 出站幂等（回合持久化）：本回合已有另一份执行发出过回复时跳过，防止补跑后重复刷屏
      if (typeof host?.claimTurnReply === "function") {
        const claim = await host.claimTurnReply(e)
        if (claim && claim.claimed === false) {
          logger.info(`[回合持久化] group=${groupId || ""} 回复已被认领，跳过重复发送`)
          return null
        }
      }
      const replyWithReceipt = async (payload:unknown, quote:boolean, channel = "agent_text") => {
        deliveryAttempted = true
        const result=await host.sendObservedReply(e,payload,quote,channel)
        if(extractDeliveryMessageId(result) !== null) {
      // smart 模式：发完话后记录 bot 上次发言时间和关键词，给 prefilter R1/R2 识别接续用
      const triggerMode = String(host.config?.chatTriggerMode || 'strict').toLowerCase()
      if (groupId && triggerMode === 'smart') {
        try {
          const st = host.getSmartState(groupId,e)
          st.lastBotReplyAt = Date.now()
          st.lastBotReplyToUserId = e?.user_id ? String(e.user_id) : null
          const maxKw = Number(host.config?.smartTrigger?.continuationKeywordMaxCount) || 5
          st.lastBotReplyKeywords = extractChatKeywords(output, maxKw)
          logger.info(`[SmartState] group=${groupId} 记录bot回复 user=${st.lastBotReplyToUserId || ''} keywords=${JSON.stringify(st.lastBotReplyKeywords)}`)
        } catch (err) {
          logger.warn(`[SmartState] 记录 bot 发言失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
        }
        return result
      }
      if (typeof output === "string" && !alreadyGuarded) {
        output = applyOutputPersonaGuards(output, {
          userText: e?.msg || "",
          botNames: [ports.bot().nickname, (typeof host.getPersonaFor === "function" ? host.getPersonaFor(e) : host.config?.persona)?.name].filter((name):name is string=>typeof name === "string"),
          personaGuard: host.config.personaGuard
        })
      }
      output = sanitizeFinalReplyText(output)
      // QQ 不渲染围栏代码块，会把 ```bash 拆成 `` bash、游离反引号等碎片；
      // 走纯文本兜底时先压平成逐行行内代码胶囊。
      if (containsCodeFence(output)) {
        const flattened = flattenCodeFences(output)
        if (flattened !== output) {
          logger.info(`[代码块压平] 纯文本回复含围栏代码块，已转为行内代码发送 len=${output.length}`)
          output = flattened
        }
      }
      if (!output) return null
      if (output.includes("\\n")) {
        logger.warn(`[分段发送] sanitize后仍含字面\\n! raw=${JSON.stringify(output).slice(0, 200)}`)
      }
      // 主动搭话路径（smart 模式 Gate 非 force 触发）强制不引用：bot 像群友自然插话而非"回复某人"
      if (e?._proactiveReply && host.config?.smartTrigger?.proactiveReplyNoQuote !== false) {
        quoteChance = 0
      }
      const shouldQuote = Math.random() < quoteChance

      // @ 转换可能失败（group 对象过期等），失败时跳过不影响分段
      let groupForAt = null
      try {
        groupForAt = e.group
      } catch {}

      const rhythmPlan = planTextReplyMessages(output, {
        ...(host.config?.replyRhythm || {}),
        userText: e?.msg || ""
      })
      const messageSegments = rhythmPlan.messages.length > 1
        ? rhythmPlan.messages
        : host.splitMessage(output)

      // 含 @ 时也要分段：先拆分再对每段单独处理 @
      const hasNewline = output.includes("\n")
      if (groupForAt && hasNewline) {
        try {
          const { hasAt } = await host.convertAtInString(output, groupForAt)
          if (hasAt) {
            let lastMessageId = null
            for (let i = 0; i < messageSegments.length; i++) {
              const seg = messageSegments[i]?.trim()
              if (!seg) continue
              const { hasAt: segHasAt, msgSegments } = await host.convertAtInString(seg, groupForAt)
              const quote = shouldQuote && i === 0
              if (segHasAt && msgSegments) {
                const res = await replyWithReceipt(msgSegments, quote)
                lastMessageId = extractDeliveryMessageId(res)
              } else {
                const res = await replyWithReceipt(seg, quote)
                lastMessageId = extractDeliveryMessageId(res)
              }
              if (i < messageSegments.length - 1) {
                const typingSpeed = Number(host.config?.smartTrigger?.typingSpeed) || 0
                let delay
                if (typingSpeed > 0) {
                  delay = Math.min(Math.max(seg.length * 1000 / typingSpeed + Math.random() * 300, 200), 5000)
                } else {
                  delay = Math.min(1000 + seg.length * 5 + Math.random() * 500, 3000)
                }
                await new Promise(r => setTimeout(r, delay))
              }
            }
            return lastMessageId
          }
        } catch (err) {
          if (deliveryAttempted) throw err
          logger.warn(`[分段发送] @ 分段处理失败，走普通分段: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // 无换行时含 @ 直接发（不需要分段）
      if (groupForAt && !hasNewline) {
        try {
          const { hasAt, msgSegments } = await host.convertAtInString(output, groupForAt)
          if (hasAt && msgSegments) {
            const res = await replyWithReceipt(msgSegments, false)
            return extractDeliveryMessageId(res)
          }
        } catch (err) {
          if (deliveryAttempted) throw err
          logger.warn(`[分段发送] convertAtInString 失败，跳过 @ 转换: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // token 计算可能失败，失败时默认走分段逻辑
      let totalTokens = 999
      try {
        const result = await TotalTokens(output)
        totalTokens = result.total_tokens
      } catch (err) {
        logger.warn(`[分段发送] TotalTokens 计算失败，按需分段: ${err instanceof Error ? err.message : String(err)}`)
      }

      let lastMessageId = null
      if (totalTokens <= 10 && !hasNewline) {
        const res = await replyWithReceipt(output, shouldQuote)
        lastMessageId = extractDeliveryMessageId(res)
        return lastMessageId
      }

      for (let i = 0; i < messageSegments.length; i++) {
        if (messageSegments[i]?.trim()) {
          const quote = shouldQuote && i === 0
          const res = await replyWithReceipt(messageSegments[i]!.trim(), quote)
          lastMessageId = extractDeliveryMessageId(res)

          if (i < messageSegments.length - 1) {
            const typingSpeed = Number(host.config?.smartTrigger?.typingSpeed) || 0
            let delay
            if (typingSpeed > 0) {
              delay = Math.min(Math.max(messageSegments[i]!.length * 1000 / typingSpeed + Math.random() * 300, 200), 5000)
            } else {
              delay = Math.min(1000 + messageSegments[i]!.length * 5 + Math.random() * 500, 3000)
            }
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }
      return lastMessageId
    } catch (error) {
      logger.error(`[分段发送] ${error instanceof Error ? error.message : String(error)}`)
      if (deliveryAttempted) return null
      try {return extractDeliveryMessageId(await host.sendObservedReply(e, String(output || "").trim(), false, "agent_text_fallback"))} catch {return null}
    }
  }

function splitMessage(host:Pick<ReplyDeliveryPort,"config"|"splitLongMessageByPunctuation">, text:string) {
    const maxChars = Math.max(300, Number(host.config?.messageSplitMaxChars) || 900)
    const maxSegments = Math.max(1, Number(host.config?.messageSplitMaxSegments) || 2)
    const rawText = String(text || "").trim()
    if (!rawText || rawText.length <= maxChars) return rawText ? [rawText] : []

    const paragraphs = rawText.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
    const lineBlocks = paragraphs.length > 1
      ? paragraphs
      : rawText.split(/\n/).map(s => s.trim()).filter(Boolean)

    const merged = []
    let current = ""
    for (const block of lineBlocks) {
      const candidate = current ? `${current}\n${block}` : block
      if (candidate.length <= maxChars) {
        current = candidate
        continue
      }
      if (current) merged.push(current)
      current = block
    }
    if (current) merged.push(current)

    if (merged.length > 1) {
      if (merged.length <= maxSegments) return merged
      const result = merged.slice(0, maxSegments - 1)
      result.push(merged.slice(maxSegments - 1).join("\n"))
      return result
    }

    return host.splitLongMessageByPunctuation(rawText, maxChars, maxSegments)
  }

function splitLongMessageByPunctuation(host:unknown, text:string, maxChars = 900, maxSegments = 3) {
    const punctuations = ["。", "！", "？", "；", "!", "?", ";", "\n"]
    const cqCodes:string[] = [], emojis:string[] = []
    let processed = text

    processed = processed.replace(/$$CQ:[^$$]+$$/g, m => { cqCodes.push(m); return `{{CQ${cqCodes.length - 1}}}` })
    processed = processed.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/gu, m => { emojis.push(m); return `{{E${emojis.length - 1}}}` })
    processed = processed.replace(/\.{3,}|…+/g, "{{...}}")

    const idealLen = Math.min(maxChars, Math.ceil(processed.length / Math.min(Math.ceil(processed.length / maxChars), maxSegments)))
    const points = []
    let last = 0

    for (let i = 0; i < processed.length; i++) {
      const ch = processed[i]!
      if (ch === '\n') {
        if (i - last + 1 < idealLen * 0.7) continue
        points.push(i + 1)
        last = i + 1
      } else if (punctuations.includes(ch) && i - last + 1 >= idealLen * 0.7) {
        points.push(i + 1)
        last = i + 1
      }
    }

    const segments = []
    let start = 0
    for (const p of points) {
      if (p > start) { segments.push(processed.slice(start, p)); start = p }
    }
    if (start < processed.length) segments.push(processed.slice(start))
    if (segments.length > maxSegments) {
      return [
        ...segments.slice(0, maxSegments - 1),
        segments.slice(maxSegments - 1).join("")
      ].map(s =>
        s.replace(/{{\.\.\.}}/g, "...")
          .replace(/{{CQ(\d+)}}/g, (_, i) => cqCodes[Number(i)] ?? "")
          .replace(/{{E(\d+)}}/g, (_, i) => emojis[Number(i)] ?? "")
          .trim()
      )
    }

    return segments.map(s =>
      s.replace(/{{\.\.\.}}/g, "...")
        .replace(/{{CQ(\d+)}}/g, (_, i) => cqCodes[Number(i)] ?? "")
        .replace(/{{E(\d+)}}/g, (_, i) => emojis[Number(i)] ?? "")
        .trim()
    )
  }

async function convertAtInString(host:Pick<ReplyDeliveryPort,"findMember">, content:string, group:Group|null|undefined) {
    if (!group) return { result: content, hasAt: false, msgSegments: null }

    const members = await group.getMemberMap()
    const atList = []

    // 匹配 @QQ号 格式（5-11位纯数字）
    for (const match of content.matchAll(/@(\d{5,11})(?!\d)/g)) {
      const member = host.findMember(match[1]!, members)
      if (member) {
        atList.push({ index: match.index, length: match[0].length, qq: member.qq })
      }
    }

    // 匹配 @昵称 格式（非数字开头，取到标点或空白为止）
    for (const match of content.matchAll(/@([^\s\d@，。！？、；：""''（）【】,.!?;:'"()\[\]]{1,20})/g)) {
      const member = host.findMember(match[1]!, members)
      if (member && !atList.some(a => a.qq === member.qq)) {
        atList.push({ index: match.index, length: match[0].length, qq: member.qq })
      }
    }

    if (atList.length === 0) return { result: content, hasAt: false, msgSegments: null }

    // 按位置排序，构建消息段数组（@ 保持在原始位置）
    atList.sort((a, b) => a.index - b.index)
    const msgSegments = []
    let lastEnd = 0
    for (const at of atList) {
      if (at.index > lastEnd) {
        msgSegments.push(content.slice(lastEnd, at.index))
      }
      msgSegments.push(ports.at(at.qq))
      lastEnd = at.index + at.length
    }
    if (lastEnd < content.length) {
      msgSegments.push(content.slice(lastEnd))
    }

    return { result: content, hasAt: true, msgSegments }
  }

function findMember(host:unknown, target:string, members:Map<number,Member>) {
    if (/^\d+$/.test(target)) {
      const member = members.get(Number(target))
      if (member) return { qq: Number(target), info: member }
    }

    const search = target.toLowerCase()
    for (const [qq, info] of members) {
      if ([info.card, info.nickname].some(n => n?.toLowerCase().includes(search))) {
        return { qq, info }
      }
    }
    return null
  }

function processToolSpecificMessage(host:unknown, content:string, toolName:string) {
    let output = sanitizeFinalReplyText(content.replace(/\n/g, "\n"))

    // 模型有时会照抄上下文里的聊天记录前缀；这里只剥掉前缀，保留真正回复内容。
    output = stripChatLogSpeakerPrefixes(output)

    // 清理模式
    const patterns = [
      /$$图片$$/g,
      /[\s\S]在群里说[:：]\s/g,
      /\[(?:\d{4}-\d{2}-\d{2}\s+|\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\]\s*.?[:：]\s/g,
      /[\s\S]*?/g
    ]

    for (const p of patterns) output = output.replace(p, "").trim()
    // 提取消息内容
    const match = /$$群身份: .+?$$[:：]\s*(.)/i.exec(output)
    if (match) output = match[1] ?? ""
    output = output.replace(/^[说說][:：]\s/, "")

    output = ThinkingProcessor.removeThinking(output)
    output = output.replace(/!?$$(.*?)$$(.∗?)(.∗?)/g, "$1\n- $2")
    // 清理多余空行
    output = output.replace(/\n{3,}/g, '\n').trim()
    return sanitizeFinalReplyText(output)
  }

  /**
   * 初始化MCP服务器连接
   */

return {sendObservedReply,sendSegmentedMessage,splitMessage,splitLongMessageByPunctuation,convertAtInString,findMember,processToolSpecificMessage}
}
