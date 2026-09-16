import { AbstractTool } from "./AbstractTool.js"
import { emojiPackManager } from "../../domains/emoji/EmojiPackManager.js"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"
import { pluginBridge } from "../../utils/pluginBridge.js"
import { describeEmojiSelectionCriteria, normalizeEmojiSelectionCriteria } from "../../domains/emoji/emojiSelection.js"
import { planEmojiReplySequence } from "../../utils/replyRhythm.js"
import fs from "fs"

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class SendLocalEmojiTool extends AbstractTool {
  constructor() {
    super()
    const vocabulary = emojiPackManager.getSelectionVocabularySync()
    const importantUseCases = [
      "接梗吐槽", "群友翻车", "无言以对", "看到离谱", "轻微嘲讽", "想装无辜",
      "被人夸奖", "场面尴尬", "认怂求饶", "安慰对方", "拒绝加班", "累到躺平",
      "表达喜欢", "分享快乐", "接梗摸头", "委屈诉苦", "突然破防", "装可怜", "求原谅"
    ]
    const actualUseCases = new Set(vocabulary.useCases)
    const useCaseOptions = [
      ...importantUseCases.filter(scene => actualUseCases.has(scene)),
      ...vocabulary.useCases
    ].filter((scene, index, list) => list.indexOf(scene) === index).slice(0, 120)
    const tagItemSchema = {
      type: "string",
      ...(vocabulary.tags.length ? { enum: vocabulary.tags } : {})
    }
    const useCaseItemSchema = {
      type: "string",
      ...(useCaseOptions.length ? { enum: useCaseOptions } : {})
    }
    this.name = "sendLocalEmojiTool"
    this.description = [
      "此工具你可以积极主动调用",
      "从本地表情包库挑选一张合适的表情包发送到当前会话。",
      "表情包是整轮对话的一部分：不调用=只回文字；不填配文=只发表情；leadText 在表情前说，followUpText 在表情后补。",
      "适合场景：轻松短闲聊里的情绪共鸣（笑/无奈/惊讶/共鸣）、玩笑接梗、表达态度；不要机械地每轮都调用。",
      "不适合场景：严肃问答、技术讨论、对方在咨询正式问题或寻求帮助。",
      "当一张表情包已经足够表达当前反应时，可以只发表情包，不要再用 followUpText 重复同一句情绪。",
      "默认整轮只发一张表情。只有短反应或表情无法承载的关键信息，才加 leadText 或 followUpText；极少数确有转折的场景才两边都填。"
    ].join("\n")
    this.parameters = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: tagItemSchema,
          description: [
            "按相关度从高到低填写 1-5 个库内情绪/反应标签，第一个是最想表达的主情绪。",
            "优先使用线上库真实标签：吐槽、得意、无奈、卖萌、嘲讽、崩溃、无语、敷衍、震惊、委屈、傲娇、心动、嫌弃、摆烂、尴尬、无辜、开心、笑死、疑惑、绝望、惊讶、懵逼、认怂、自嘲、心虚、害羞、疲惫、破防、兴奋、安慰。",
            "不要填写画风、角色、动物等物体词。"
          ].join("\n")
        },
        useCases: {
          type: "array",
          items: useCaseItemSchema,
          description: "可选，按相关度填写 1-4 个具体使用场景。优先使用库内真实场景，如：接梗吐槽、群友翻车、无言以对、看到离谱、轻微嘲讽、想装无辜、被人夸奖、场面尴尬、认怂求饶、安慰对方、拒绝加班。"
        },
        query: {
          type: "string",
          description: "可选，仅补充 tags/useCases 没表达出的简短关键词，不要写完整场景长句；例如“猫猫”“摸头”。"
        },
        leadText: {
          type: "string",
          description: "可选，表情包之前说的短反应，不超过 80 字。只有这句话先说、随后甩图更自然时填写；不要和表情重复表达。"
        },
        followUpText: {
          type: "string",
          description: "可选，表情包之后补的独立信息，不超过 80 字。只在表情发完后仍有事实、行动或转折必须说时填写；不要重复图已经表达的情绪。"
        }
      },
      required: ["tags"],
      additionalProperties: false
    }
  }

  async func(opts, e) {
    emojiPackManager.refreshConfig()

    if (!emojiPackManager.config?.enabled) {
      return "error: 表情包系统未启用，请在 config/message.yaml 中将 emojiSystem.enabled 设为 true"
    }

    const criteria = normalizeEmojiSelectionCriteria(opts)
    if (!criteria.tags.length && !criteria.useCases.length && !criteria.query) {
      return "error: tags、useCases、query 至少需要提供一项"
    }

    const groupId = e?.group_id || e?.user_id

    const rl = emojiPackManager.checkRateLimit(groupId)
    if (!rl.allowed) {
      return `error: 近期 ${rl.windowMinutes} 分钟内已发送 ${rl.count} 张表情包（上限 ${rl.max}），本轮请直接用文字回复，不要再调用本工具`
    }

    const { item, strategy, score, criteria: matchedCriteria } = await emojiPackManager.selectEmoji(criteria, { groupId })
    if (!item) {
      return "error: 本地表情包库为空，请先通过 #表情包导入 添加表情包"
    }

    const absPath = emojiPackManager.getAbsoluteFilePath(item)
    if (!fs.existsSync(absPath)) {
      return `error: 表情包文件丢失: ${item.hash.slice(0, 8)}`
    }

    const rhythm = planEmojiReplySequence({
      leadText: safeTruncateUnicode(String(opts.leadText || "").trim(), 80),
      followUpText: safeTruncateUnicode(String(opts.followUpText || "").trim(), 80)
    }, {
      ...(pluginBridge.instance?.config?.replyRhythm || {}),
      ...(emojiPackManager.config || {})
    })
    const replyMode = rhythm.layout === "emoji" ? "emoji_only" : rhythm.layout

    let textSent = false
    let emojiSent = false
    try {
      const cfg = emojiPackManager.config
      const minMs = Math.max(0, Number(cfg.followUpDelayMinMs) || 300)
      const maxMs = Math.max(minMs, Number(cfg.followUpDelayMaxMs) || 800)
      const instance = pluginBridge.instance
      for (let index = 0; index < rhythm.sequence.length; index++) {
        const part = rhythm.sequence[index]
        if (part.type === "text") {
          if (instance?.sendSegmentedMessage) {
            await instance.sendSegmentedMessage(e, part.text, 0)
          } else {
            await e.reply(part.text)
          }
          textSent = true
        } else {
          await e.reply(segment.image(`file://${absPath}`))
          emojiSent = true
        }
        if (index < rhythm.sequence.length - 1) {
          await sleep(Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs)
        }
      }
      emojiPackManager.recordPick(groupId, item.hash, item.tags || [])
      emojiPackManager.recordSend(groupId)
      emojiPackManager.markUsed(item.hash).catch(() => {})
      const tagInfo = (item.tags || []).slice(0, 3).join(",") || "无标签"
      const textParts = rhythm.sequence.filter(part => part.type === "text").map(part => part.text)
      const followInfo = textParts.length ? ` + ${textParts.length}段文字"${textParts.join(" / ").slice(0, 28)}${textParts.join(" / ").length > 28 ? "..." : ""}"` : ""
      const scoreInfo = Number.isFinite(score) ? `, 相关度: ${score.toFixed(2)}` : ""
      return `已发送表情包 [${tagInfo}]${followInfo} (策略: ${strategy}${scoreInfo}, 回复模式: ${replyMode}, ${describeEmojiSelectionCriteria(matchedCriteria || criteria)})`
    } catch (err) {
      // 本轮已有任一可见内容发出时计入限流，避免失败重试继续刷屏。
      if (emojiSent) {
        emojiPackManager.recordPick(groupId, item.hash, item.tags || [])
        emojiPackManager.recordSend(groupId)
        emojiPackManager.markUsed(item.hash).catch(() => {})
      } else if (textSent) {
        emojiPackManager.recordSend(groupId)
      }
      return `error: 表情包发送失败: ${err.message}`
    }
  }
}
