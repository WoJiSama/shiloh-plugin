import type {ChatMember} from '../../../contracts/chatEvent.js'
import { buildStructuredHistoryMessage } from "../domain/agentIntelligence.js"
import { compactDrawPromptText } from "../domain/textPolicy.js"
import { formatMemberDisplayName } from "../domain/messageContext.js"
import { getMentionTargetId } from "../domain/mentionTargets.js"
import { ROLE_MAP as roleMap } from "../domain/messageContext.js"
interface Segment {type?:string;text?:string;qq?:unknown;user_id?:unknown;url?:unknown;file_url?:unknown;file?:unknown;name?:unknown;data?:{url?:unknown;file_url?:unknown;file?:unknown;name?:unknown;qq?:unknown;user_id?:unknown}}
interface Reply {sender?:ChatMember;message?:Segment[];raw_message?:string;message_id?:string|number}
interface Group {getMemberMap():Promise<Map<number,ChatMember>>}
export interface FormatEvent {message_id?:string|number;group?:Group;message?:Segment[];getReply?():Promise<Reply|null>;_groupContextAssets?:{reply?:Reply;quotedForwardText?:string;currentForwardText?:string};_groupContextImagePrompt?:string;_quotedPromptContext?:{senderName:string;messageId:string;text:string;mediaSummary:string}}
export interface MessageFormattingPort {resolveForwardPromptFromSegments(segments:Segment[],group?:Group):Promise<string>;formatTime():string}
export function createMessageFormatting(ports:{botId():unknown;error(message:string,error:unknown):void}) {
// 消息格式化:用户内容组装(CQ/引用/媒体)与聊天历史格式化。
// 从 apps/test.js 原样迁出(行为不变),this 依赖以 host 注入。



function formatTime(host:unknown) {
    const now = new Date()
    const pad = (n:number) => String(n).padStart(2, "0")
    return `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`
}

async function buildMessageContent(host:MessageFormattingPort, sender:ChatMember, msg:string, images:unknown[], atQq:unknown[] = [], group?:Group, e:FormatEvent|null = null) {
    const senderRole = roleMap[sender.role || ""] || "member"
    const messageId = e?.message_id ? `[消息ID:${e.message_id}]` : ''
    let senderMember = sender
    if (group && sender?.user_id) {
      try {
        const memberMap = await group.getMemberMap()
        senderMember = memberMap.get(Number(sender.user_id)) || sender
      } catch {}
    }
    const senderInfo = `${formatMemberDisplayName(senderMember, sender.card || sender.nickname)}(qq号: ${sender.user_id})[群身份: ${senderRole}]${messageId}`

    let atContent = ""
    if (atQq.length > 0 && group) {
      const memberMap = await group.getMemberMap()
      const atUsers = atQq.map(qq => {
        const info = memberMap.get(Number(qq))
        if (!info) return `@未知用户(${qq})`
        return `@${formatMemberDisplayName(info)}`
      })
      atContent = `${atUsers.join(" ")} `
    }

    let quoteContent = ""
    if (e?.getReply) {
      try {
        const reply = e?._groupContextAssets?.reply || await e.getReply()
        if (reply) {
          const quotedSender = reply.sender
          let quotedMsg = ""
          let forwardPromptText = ""
          if (reply.message && Array.isArray(reply.message)) {
            quotedMsg = reply.message
              .filter(m => m.type === "text")
              .map(m => m.text)
              .join("")
              .trim()
          } else if (typeof reply.raw_message === "string") {
            quotedMsg = reply.raw_message
          }

          // 提取被引用消息中的转发记录内容，递归展开嵌套合并转发。
          let forwardContent = ""
          forwardPromptText = e?._groupContextAssets?.quotedForwardText ||
            await host.resolveForwardPromptFromSegments(reply.message || [], e?.group || group)
          if (forwardPromptText) {
            forwardContent = `[转发记录内容:\n${forwardPromptText}\n]`
          }

          const quotedImages = reply.message?.filter(m => m.type === "image") || []
          const hasQuotedImage = quotedImages.length > 0

          // 视频 / 语音 / 文件 segment（之前没处理，导致引用视频时 LLM 看到的描述只是"一条消息"，
          // 看不到视频链接也就没法调 videoAnalysisTool 分析）
          const quotedVideos = reply.message?.filter(m => m.type === "video") || []
          const videoUrls = quotedVideos
            .map(v => v?.url || v?.file_url || v?.data?.url || v?.data?.file_url || v?.file || v?.data?.file)
            .filter(Boolean)
          const hasQuotedVideo = quotedVideos.length > 0

          const quotedRecords = reply.message?.filter(m => m.type === "record") || []
          const recordUrls = quotedRecords
            .map(r => r?.url || r?.file_url || r?.data?.url || r?.data?.file_url || r?.file || r?.data?.file)
            .filter(Boolean)
          const hasQuotedRecord = quotedRecords.length > 0

          const quotedFiles = reply.message?.filter(m => m.type === "file") || []
          const fileNames = quotedFiles
            .map(f => f?.name || f?.data?.name || f?.file || f?.data?.file)
            .filter(Boolean)
          const hasQuotedFile = quotedFiles.length > 0

          if (quotedSender) {
            let quotedNickname = quotedSender.nickname || quotedSender.card || "未知用户"

            if (group) {
              try {
                const memberMap = await group.getMemberMap()
                const quotedMemberInfo = memberMap.get(Number(quotedSender.user_id))
                if (quotedMemberInfo) {
                  quotedNickname = formatMemberDisplayName(quotedMemberInfo, quotedNickname)
                }
              } catch (err) {
              }
            }

            const quotedMessageId = reply.message_id ? `(消息ID:${reply.message_id})` : ''

            const parts = []
            if (quotedMsg) parts.push(`"${quotedMsg}"`)
            if (forwardContent) parts.push(forwardContent)
            if (hasQuotedImage) parts.push(`${quotedImages.length}张图片`)
            if (hasQuotedVideo) {
              const urlText = videoUrls.length ? `(链接: ${videoUrls.join(", ")})` : ""
              parts.push(`一段视频${urlText}`)
            }
            if (hasQuotedRecord) {
              const urlText = recordUrls.length ? `(链接: ${recordUrls.join(", ")})` : ""
              parts.push(`一段语音${urlText}`)
            }
            if (hasQuotedFile) {
              const fileText = fileNames.length ? `(文件名: ${fileNames.join(", ")})` : ""
              parts.push(`一个文件${fileText}`)
            }
            const quotedDescription = parts.length > 0 ? parts.join("，以及") : "一条消息"

            quoteContent = `[回复 ${quotedNickname}${quotedMessageId}的消息: ${quotedDescription}] `
            if (e) {
              const promptParts = []
              if (quotedMsg) promptParts.push(quotedMsg)
              if (forwardPromptText) promptParts.push(forwardPromptText)
              e._quotedPromptContext = {
                senderName: quotedNickname,
                messageId: reply.message_id ? String(reply.message_id) : "",
                text: compactDrawPromptText(promptParts.join("\n"), 2600),
                mediaSummary: [
                  hasQuotedImage ? `${quotedImages.length}张图片` : "",
                  hasQuotedVideo ? "一段视频" : "",
                  hasQuotedRecord ? "一段语音" : "",
                  hasQuotedFile ? `文件${fileNames.length ? `: ${fileNames.join(", ")}` : ""}` : ""
                 ].filter(Boolean).join("，")
              }
            }
          }
        }
      } catch (error) {
        ports.error("获取引用消息失败:", error)
      }
    }

    const content = []
    if (msg) {
      let fullMsg = msg
      if (e?.message && group && atQq.length > 0) {
        try {
          const memberMap = await group.getMemberMap()
          fullMsg = e.message.map(m => {
            if (m.type === 'text') return m.text
            const mentionedUserId = m.type === 'at' ? getMentionTargetId(m) : null
            if (mentionedUserId && String(mentionedUserId) !== String(ports.botId())) {
              const info = memberMap.get(Number(mentionedUserId))
              return `@${info ? formatMemberDisplayName(info) : mentionedUserId}`
            }
            return ''
          }).join('').replace(/^#tool\s*/, '').trim()
        } catch {}
      }
      content.push(`在群里说: ${fullMsg}`)
    }
    const currentForwardPromptText = e?._groupContextAssets?.currentForwardText ||
      await host.resolveForwardPromptFromSegments(e?.message || [], group)
    if (currentForwardPromptText) {
      content.push(`转发了合并聊天记录:\n${currentForwardPromptText}`)
    }
    if (images?.length) {
      content.push(`发送了${images.length === 1 ? "一张" : images.length + " 张"}图片${images.map(img => `\n![图片](${img})`).join("")}`)
    }
    if (e?._groupContextImagePrompt) {
      content.push(e._groupContextImagePrompt)
    }

    return `${host.formatTime()} ${senderInfo}: ${quoteContent}${atContent}${content.join("，")}`
}

function formatMessages(host:unknown, messages:Parameters<typeof buildStructuredHistoryMessage>[0], e:unknown, currentUserContent:unknown = null) {
    if (!messages?.length) return messages

    const systemMsgs = messages.filter(m => m.role === "system")
    const lastUser = messages[messages.length - 1]?.role === "user" ? [messages[messages.length - 1]!] : []
    const middle = messages
      .slice(systemMsgs.length, messages.length - lastUser.length)
      .filter(message => !String(message?.content || "").startsWith("【系统提示】"))
    const historyContext = buildStructuredHistoryMessage(middle)

    return [
      ...systemMsgs,
      historyContext,
      ...lastUser
     ].filter((message):message is NonNullable<typeof message>=>message != null)
}

return {formatTime,buildMessageContent,formatMessages}
}
