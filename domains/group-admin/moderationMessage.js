import { groupModerationManager } from "./GroupModerationManager.js"
import { adCorpusStore } from "./adCorpusStore.js"
import { findAdTemplateMatch } from "./groupModerationRules.js"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"

export class GroupModerationMessage extends plugin {
  constructor() {
    super({
      name: "群管理-复合风控",
      dsc: "检测低活跃成员广告、外链和招募话术",
      event: "message.group",
      priority: 9990,
      rule: [
        {
          reg: "^[#＃.。]\\s*广告入库\\s*$",
          fnc: "handleAdCorpusAdd"
        },
        {
          reg: "^[#＃.。]\\s*广告出库\\s*$",
          fnc: "handleAdCorpusRemoveQuoted"
        },
        {
          reg: "^[#＃.。]\\s*广告样本(\\s+(列表|统计))?\\s*$",
          fnc: "handleAdCorpusStats"
        },
        {
          reg: "^[#＃.。]\\s*广告样本\\s+(?:删除|移除)\\s+#?([A-Za-z0-9]+)\\s*$",
          fnc: "handleAdCorpusRemove"
        },
        {
          reg: ".*",
          fnc: "handleModerationMessage",
          log: false
        }
      ]
    })
  }

  async handleModerationMessage(e) {
    return await groupModerationManager.handleMessage(e)
  }

  isCorpusManager(e) {
    const config = groupModerationManager.getConfig()
    return e?.isMaster
      || groupModerationManager.isNativeGroupAdmin(e)
      || groupModerationManager.isConfiguredAdmin(config, e?.group_id, e?.user_id)
  }

  async handleAdCorpusAdd(e) {
    if (!this.isCorpusManager(e)) {
      await e.reply("只有群主、群管理或群管配置的管理员可以维护广告样本库。")
      return true
    }
    const reply = await groupModerationManager.loadQuotedMessage(e)
    if (!reply) {
      await e.reply("先引用那条广告消息，再发送 .广告入库，我才能拿到内容。")
      return true
    }
    const config = groupModerationManager.getConfig()
    const content = await groupModerationManager.extractContent(reply, config)
    const quotedUserId = reply?.sender?.user_id || reply?.user_id || ""

    const result = adCorpusStore.addEntry({
      text: content.text,
      groupId: e.group_id,
      userId: quotedUserId,
      addedBy: e.user_id
    })
    if (!result.ok && result.error === "text_too_short") {
      await e.reply("引用的消息里没有足够的文字内容，没法入库（纯图/太短就算了）。")
      return true
    }
    if (!result.ok && result.duplicate) {
      await e.reply(`这条已经在样本库里了（#${result.entry.id}），不用重复加。`)
      return true
    }

    const stats = adCorpusStore.getStats()
    await e.reply([
      `已入库 #${result.entry.id}，样本库共 ${stats.total} 条。`,
      `内容：${safeTruncateUnicode(result.entry.text, 80)}`,
      `之后群里再出现类似内容就会命中"命中广告样本库"规则。`
    ].join("\n"))
    return true
  }

  // 引用即删：先按原文精确匹配样本，匹配不上再按相似度定位最像的一条
  async handleAdCorpusRemoveQuoted(e) {
    if (!this.isCorpusManager(e)) return true
    const reply = await groupModerationManager.loadQuotedMessage(e)
    if (!reply) {
      await e.reply("先引用那条消息，再发送 .广告出库，我才能定位要删的样本。")
      return true
    }
    const config = groupModerationManager.getConfig()
    const content = await groupModerationManager.extractContent(reply, config)
    if (!content.text) {
      await e.reply("引用的消息里没有文字，没法定位样本。可以用 .广告样本 查编号后 .广告样本 删除 <编号>。")
      return true
    }

    const direct = adCorpusStore.findByText(content.text)
    if (direct) {
      adCorpusStore.removeEntry(direct.id)
      await e.reply(`已删除样本 #${direct.id}：${safeTruncateUnicode(direct.text, 60)}`)
      return true
    }

    const entries = adCorpusStore.readEntries()
    let best = null
    for (const entry of entries) {
      const match = findAdTemplateMatch(content.text, config, [entry.text])
      if (match?.origin === "corpus" && (!best || match.score > best.score)) {
        best = { entry, score: match.score }
      }
    }
    if (!best) {
      await e.reply("样本库里没有和这条对应的样本。用 .广告样本 查看编号后 .广告样本 删除 <编号>。")
      return true
    }
    adCorpusStore.removeEntry(best.entry.id)
    await e.reply(`按相似度(${best.score.toFixed(2)})删除了最接近的样本 #${best.entry.id}：${safeTruncateUnicode(best.entry.text, 60)}`)
    return true
  }

  async handleAdCorpusStats(e) {
    if (!this.isCorpusManager(e)) return true
    const stats = adCorpusStore.getStats()
    if (!stats.total) {
      await e.reply(`样本库还是空的：引用广告消息后发送 .广告入库 即可添加（上限 ${stats.maxEntries} 条）。`)
      return true
    }
    const lines = [
      `广告样本库：${stats.total}/${stats.maxEntries} 条`,
      ...stats.latest.map(item => `#${item.id} ${item.preview}`)
    ]
    await e.reply(lines.join("\n"))
    return true
  }

  async handleAdCorpusRemove(e) {
    if (!this.isCorpusManager(e)) return true
    const id = e.msg.match(/#\s*广告样本\s+(?:删除|移除)\s+#?([A-Za-z0-9]+)/)?.[1] || ""
    const result = adCorpusStore.removeEntry(id)
    if (!result.ok) {
      await e.reply(`没找到 #${id} 这条样本，用 .广告样本 看看现有编号。`)
      return true
    }
    await e.reply(`已删除 #${result.entry.id}：${safeTruncateUnicode(result.entry.text, 60)}`)
    return true
  }
}
