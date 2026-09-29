import { diceManager } from "./DiceManager.js"
import { deckManager } from "./DeckManager.js"
import { DiceRulePackManager, resolveDiceRuleImportSource } from "./DiceRulePackManager.js"
import { sendSmartReply } from "../../utils/SmartReply.js"
import { DICE_COMMAND_RULES, matchDiceCommand, resolveDiceDocPath, stripDiceCommand } from "./diceCommandPolicy.js"
import { canManageGroupDice, executeDiceCommand, getCustomDiceCommandGate } from "./diceCommandGateway.js"
import { buildVisibleFailureDetail } from "../../utils/visibleFailure.js"
import { getCommandRegistry, renderTopicHelp } from "../../utils/commandRegistry.js"
import { fileURLToPath } from "node:url"
import path from "node:path"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

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
      this[commandName] = async e => {
        // sealdice 同消息多指令：.ra格斗.ra格斗 拆成两条各执行一次
        await this.dispatchSplitCommands(e)
        return await executeDiceCommand({
          manager: diceManager,
          e,
          commandName,
          work: () => handler(e),
          reply: output => this.reply(e, output),
          logger: globalThis.logger
        })
      }
    }
    // 重启后预热 JS 规则包的自定义函数（loadPack 同步取用）
    diceRulePackManager.warmupJsPacks().catch(error => {
      globalThis.logger?.warn?.(`[骰规则] JS 规则包预热失败: ${error.message}`)
    })
  }

  /** 一条消息里粘了多条 .命令 时拆开执行；要求除首段外每段都是已知命令，防止误拆参数里的点 */
  async dispatchSplitCommands(e) {
    if (e?._splitDispatched) return false
    const msg = String(e?.msg || "")
    if (!/^[.。][\s\S]*[.。]/.test(msg)) return false
    const parts = msg.split(/(?=[.。])/).filter(part => part.length > 1)
    if (parts.length < 2 || parts.length > 5) return false
    // 只认已知内置命令：排除兜底规则，避免把参数里的点（如牌堆名 示例.牌组）误拆
    const knownRules = this.rule.filter(rule => rule.fnc !== "customDiceRule")
    const isKnownCommand = text => knownRules.some(rule => {
      try { return new RegExp(rule.reg).test(text) } catch { return false }
    })
    if (!parts.slice(1).every(isKnownCommand)) return false
    for (const part of parts.slice(1)) {
      const segment = Object.create(e)
      segment.msg = part
      segment.raw_message = part
      segment.message = [{ type: "text", data: { text: part } }]
      segment._splitDispatched = true
      try {
        for (const rule of this.rule) {
          if (!new RegExp(rule.reg).test(segment.msg)) continue
          if (await this[rule.fnc](segment) === true) break
        }
      } catch (error) {
        globalThis.logger?.warn?.(`[骰娘] 分段命令「${part}」执行失败: ${error?.message || error}`)
      }
    }
    // 原事件改写为第一段，让本次调用继续正常执行第一段
    e.msg = parts[0]
    e.raw_message = parts[0]
    e.message = [{ type: "text", data: { text: parts[0] } }]
    globalThis.logger?.info?.(`[骰娘] 同消息多指令：已拆为 ${parts.length} 条分别执行`)
    return true
  }

  strip(e, head) {
    return stripDiceCommand(e?.msg, head)
  }

  // .dice 一级菜单
  async diceHubMenu(e) {
    await this.reply(e, [
      "骰娘命令导航：",
      ".dice import - 规则包导入教程（JS / YAML，直接发文档文件）",
      ".dice rule - 规则包管理（.dice rule 帮助 看全部子命令）",
      ".骰娘帮助 / .dice help - 骰娘完整帮助"
    ].join("\n"))
    return true
  }

  // .dice import [js|yaml]：发送规则包教程文档（所有人可用；导入执行仍限主人）
  async diceImportHub(e) {
    const kind = String(e?.msg || "").match(/(?:import|导入|教程)\s+(\S+)\s*$/)?.[1]?.toLowerCase() || ""
    const sendDoc = async (relative, label) => {
      const file = resolveDiceDocPath(relative)
      await diceManager.sendCompleteFile(e, file, { maxMb: 8 })
      await this.reply(e, `${label}\n有问题把预检报告发出来，或引用示例文件改。`)
    }
    try {
      if (["js", "javascript"].includes(kind)) {
        await sendDoc("JS规则包教程.md", "《JS 规则包教程》已发送（面向主人，可写自定义公式函数）。")
        try {
          await diceManager.sendCompleteFile(e, resolveDiceDocPath("examples/bishou-zhixin.cjs"), { maxMb: 2 })
          await this.reply(e, "示例文件 bishou-zhixin.cjs 已发送：引用它发 .dice rule 匕首之心 即可试导入。")
        } catch (error) {
          await this.reply(e, `示例文件发送失败：${buildVisibleFailureDetail(error)}`)
        }
        return true
      }
      if (["yaml", "yml"].includes(kind)) {
        await sendDoc("骰娘自定义规则接入指南.md", "《YAML 规则包教程》已发送（声明式，适合分享给任意群主）。")
        return true
      }
      await this.reply(e, [
        "规则包导入教程，两种格式任选：",
        ".dice import js - 《JS 规则包教程》+ 示例文件（机器人主人用，JS 写公式函数）",
        ".dice import yaml - 《YAML 规则包教程》（声明式，不改代码，适合分享）",
        "写好后：群里发文件 → 引用它发 .dice rule 规则名 → .骰规则确认 → .骰规则启用（导入/确认仅主人）。"
      ].join("\n"))
      return true
    } catch (error) {
      await this.reply(e, `文档发送失败：${buildVisibleFailureDetail(error)}`)
      return true
    }
  }

  async reply(e, output, options = {}) {
    const userId = e?.user_id || e?.sender?.user_id
    const forceText = diceManager.isLogRecording(e?.group_id)
    const senderOptions = userId
      ? {
          nickname: e?.sender?.card || e?.sender?.nickname || String(userId),
          avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=100`
        }
      : {}
    const sent = await sendSmartReply(e, output, { ...senderOptions, ...options, forceText })
    // 跑团 log 记录中：命令结果以发起玩家名义入档（sealdice 语义，复盘可见完整检定）
    if (typeof output === "string" && output.trim()) {
      diceManager.recordDiceResult(e, output).catch(error => {
        globalThis.logger?.warn?.(`[骰娘] log 结果入档失败: ${error?.message || error}`)
      })
    }
    return sent
  }

  async runStateCommand(e, work) {
    return await diceManager.withStateTransaction(work)
  }

  async showHelp(e) {
    await this.reply(e, diceManager.showHelp(), { kind: "diceLong" })
    return true
  }

  async help(e) {
    const helpArg = String(this.strip(e, "(help|帮助)") || "").trim()
    // .help <海豹命令>(如 .help dd):显示该命令的详细帮助
    if (helpArg) {
      const sealCommand = diceRulePackManager.findSealCommandHelp(e.group_id, helpArg)
      if (sealCommand) {
        await this.reply(e, `${sealCommand.command.help}

—— 来自规则包:${sealCommand.loaded.pack?.name || sealCommand.loaded.pack?.id}`, { kind: "diceLong" })
        return true
      }
      // 命令总表(commands.yaml)驱动的主题帮助:模块命中或命令词前缀命中,内容与命令管理页同源
      try {
        const topicHelp = renderTopicHelp(getCommandRegistry(pluginRoot), helpArg)
        if (topicHelp) {
          await this.reply(e, topicHelp, { kind: "diceLong" })
          return true
        }
      } catch (error) {
        globalThis.logger?.warn?.(`[骰娘] 命令总表主题帮助读取失败,回退内置帮助: ${error?.message || error}`)
      }
    }
    const base = diceManager.showHelp(helpArg)
    const packs = diceRulePackManager.activePacksHelpText?.(e.group_id || "private") || ""
    await this.reply(e, packs ? `${base}\n\n【本群已启用的规则包】\n${packs}\n完整命令列表：.骰规则列表` : base, { kind: "diceLong" })
    return true
  }

  customRuleHelp() {
    return [
      "自定义骰娘规则包（格式 V1 / 运行时 2.0）：",
      "只接受固定点命令，不通过自然语言或 Agent 触发。",
      ".骰规则导入 - 引用 .yaml/.js 文件（含海豹骰 JS 扩展，自动识别），或在命令后附代码块（主人）",
      ".dice rule <名称> - 引用 JS/YAML 文件导入，名称作为包显示名（主人；JS 包可在 functions 里注册自定义公式函数）",
      ".dice import [js|yaml] - 获取规则包编写教程文档（所有人）",
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
    const raw = this.strip(e, "(?:骰规则|dice\\s*rule)")
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
      // .dice rule 匕首之心（引用 JS/YAML 文件）→ 以名称提示导入
      const knownActions = ["导入", "import", "确认", "confirm", "列表", "list", "预览", "preview", "查看", "view", "启用", "enable", "禁用", "disable", "导出", "export", "回滚", "rollback", "删除", "delete", "恢复", "restore", "兼容", "compat"]
      if (!knownActions.includes(action) && !["rule", "规则"].includes(action) && action !== "帮助") {
        if (!e.isMaster) throw new Error("只有主人可以导入规则包")
        const source = await resolveDiceRuleImportSource(e, "", { fetchImpl: globalThis.fetch })
        const result = await diceRulePackManager.stageImport(source, e.user_id, {
          allowJs: config.customJsRulesEnabled !== false,
          nameHint: action
        })
        await this.reply(e, result.report, { kind: "diceLong" })
        return true
      }
      if (["导入", "import", "rule", "规则"].includes(action)) {
        if (!e.isMaster) throw new Error("只有主人可以导入规则包")
        // 参数是单个词时视为名称提示（.骰规则导入 匕首之心 + 引用文件），其余情况参数是内联 YAML/JS
        const nameHint = /^\S+$/.test(args) ? args : ""
        const source = await resolveDiceRuleImportSource(e, nameHint ? "" : args, { fetchImpl: globalThis.fetch })
        const result = await diceRulePackManager.stageImport(source, e.user_id, {
          allowJs: config.customJsRulesEnabled !== false,
          nameHint
        })
        await this.reply(e, result.report, { kind: "diceLong" })
        return true
      }
      if (["确认", "confirm"].includes(action)) {
        if (!e.isMaster) throw new Error("只有主人可以确认导入")
        const result = await diceRulePackManager.confirmImport(args, e.user_id)
        const cardTip = result.wantsGroupCard ? "\n这套规则声明了群名片同步：启用后群成员各自发送 .sn on 开启（机器人需为群管理）。" : ""
        await this.reply(e, `规则包已保存：${result.name}（${result.id}@${result.version}）\n它不会自动影响任何群；请在目标群发送 .骰规则启用 ${result.id}@${result.version}${cardTip}`)
        return true
      }
      if (["兼容", "compat"].includes(action)) {
        const reports = diceRulePackManager.compatReport(e.group_id || "private")
        if (!reports.length) {
          await this.reply(e, "本群没有启用海豹扩展规则包。")
          return true
        }
        const lines = ["【海豹扩展兼容性报告】"]
        for (const report of reports) {
          lines.push(`\n◆ ${report.packName}`)
          lines.push(`  命令(${report.commands.length}): ${report.commands.join(", ") || "无"}`)
          lines.push(`  .set 规则键: ${report.ruleKeys.join(", ") || "未声明"}`)
          lines.push(`  名片模板: ${report.templateCount} 张`)
          const audit = report.apiAudit
          lines.push(`  seal API(${audit.total} 种): ${audit.supported.length} 完整支持`)
          if (audit.degraded.length) lines.push(`  ⚠ 降级(${audit.degraded.length}): ${audit.degraded.join("; ")}`)
          if (audit.missing.length) lines.push(`  ✗ 未实现(${audit.missing.length}): ${audit.missing.join(", ")}`)
          if (report.runtimeDegraded.length) lines.push(`  ⚠ 运行时降级: ${report.runtimeDegraded.join("; ")}`)
          if (!audit.degraded.length && !audit.missing.length && !report.runtimeDegraded.length) lines.push("  ✓ 全部兼容")
        }
        lines.push("\n降级/未实现的 API 对应包内功能可能不完整;导入新包后先跑一次此命令确认。")
        await this.reply(e, lines.join("\n"), { kind: "diceLong" })
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
        if (!ref) {
          const packages = diceRulePackManager.listPackages()
          const ids = packages.map(item => `${item.id}（${item.name}）`).join("、") || "（还没有导入任何包）"
          const hint = /^\d+$/.test(String(args).trim())
            ? `「${args}」是版本号，不是包 ID——要用字母包名。`
            : `ID 是列表里括号中的字母名。`
          throw new Error(`${hint}可用规则包：${ids}\n例：.骰规则启用 ${packages[0]?.id || "包id"}`)
        }
        const result = await diceRulePackManager.enableForGroup(e.group_id, ref.id, ref.version)
        const entry = diceRulePackManager.packEntryHintForGroup(e.group_id, result.id) || `发送 .${result.id} 查看规则命令。`
        await this.reply(e, `当前群已启用 ${result.name}（${result.id}@${result.version}）。\n${entry}\n完整命令列表：.骰规则列表`)
        return true
      }
      if (["禁用", "disable"].includes(action)) {
        if (!canManageGroupDice(e)) throw new Error("只有主人或群管理员可以在当前群禁用规则包")
        const ref = parseRuleReference(args)
        if (!ref || ref.version) {
          const ids = diceRulePackManager.listPackages().map(item => item.id).join("、") || "（无）"
          throw new Error(`格式：.骰规则禁用 <id>（只用字母包名，不带版本）。可用：${ids}`)
        }
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
    // M3:多条回复逐条发送(海豹语义:每次 replyToSender 一条消息)
    if (result.multiReply && Array.isArray(result.text)) {
      for (const line of result.text) {
        await this.reply(e, String(line || "").trim(), { kind: "diceLong" })
      }
      if (failedRecipients.length) {
        await this.reply(e, `有 ${failedRecipients.length} 条私密结果未能发送，已保留待重试；GM 可使用规则包的「投递 重试」。`)
      }
      return true
    }
    let suffix = failedRecipients.length ? `\n有 ${failedRecipients.length} 条私密结果未能发送，已保留待重试；GM 可使用规则包的「投递 重试」。` : ""
    for (const update of result.groupCardUpdates || []) {
      if (String(update.userId) !== String(e.user_id || "")) continue
      const syncResult = await diceManager.syncAutoGroupCard(e, update.name)
      if (/失败/.test(syncResult)) suffix += syncResult
      else if (!syncResult) suffix += await diceManager.buildGroupCardSyncHint(e)
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
    const key = String(this.strip(e, "set") || "").trim()
    // 海豹包声明的规则键(.set dh / .set 匕首心):按 setConfig 契约应答
    const sealRule = key ? diceRulePackManager.findSealRuleByKey(e.group_id, key) : null
    if (sealRule) {
      if (sealRule.entry.diceSides > 0) {
        try {
          await this.runStateCommand(e, () => diceManager.handleSetOption(e, `d${sealRule.entry.diceSides}`))
        } catch {}
      }
      await this.reply(e, sealRule.entry.enableTip || `已切换至 ${key} 规则。`)
      return true
    }
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleSetOption(e, this.strip(e, "set"))))
    return true
  }

  async sn(e) {
    const raw = this.strip(e, "sn")
    const text = String(raw || "").trim()
    if (text && !/^(on|off|开启|关闭)$/i.test(text)) {
      // sealdice 内置名片模板：.sn coc / .sn cocL / .sn dnd —— 按卡摘要写群名片
      try {
        const applied = await diceManager.applyBuiltinCardTemplate(e, text)
        if (applied !== null) {
          await this.reply(e, `名片已按内置模板 ${text} 设置为：${applied}`)
          return true
        }
      } catch (error) {
        await this.reply(e, `名片设置失败：${buildVisibleFailureDetail(error)}`)
        return true
      }
      // 规则包名片模板(如 .sn dh/.sn gm):从包的 nameTemplate 按名应用
      const refreshed = diceRulePackManager.refreshSealCard(e, text)
      if (refreshed) {
        await this.reply(e, `已按名片模板 ${text} 应用。`)
        return true
      }
      // 都不是：交给 handleSn 按「设置骰娘昵称并立即同步群名片」处理（sealdice 直觉）
    }
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleSn(e, raw)))
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

  // 旁观模式：.obon / .oboff / .ob list
  async observer(e) {
    const match = matchDiceCommand(String(e.msg || ""), "(obon|oboff|ob)\\s*([\\s\\S]*)")
    const head = String(match?.[1] || "ob").toLowerCase()
    const action = head === "obon" ? "on" : head === "oboff" ? "off" : String(match?.[2] || "").trim().toLowerCase()
    await this.reply(e, await diceManager.handleObserve(e, action))
    return true
  }

  // .name [zh|en|jp] [数量] 随机姓名（fnc 不能叫 name：plugin 基类的 this.name 是插件名字符串）
  async randomName(e) {
    await this.reply(e, diceManager.handleName(e, this.strip(e, "name")))
    return true
  }

  // .log list 本群团录列表
  async logList(e) {
    await this.reply(e, diceManager.handleLogList(e))
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

  async team(e) {
    await this.reply(e, await this.runStateCommand(e, () => diceManager.handleTeam(e, this.strip(e, "组队"))))
    return true
  }

  async stat(e) {
    await this.reply(e, diceManager.handleStat(e, this.strip(e, "stat")), { kind: "ranking" })
    return true
  }

  async who(e) {
    await this.reply(e, diceManager.handleWho(e, this.strip(e, "who")))
    return true
  }

  async ping(e) {
    await this.reply(e, diceManager.handlePing(e))
    return true
  }

  async opposed(e) {
    await this.reply(e, diceManager.handleOpposed(e, this.strip(e, "rav")))
    return true
  }

  async seaCocCheck(e) {
    const text = String(e.msg || "")
    const match = matchDiceCommand(text, "(rab|rap|rahb|rahp|rah|ra)(\\d+)?(#)?(\\d+)?(b|p)?\\s*([\\s\\S]*)")
    const head = String(match?.[1] || "ra").toLowerCase()
    const num = Number(match?.[2] || 0)
    const hash = Boolean(match?.[3])
    const afterHash = Number(match?.[4] || 0) || undefined
    const suffix = String(match?.[5] || "").toLowerCase()
    const hasBonus = head.includes("b") || suffix === "b"
    const hasPenalty = head.includes("p") || suffix === "p"
    let modifier
    let rounds
    if (hash) {
      // sealdice：.ra 3#技能 / .ra 3#p 技能 —— #前数字是轮数，b/p 是每轮奖惩骰
      rounds = (afterHash && afterHash > 0) ? afterHash : (num > 0 ? num : 1)
      modifier = hasBonus ? 1 : hasPenalty ? -1 : 0
    } else {
      // 头部没有 b/p 时传 undefined，交给 parseCheckArgs 识别参数区前缀（.ra b 侦查 60）
      modifier = head.includes("b") ? (num || 1) : head.includes("p") ? -(num || 1) : undefined
      // 非 b/p 头部紧贴的数字视为轮数（.ra3技能90，与 .r3#d100 对齐）
      rounds = afterHash ?? (num > 0 && !head.includes("b") && !head.includes("p") ? num : undefined)
    }
    const hidden = head.includes("h")
    const raw = match?.[6] || ""
    await this.reply(e, hidden ? await diceManager.handleHiddenCheck(e, raw, { modifier, rounds }) : diceManager.handleCheck(e, raw, { modifier, rounds }))
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

  async drawCard(e) {
    const text = this.strip(e, "(?:draw|抽牌)").trim()
    const [, sub, rest] = text.match(/^(\S+)(?:\s+([\s\S]+))?$/) || []
    if (!sub || /^(help|帮助)$/i.test(sub)) {
      await this.reply(e, [
        ".draw <牌组> // 抽牌",
        ".draw keys [牌堆名] // 查看牌组关键字",
        ".draw list // 查看已载入牌堆",
        ".draw search <关键词> // 搜索牌组",
        ".draw desc <关键词> // 查看牌堆信息",
        ".draw reload // 重载牌堆（仅主人）"
      ].join("\n"))
      return true
    }
    if (/^keys$/i.test(sub)) {
      await this.reply(e, deckManager.listKeys((rest || "").trim()))
      return true
    }
    if (/^list$/i.test(sub)) {
      await this.reply(e, deckManager.listDecks())
      return true
    }
    if (/^search$/i.test(sub)) {
      await this.reply(e, deckManager.searchDecks((rest || "").trim()))
      return true
    }
    if (/^desc$/i.test(sub)) {
      await this.reply(e, deckManager.descDeck((rest || "").trim()))
      return true
    }
    if (/^reload$/i.test(sub)) {
      if (!e.isMaster) {
        await this.reply(e, "只有主人可以重载牌堆。")
        return true
      }
      const count = deckManager.reload()
      await this.reply(e, `已重载 ${count} 个牌堆${deckManager.lastError ? "，部分文件有错误：" + deckManager.lastError : ""}`)
      return true
    }
    const ctx = {
      playerName: diceManager.getUserName(e),
      selfName: globalThis.Bot?.nickname || "骰娘",
      pools: {}
    }
    const result = deckManager.draw(sub, ctx)
    await this.reply(e, result.error || `${ctx.playerName} 抽取【${sub}】：${result.text}`)
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
    const reply = await this.runStateCommand(e, () => diceManager.handleSt(e, this.strip(e, "st")))
    // .st 录属性后立即重刷海豹名片模板(若有活跃规则包),让希望/HP等即时反映
    if (/更新|录入|增加|减少/.test(String(reply || ""))) {
      try { diceRulePackManager.refreshSealCard(e) } catch {}
    }
    await this.reply(e, reply)
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
