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

// 词表随 catalog 活起来：注册表 functions[].parameters 引用的是同一个对象，
// 原地刷新即可对后续请求生效（description 是拷贝，靠注册表周期 rebuild 自然跟上）
const liveInstances = new Set()
let schemaRefreshTimer = null
function scheduleSchemaRefresh() {
  if (schemaRefreshTimer) return
  schemaRefreshTimer = setTimeout(() => {
    schemaRefreshTimer = null
    for (const instance of liveInstances) {
      try { instance.refreshSchema() } catch {}
    }
  }, 10_000)
}

export class SendLocalEmojiTool extends AbstractTool {
  constructor() {
    super()
    this.name = "sendLocalEmojiTool"
    this.description = ""
    this.parameters = { type: "object", properties: {}, required: ["tags"], additionalProperties: false }
    this.refreshSchema()
    liveInstances.add(this)
    emojiPackManager.onCatalogChanged(scheduleSchemaRefresh)
  }

  buildSchema() {
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
    // 优先标签从真实库词表生成（按词表顺序取前 30），不再硬编码一份会过期的清单
    const recommendedTags = vocabulary.tags.length
      ? `优先使用线上库真实标签：${vocabulary.tags.slice(0, 30).join("、")}。`
      : "优先使用线上库真实标签（当前库为空，先通过 #表情包导入 添加表情）。"
    const description = [
      "从本地表情包库挑选一张合适的表情包发送到当前会话。",
      "你的回复以文字为主：先用嘴把话说完，表情包是偶尔的点缀，不是主要回复方式。大多数闲聊回合直接用文字回，不要调用本工具。",
      "表情包只在它真的加分时用：梗图接梗（表情本身就是笑点）、情绪放大（笑死/无语/破防时配一张）、气氛调剂。拿不准就不发。",
      "调用规则：leadText 在表情前把话说了，followUpText 在表情后补；只有纯玩梗接梗（表情本身就是完整回应）才可以不填配文只发表情，这种情况一轮最多一次。",
      "不适合场景：严肃问答、技术讨论、对方在咨询正式问题、寻求帮助、情绪低落找你倾诉。",
      "用户直接向你提问或找你说话（在干嘛/在吗/问你状态/喊你名字/问你爱不爱他/让你夸他求表扬）时，表情包不算“已经足够”：必须填 leadText 真的把话说出来（如“窝着呢”“在的在的”“欸？怎么突然问这个呀”），求夸就真的夸两句，表情只作搭配。",
      "默认整轮最多发一张表情，绝对不要在一轮里调用两次本工具。"
    ].join("\n")
    const parameters = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: tagItemSchema,
          description: [
            "按相关度从高到低填写 1-5 个库内情绪/反应标签，第一个是最想表达的主情绪。",
            recommendedTags,
            "不要填写画风、角色、动物等物体词。"
          ].join("\n")
        },
        useCases: {
          type: "array",
          items: useCaseItemSchema,
          description: vocabulary.useCases.length
            ? `可选，按相关度填写 1-4 个具体使用场景。优先使用库内真实场景，如：${vocabulary.useCases.slice(0, 15).join("、")}。`
            : "可选，按相关度填写 1-4 个具体使用场景。优先使用库内真实场景，如：接梗吐槽、群友翻车、无言以对、看到离谱、轻微嘲讽、想装无辜、被人夸奖、场面尴尬、认怂求饶、安慰对方、拒绝加班。"
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
    return { description, parameters }
  }

  /** 用当前 catalog 词表重建 schema；导入/删除/打标后由 onCatalogChanged 防抖触发 */
  refreshSchema() {
    const { description, parameters } = this.buildSchema()
    this.description = description
    this.parameters.properties = parameters.properties
    this.parameters.required = parameters.required
    this.parameters.additionalProperties = parameters.additionalProperties
    this.parameters.type = parameters.type
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
      // 无匹配/库空不是失败：返回文字引导（非 error: 前缀），让后续轮次用纯文字自然回应，
      // 不走失败道歉路径——限流/发送失败才是 error，由失败策略静默处理
      if (strategy === "no_match") {
        return "本地表情包里没有匹配这个情绪的表情，本轮请用纯文字回复，不要提及或描述表情内容"
      }
      return "本地表情包库是空的（还没有导入任何表情），请用文字回应用户，可以顺便说表情库还没建起来"
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
          const imageSegment = segment.image(`file://${absPath}`)
          // sub_type=1 让 QQ 按"表情"小图渲染而不是满屏大图（NapCat 支持；不识别的适配器会忽略该字段）
          if (cfg?.sendAsSticker !== false && imageSegment && typeof imageSegment === "object") {
            if (imageSegment.data && typeof imageSegment.data === "object") imageSegment.data.sub_type = 1
            else imageSegment.sub_type = 1
          }
          await e.reply(imageSegment)
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
