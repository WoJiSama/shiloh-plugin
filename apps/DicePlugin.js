import { diceManager } from "../utils/DiceManager.js"
import { DiceRulePackManager, resolveDiceRuleImportSource } from "../utils/DiceRulePackManager.js"
import { sendSmartReply } from "../utils/SmartReply.js"
import { DICE_COMMAND_RULES, matchDiceCommand, stripDiceCommand } from "../utils/diceCommandPolicy.js"
import { canManageGroupDice, executeDiceCommand, getCustomDiceCommandGate } from "../utils/diceCommandGateway.js"
import { buildVisibleFailureDetail } from "../utils/visibleFailure.js"

const diceRulePackManager = new DiceRulePackManager({ diceManager })

function parseRuleReference(value = "") {
  const match = String(value || "").trim().match(/^([a-z][a-z0-9-]{2,47})(?:@(\d+))?$/)
  if (!match) return null
  const version = match[2] === undefined ? 0 : Number(match[2])
  if (match[2] !== undefined && version < 1) return null
  return { id: match[1], version }
}

export class DicePlugin extends plugin {
  constructor() {
    super({
      name: "COC骰娘",
      dsc: "COC 跑团骰娘命令",
      event: "message",
      priority: 560,
      rule: [
        ...DICE_COMMAND_RULES.map(rule => ({ ...rule })),
        { reg: "^[.。][\\s\\S]+$", fnc: "customDiceRule", log: false }
      ]
    })
    for (const commandName of new Set(DICE_COMMAND_RULES.map(rule => rule.fnc))) {
      const handler = this[commandName]?.bind(this)
      if (!handler) continue
      this[commandName] = async e => await executeDiceCommand({
        manager: diceManager,
        e,
        commandName,
        work: () => handler(e),
        reply: output => this.reply(e, output),
        logger: globalThis.logger
      })
    }
  }

  strip(e, head) {
    return stripDiceCommand(e?.msg, head)
  }

  async reply(e, output, options = {}) {
    const userId = e?.user_id || e?.sender?.user_id
    const senderOptions = userId
      ? {
          nickname: e?.sender?.card || e?.sender?.nickname || String(userId),
          avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=100`
        }
      : {}
    return await sendSmartReply(e, output, { ...senderOptions, ...options })
  }

  async runStateCommand(e, work) {
    return await diceManager.withStateTransaction(work)
  }

  async showHelp(e) {
    await this.reply(e, diceManager.showHelp(), { kind: "diceLong" })
    return true
  }

  async help(e) {
    await this.reply(e, diceManager.showHelp(this.strip(e, "(help|帮助)")), { kind: "diceLong" })
    return true
  }

  customRuleHelp() {
    return [
      "自定义骰娘规则包（格式 V1 / 运行时 2.0）：",
      "只接受固定点命令，不通过自然语言或 Agent 触发。",
      ".骰规则导入 - 引用 .yaml 文件，或在命令后附 YAML 代码块（主人）",
      ".骰规则预览 <id> / .骰规则确认 <id>",
      ".骰规则列表 / .骰规则查看 <id[@版本]>",
      ".骰规则启用 <id[@版本]> / .骰规则禁用 <id>",
      ".骰规则导出 <id[@版本]> / .骰规则回滚 <id> <版本>",
      ".骰规则删除 <id> 确认 / .骰规则恢复 <id>（主人）",
      "启用后发送 .规则前缀 查看包内命令。",
      "团务固定命令：卡/设/查/删、权限、npc、群卡/群设/群查、战役、团务、先攻、状态、物品、技能、审计、投递。",
      "战役可登记角色、管理章节和记录；团务可暂停、恢复、查看历史、创建快照与回退。"
    ].join("\n")
  }

  async manageDiceRules(e) {
    const config = diceManager.getConfig()
    const raw = this.strip(e, "骰规则")
    const matched = raw.match(/^(\S+)?\s*([\s\S]*)$/)
    const action = String(matched?.[1] || "帮助").toLowerCase()
    const args = String(matched?.[2] || "").trim()
    if (["帮助", "help"].includes(action)) {
      await this.reply(e, this.customRuleHelp(), { kind: "diceLong" })
      return true
    }
    if (!config.customRulesEnabled) {
      await this.reply(e, "自定义骰娘规则包当前没有启用。主人可在锅巴或 message.yaml 开启 diceSystem.customRulesEnabled。")
      return true
    }
    try {
      if (["导入", "import"].includes(action)) {
        if (!e.isMaster) throw new Error("只有主人可以导入规则包")
        const source = await resolveDiceRuleImportSource(e, args, { fetchImpl: globalThis.fetch })
        const result = await diceRulePackManager.stageImport(source, e.user_id)
        await this.reply(e, result.report, { kind: "diceLong" })
        return true
      }
      if (["确认", "confirm"].includes(action)) {
        if (!e.isMaster) throw new Error("只有主人可以确认导入")
        const result = await diceRulePackManager.confirmImport(args, e.user_id)
        await this.reply(e, `规则包已保存：${result.name}（${result.id}@${result.version}）\n它不会自动影响任何群；请在目标群发送 .骰规则启用 ${result.id}@${result.version}`)
        return true
      }
      if (["列表", "list"].includes(action)) {
        if (!canManageGroupDice(e)) throw new Error("只有主人或群管理员可以查看规则包列表")
        await this.reply(e, diceRulePackManager.listText(e.group_id), { kind: "diceLong" })
        return true
      }
      if (["预览", "preview"].includes(action)) {
        if (!canManageGroupDice(e)) throw new Error("只有主人或群管理员可以预览规则包")
        if (!args) throw new Error("格式：.骰规则预览 <id>")
        await this.reply(e, diceRulePackManager.previewPackage(args), { kind: "diceLong" })
        return true
      }
      if (["查看", "view"].includes(action)) {
        if (!canManageGroupDice(e)) throw new Error("只有主人或群管理员可以查看规则包")
        const ref = parseRuleReference(args)
        if (!ref) throw new Error("格式：.骰规则查看 <id[@版本]>")
        await this.reply(e, diceRulePackManager.describePackage(ref.id, ref.version), { kind: "diceLong" })
        return true
      }
      if (["启用", "enable"].includes(action)) {
        if (!canManageGroupDice(e)) throw new Error("只有主人或群管理员可以在当前群启用规则包")
        const ref = parseRuleReference(args)
        if (!ref) throw new Error("格式：.骰规则启用 <id[@版本]>")
        const result = await diceRulePackManager.enableForGroup(e.group_id, ref.id, ref.version)
        await this.reply(e, `当前群已启用 ${result.name}（${result.id}@${result.version}）。发送 .${result.id} 查看规则命令。`)
        return true
      }
      if (["禁用", "disable"].includes(action)) {
        if (!canManageGroupDice(e)) throw new Error("只有主人或群管理员可以在当前群禁用规则包")
        const ref = parseRuleReference(args)
        if (!ref || ref.version) throw new Error("格式：.骰规则禁用 <id>")
        await diceRulePackManager.disableForGroup(e.group_id, ref.id)
        await this.reply(e, `当前群已禁用规则包 ${ref.id}；人物卡数据仍然保留。`)
        return true
      }
      if (["回滚", "rollback"].includes(action)) {
        if (!e.isMaster) throw new Error("只有主人可以回滚规则包版本")
        const [id, versionText] = args.split(/\s+/)
        if (!parseRuleReference(id)?.id || id.includes("@") || !/^[1-9]\d*$/.test(versionText || "")) throw new Error("格式：.骰规则回滚 <id> <正整数版本>")
        const result = await diceRulePackManager.rollbackForGroup(e.group_id, id, Number(versionText))
        await this.reply(e, `当前群已切换到 ${result.name}（${result.id}@${result.version}）。`)
        return true
      }
      if (["导出", "export"].includes(action)) {
        if (!canManageGroupDice(e)) throw new Error("只有主人或群管理员可以导出规则包")
        const ref = parseRuleReference(args)
        if (!ref) throw new Error("格式：.骰规则导出 <id[@版本]>")
        const exported = diceRulePackManager.getExportFile(ref.id, ref.version)
        await diceManager.sendCompleteFile(e, exported.file, { maxMb: config.logExportMaxMb })
        await this.reply(e, `已导出完整 YAML 文件：${ref.id}@${exported.record.version}。`)
        return true
      }
      if (["恢复", "restore"].includes(action)) {
        if (!e.isMaster) throw new Error("只有主人可以恢复归档规则包")
        const ref = parseRuleReference(args)
        if (!ref || ref.version) throw new Error("格式：.骰规则恢复 <id>")
        const result = await diceRulePackManager.restoreArchivedPackage(ref.id)
        await this.reply(e, `规则包已从归档恢复：${result.name}（版本 ${result.versions.join("、")}）。它尚未在任何群启用。`)
        return true
      }
      if (["删除", "delete"].includes(action)) {
        if (!e.isMaster) throw new Error("只有主人可以删除规则包")
        const [id, confirm] = args.split(/\s+/)
        const ref = parseRuleReference(id)
        if (!ref || ref.version) throw new Error("格式：.骰规则删除 <id> 确认")
        if (confirm !== "确认") {
          await this.reply(e, `删除会在所有群禁用 ${id}，但保留用户人物卡数据；规则文件会移入 archived。\n确认请发送：.骰规则删除 ${id} 确认`)
          return true
        }
        const result = await diceRulePackManager.archivePackage(ref.id)
        await this.reply(e, `规则包 ${ref.id} 已归档，并从 ${result.affectedGroups} 个群禁用；人物卡数据仍保留。`)
        return true
      }
      throw new Error(`未知管理命令：${action}`)
    } catch (error) {
      await this.reply(e, `骰规则操作失败：${buildVisibleFailureDetail(error)}`)
      return true
    }
  }

  async customDiceRule(e) {
    const gate = getCustomDiceCommandGate({ manager: diceManager, ruleManager: diceRulePackManager, e })
    if (!gate.matched) return false
    if (!gate.allowed) {
      if (gate.response) await this.reply(e, gate.response)
      return gate.consume
    }
    let result
    try {
      result = await diceRulePackManager.handleDynamicCommand(e)
    } catch (error) {
      globalThis.logger?.error?.(`[骰娘] 自定义规则命令执行失败: ${error.message}`)
      await this.reply(e, `这条自定义骰娘命令没有执行成功：${buildVisibleFailureDetail(error)}\n规则状态不会按成功处理。`)
      return true
    }
    if (!result.matched) return false
    const failedRecipients = []
    const deliveryOutcomes = []
    for (const message of result.privateMessages || []) {
      try {
        const friend = e?.bot?.pickFriend?.(message.userId) || globalThis.Bot?.pickFriend?.(message.userId)
        if (!friend?.sendMsg) throw new Error("无法取得私聊对象")
        await friend.sendMsg(message.text)
        if (message.deliveryId) deliveryOutcomes.push({ deliveryId: message.deliveryId, ok: true })
      } catch (error) {
        failedRecipients.push(message.userId)
        if (message.deliveryId) deliveryOutcomes.push({ deliveryId: message.deliveryId, ok: false, error: error.message })
      }
    }
    if (deliveryOutcomes.length && result.packId) {
      await diceRulePackManager.settlePrivateDeliveries(e.group_id, result.packId, deliveryOutcomes)
        .catch(error => globalThis.logger?.error?.(`[骰规则] 私密投递状态持久化失败: ${error.message}`))
    }
    let suffix = failedRecipients.length ? `\n有 ${failedRecipients.length} 条私密结果未能发送，已保留待重试；GM 可使用规则包的「投递 重试」。` : ""
    for (const update of result.groupCardUpdates || []) {
      if (String(update.userId) !== String(e.user_id || "")) continue
      const syncResult = await diceManager.syncAutoGroupCard(e, update.name)
      if (/失败/.test(syncResult)) suffix += syncResult
    }
    await this.reply(e, `${result.text}${suffix}`, { kind: "diceLong" })
    return true
  }

  async botControl(e) {
    await this.reply(e, await diceManager.handleBotControl(e, this.strip(e, "(bot|dismiss|bye)")))
    return true
  }

  async replyControl(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleReplyControl(e, this.strip(e, "reply"))))
    return true
  }

  async sendToMaster(e) {
    await this.reply(e, diceManager.handleSendToMaster(e, this.strip(e, "send")))
    return true
  }

  async findEntry(e) {
    await this.reply(e, diceManager.handleFind(e, this.strip(e, "find")), { kind: "knowledgeList" })
    return true
  }

  async setDiceOption(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleSetOption(e, this.strip(e, "set"))))
    return true
  }

  async sn(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleSn(e, this.strip(e, "sn"))))
    return true
  }

  async logStart(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.startLog(e, this.strip(e, "log\\s*(on|start|开始|开启)"))))
    return true
  }

  async logNew(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.startLog(e, this.strip(e, "log\\s*(new|新建|create)"))))
    return true
  }

  async logStop(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.stopLog(e)))
    return true
  }

  async logEnd(e) {
    const { stopped, exported } = await this.runStateCommand(e, async () => ({
      stopped: await diceManager.stopLog(e),
      exported: await diceManager.exportLog(e)
    }))
    if (exported) await this.reply(e, exported)
    await this.reply(e, stopped)
    return true
  }

  async logStatus(e) {
    await this.reply(e, diceManager.getLogStatus(e), { kind: "messageArchive" })
    return true
  }

  async logExport(e) {
    const result = await diceManager.exportLog(e, this.strip(e, "log\\s*(export|get|导出|获取)"))
    if (result) await this.reply(e, result, { kind: "messageArchive" })
    return true
  }

  async roll(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "(?:r(?![A-Za-z])|roll)\\s*([\\s\\S]*)")
    await this.reply(e, diceManager.handleRoll(e, match?.[1] || ""))
    return true
  }

  async initiativeRoll(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleInitiativeRoll(e, this.strip(e, "ri"))))
    return true
  }

  async initiative(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleInitiative(e, this.strip(e, "(init|先攻)"))))
    return true
  }

  async rsr(e) {
    await this.reply(e, diceManager.handleRsr(e, this.strip(e, "rsr")))
    return true
  }

  async ww(e) {
    await this.reply(e, diceManager.handleWw(e, this.strip(e, "ww")))
    return true
  }

  async dx(e) {
    await this.reply(e, diceManager.handleDx(e, this.strip(e, "dx")))
    return true
  }

  async ek(e) {
    await this.reply(e, diceManager.handleEk(e, this.strip(e, "ek")))
    return true
  }

  async ekgen(e) {
    await this.reply(e, diceManager.handleEkgen(e, this.strip(e, "ekgen")))
    return true
  }

  async bonusRoll(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "bp(\\d+)?\\s*([\\s\\S]*)")
    await this.reply(e, diceManager.handleBonusPenaltyRoll(e, match?.[2] || "", Number(match?.[1] || 1)))
    return true
  }

  async penaltyRoll(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "pp(\\d+)?\\s*([\\s\\S]*)")
    await this.reply(e, diceManager.handleBonusPenaltyRoll(e, match?.[2] || "", -Number(match?.[1] || 1)))
    return true
  }

  async opposed(e) {
    await this.reply(e, diceManager.handleOpposed(e, this.strip(e, "rav")))
    return true
  }

  async seaCocCheck(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "(rab|rap|rahb|rahp|rah|ra)(\\d+)?#?(b|p)?\\s*([\\s\\S]*)")
    const head = String(match?.[1] || "ra").toLowerCase()
    const num = Number(match?.[2] || 0)
    const suffix = String(match?.[3] || "").toLowerCase()
    const modifier = head.includes("b") || suffix === "b" ? (num || 1) : head.includes("p") || suffix === "p" ? -(num || 1) : 0
    const hidden = head.includes("h")
    const raw = match?.[4] || ""
    await this.reply(e, hidden ? await diceManager.handleHiddenCheck(e, raw, { modifier }) : diceManager.handleCheck(e, raw, { modifier }))
    return true
  }

  async check(e) {
    const text = String(e.msg || "")
    const raw = this.strip(e, "(ra|rc)")
    await this.reply(e, /^[.。]rc/i.test(text) && diceManager.shouldUseDndCheck(e, raw)
      ? diceManager.handleDndCheck(e, raw)
      : diceManager.handleCheck(e, raw))
    return true
  }

  async numberedCheck(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "(?:ra|rc)([+\\-]?\\d+)\\s*([\\s\\S]*)")
    const modifier = Number(match?.[1] || 0)
    await this.reply(e, diceManager.handleCheck(e, match?.[2] || "", { modifier }))
    return true
  }

  async bonusCheck(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "rb(\\d+)?\\s*([\\s\\S]*)")
    await this.reply(e, diceManager.handleCheck(e, match?.[2] || "", { modifier: Number(match?.[1] || 1) }))
    return true
  }

  async penaltyCheck(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "rp(\\d+)?\\s*([\\s\\S]*)")
    await this.reply(e, diceManager.handleCheck(e, match?.[2] || "", { modifier: -Number(match?.[1] || 1) }))
    return true
  }

  async hiddenCheck(e) {
    await this.reply(e, await diceManager.handleHiddenCheck(e, this.strip(e, "(rh|rah)")))
    return true
  }

  async sanCheck(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleSan(e, this.strip(e, "sc"))))
    return true
  }

  async enCheck(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleEn(e, this.strip(e, "en"))))
    return true
  }

  async coc(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "(?:coc7?|天命)\\s*([\\s\\S]*)")
    await this.reply(e, diceManager.handleCoc(e, match?.[1] || ""), { kind: "cocAttributes" })
    return true
  }

  async dnd(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "(?:dnd5e?|dnd)\\s*([\\s\\S]*)")
    await this.reply(e, diceManager.handleDnd(e, match?.[1] || ""), { kind: "diceLong" })
    return true
  }

  async nameDnd(e) {
    await this.reply(e, diceManager.handleNameDnd(e, this.strip(e, "namednd")))
    return true
  }

  async dndUtility(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "(buff|ss|cast|longrest|ds)\\s*([\\s\\S]*)")
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleDndUtility(e, match?.[1] || "", match?.[2] || "")))
    return true
  }

  async jrrp(e) {
    await this.reply(e, diceManager.handleJrrp(e))
    return true
  }

  async db(e) {
    await this.reply(e, diceManager.handleDb(e, this.strip(e, "(db|伤害加值)")))
    return true
  }

  async st(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleSt(e, this.strip(e, "st"))))
    return true
  }

  async pc(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handlePc(e, this.strip(e, "pc"))))
    return true
  }

  async nn(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleNn(e, this.strip(e, "nn"))))
    return true
  }

  async setCoc(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleSetCoc(e, this.strip(e, "setcoc"))))
    return true
  }

  async ti(e) {
    await this.reply(e, diceManager.handleInsanity("ti"))
    return true
  }

  async li(e) {
    await this.reply(e, diceManager.handleInsanity("li"))
    return true
  }
}
