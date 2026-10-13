import type { MemoryCommandPort, MemoryFact } from '../../../contracts/sharedRuntime.js'
import { memoryRecord } from '../../../contracts/memoryEngine.js'
import { extractDeliveryMessageId, logDeliveryOutcome } from '../../messaging/domain/deliveryObservability.js'
import { memStats } from '../infrastructure/engine/stats.js'
import type { createGlobalStyleLearnerClass } from '../infrastructure/globalStyleLearner.js'
import type { createPersonaFeedbackModule } from '../infrastructure/personaFeedbackManager.js'
import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'
import { factShortId } from '../infrastructure/engine/entityModel.js'
interface CommandEvent {msg?:string;group_id?:string|number;user_id?:string|number;self_id?:string|number;bot?:{uin?:unknown};isMaster?:boolean;sender?:{role?:string};reply(payload:unknown,quote?:boolean):Promise<unknown>}
interface Logger {info?(message:string):void;warn(message:string,...details:unknown[]):void;error(message:string,...details:unknown[]):void}
type Style = InstanceType<ReturnType<typeof createGlobalStyleLearnerClass>>
type Persona = InstanceType<ReturnType<typeof createPersonaFeedbackModule>['PersonaFeedbackManager']>
function errorMessage(error:unknown) {return error instanceof Error?error.message:String(error)}
export function createMemoryCommands(ports:{PluginBase:new(options:{name:string;dsc:string;event:string;priority:number;rule:{reg:string;fnc:string}[]})=>object;getSharedMemoryManager():MemoryCommandPort;getSharedConfig():Readonly<Record<string,unknown>>;globalStyleLearnerManager:Style;personaFeedbackManager:Persona;logger:Logger;makeForwardMsg(event:CommandEvent,messages:string[],title:string):Promise<unknown>}) {
const {getSharedMemoryManager,getSharedConfig,globalStyleLearnerManager,personaFeedbackManager,logger}=ports
const styleConfig=()=>globalStyleLearnerManager.normalizeInputConfig(getSharedConfig().globalStyleLearning)
const embeddingConfig=()=> {const r=memoryRecord(getSharedConfig().embeddingAiConfig);return {embeddingApiUrl:String(r.embeddingApiUrl||''),embeddingApiKey:String(r.embeddingApiKey||''),embeddingApiModel:String(r.embeddingApiModel||'')}}
const memoryAiConfig=()=> {const r=memoryRecord(getSharedConfig().memoryAiConfig);return {memoryAiUrl:String(r.memoryAiUrl||''),memoryAiApikey:String(r.memoryAiApikey||''),memoryAiModel:String(r.memoryAiModel||'')}}
const replyFailures = new WeakMap<CommandEvent, { error: unknown }>()
const clearGroupMemoryPending = new Map<string,number>()
const CLEAR_GROUP_MEMORY_CONFIRM_TTL_MS = 30000

return class MemoryCommandsPlugin extends ports.PluginBase {
  constructor() {
    super({
      name: "shiloh-plugin 记忆与表达命令",
      dsc: "#记忆状态 / #我的记忆 / #群记忆 / .表达学习 / .希洛反馈 等记忆管理命令",
      event: "message",
      priority: 1500,
      rule: [
        { reg: "^#记忆状态$", fnc: "memoryStatus" },
        { reg: "^#记忆统计$", fnc: "memoryStats" },
        { reg: "^#我的记忆$", fnc: "listMyMemory" },
        { reg: "^#群记忆$", fnc: "listGroupMemory" },
        { reg: "^#群工作流$", fnc: "listGroupWorkflows" },
        { reg: "^#删除群工作流\\s+\\S+$", fnc: "deleteGroupWorkflow" },
        { reg: "^#群知识$", fnc: "listGroupKnowledge" },
        { reg: "^#删除群知识\\s+\\S+$", fnc: "deleteGroupKnowledge" },
        { reg: "^#搜索记忆\\s+[\\s\\S]+$", fnc: "searchMemory" },
        { reg: "^#删除记忆\\s+\\S+$", fnc: "deleteMemory" },
        { reg: "^#清空我的记忆$", fnc: "clearMyMemory" },
        { reg: "^#清空群记忆$", fnc: "clearGroupMemory" },
        { reg: "^#禁用我的记忆$", fnc: "disableMyMemory" },
        { reg: "^#启用我的记忆$", fnc: "enableMyMemory" },
        { reg: "^#清除群记忆$", fnc: "clearGroupMemory" },
        { reg: "^[#＃.。]\\s*希洛反馈\\s+[\\s\\S]+$", fnc: "recordPersonaFeedback" },
        { reg: "^[#＃.。]\\s*(全局表达学习|表达学习)\\s*(报告|状态|记忆|总结|候选|自主|清空|帮助)?\\s*$", fnc: "globalStyleLearningCommand" }
      ]
    })
  }

  memory() {
    return getSharedMemoryManager()
  }

  async sendObservedReply(e:CommandEvent, payload:unknown, quote = false, channel = "command") {
    replyFailures.delete(e)
    try {
      const result = await e.reply(payload, quote)
      logDeliveryOutcome(logger, {
        status: "sent",
        channel,
        groupId: e?.group_id ?? "",
        userId: e?.user_id ?? "",
        messageId: extractDeliveryMessageId(result)
      })
      return result
    } catch (error) {
      replyFailures.set(e, { error })
      logDeliveryOutcome(logger, {
        status: "failed",
        channel,
        groupId: e?.group_id ?? "",
        userId: e?.user_id ?? "",
        error
      })
      throw error
    }
  }

  async recordPersonaFeedback(e: CommandEvent) {
    const result = await personaFeedbackManager.recordFeedback(e, e.msg || "")
    const feedback = personaFeedbackManager.getLatestFeedback(e)
    if (feedback) {
      try {
        globalStyleLearnerManager.observePersonaFeedback(
          feedback,
          styleConfig(),
          embeddingConfig()
        )
      } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
        logger.warn(`[全局表达学习] 记录主人反馈失败: ${errorMessage(error)}`)
      }
    }
    await this.sendObservedReply(e, result)
    return true
  }

  async globalStyleLearningCommand(e: CommandEvent) {
    if (!e?.isMaster) {
      await this.sendObservedReply(e, "只有主人可以查看或调整全局表达学习。")
      return true
    }
    const text = String(e.msg || "")
    const subCommand = text
      .replace(/^[#＃.。]\s*(全局表达学习|表达学习)\s*/, "")
      .trim()
    const helpText = [
      "全局表达学习：",
      ".表达学习 状态 - 看是否在学习、是否已注入",
      ".表达学习 记忆 - 看希洛当前会吸收/避开的表达策略",
      ".表达学习 报告 - 看样本和离散特征统计",
      ".表达学习 总结 - 调用模型，把脱敏样本沉淀成表达规则",
      ".表达学习 候选 - 看自主学习候选和影子策略",
      ".表达学习 清空 - 清空全局表达学习记忆"
    ].join("\n")

    if (!subCommand || /帮助/.test(subCommand)) {
      await this.sendObservedReply(e, helpText)
      return true
    }
    if (/清空/.test(subCommand)) {
      globalStyleLearnerManager.clear(styleConfig())
      await this.sendObservedReply(e, "全局表达学习记忆已清空。")
      return true
    }
    if (/总结/.test(subCommand)) {
      try {
        const result = await globalStyleLearnerManager.summarizeWithAI(
          styleConfig(),
          memoryAiConfig()
        )
        await this.sendObservedReply(e, [
          "全局表达学习总结完成：",
          `本次参考脱敏样本：${result.sampleCount} 条`,
          `新增/更新可吸收规则：${result.absorbChanged} 条`,
          `新增/更新避坑规则：${result.avoidChanged} 条`,
          `当前模型规则：可吸收 ${result.totalAbsorb} 条，避坑 ${result.totalAvoid} 条`
        ].join("\n"))
      } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
        logger.warn(`[全局表达学习] 模型总结失败: ${errorMessage(error)}`)
        await this.sendObservedReply(e, `全局表达学习总结失败：${errorMessage(error)}`)
      }
      return true
    }
    if (/报告/.test(subCommand)) {
      await this.sendObservedReply(e, globalStyleLearnerManager.buildReport(styleConfig()))
      return true
    }
    if (/候选|自主/.test(subCommand)) {
      await this.sendObservedReply(e, globalStyleLearnerManager.buildAutoEvolutionView(styleConfig()))
      return true
    }
    if (/记忆/.test(subCommand)) {
      await this.sendObservedReply(e, globalStyleLearnerManager.buildMemoryView(styleConfig()))
      return true
    }
    if (/状态/.test(subCommand)) {
      await this.sendObservedReply(e, globalStyleLearnerManager.buildStatus(styleConfig()))
      return true
    }
    await this.sendObservedReply(e, helpText)
    return true
  }

  async clearGroupMemory(e: CommandEvent) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    if (!this.isGroupMemoryAdmin(e)) {
      await this.sendObservedReply(e, "只有群主、管理员或主人可以清空群记忆")
      return true
    }

    // P0-1 二次确认：首次仅登记 pending（30s 过期），需再发一次同命令才真正清空。
    const pendingKey = `${e.self_id ?? e.bot?.uin ?? "legacy"}_${e.group_id}_${e.user_id}`
    const now = Date.now()
    const expireAt = clearGroupMemoryPending.get(pendingKey)
    if (!expireAt || expireAt < now) {
      clearGroupMemoryPending.set(pendingKey, now + CLEAR_GROUP_MEMORY_CONFIRM_TTL_MS)
      await this.sendObservedReply(e, "这会清空整群的记忆且不可恢复。请在 30 秒内再发一次 #清空群记忆 确认。")
      return true
    }
    clearGroupMemoryPending.delete(pendingKey)

    let cleared:number
    try {
      const result = await this.memory().adminClearMemories({ groupId: e.group_id })
      cleared=result.cleared
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 清空群记忆失败:", error)
      await this.sendObservedReply(e, "清空群记忆失败，请看日志")
      return true
    }
    await this.sendObservedReply(e, `已清空本群群记忆，共 ${cleared} 项存储键。`)
    return true
  }

  async memoryStatus(e: CommandEvent) {
    try {
      const status = await this.memory().adminStatus({
        groupId: e.group_id,
        userId: e.user_id
      })
      const user = memoryRecord(status.user)
      const group = memoryRecord(status.group)
      const config = memoryRecord(status.config)
      const lines = [
        `记忆系统：${status.enabled ? "开启" : "关闭"}`,
        `我的记忆：${user.optedOut ? "已禁用" : "启用"}，事实 ${user.factCount || 0} 条，别名 ${user.aliasCount || 0} 条`,
        `群记忆：${group.disabled ? "已禁用" : "启用"}，实体 ${group.entityCount || 0} 个，群事实 ${group.factCount || 0} 条，别名 ${group.aliasCount || 0} 条，工作流 ${group.workflowCount || 0} 条，群知识 ${group.knowledgeCount || 0} 条`,
        `群上次抽取：${this.formatMemoryTime(group.lastExtractAt)}，连续失败 ${group.failureCount || 0} 次`,
        `保存严格度：${config.saveStrictness ?? "默认"}，语义召回：${config.semanticRecallEnabled ? "开启" : "关闭"}，主动回扣：${config.proactiveCallback ? "开启" : "关闭"}`,
        `上限：实体/群 ${config.maxEntitiesPerGroup ?? "-"}，事实/群 ${config.maxFactsPerGroup ?? "-"}`
      ]
      await this.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 读取记忆状态失败:", error)
      await this.sendObservedReply(e, "记忆状态读取失败，请看日志")
    }
    return true
  }

  async memoryStats(e: CommandEvent) {
    if (!this.isGroupMemoryAdmin(e)) {
      await this.sendObservedReply(e, "只有群主、管理员或主人可以查看记忆统计")
      return true
    }
    try {
      const { counters, timings } = memStats.snapshot()
      const num = (key:string) => Number(counters[key] || 0)

      const embedTotal = num("embed.hit") + num("embed.miss")
      const embedHitRate = embedTotal ? ((num("embed.hit") / embedTotal) * 100).toFixed(1) : "0.0"
      const extractFailRate = num("llm.extract.call")
        ? ((num("llm.extract.fail") / num("llm.extract.call")) * 100).toFixed(1)
        : "0.0"
      const reflectFailRate = num("llm.reflect.call")
        ? ((num("llm.reflect.fail") / num("llm.reflect.call")) * 100).toFixed(1)
        : "0.0"
      const avgMs = (key:string) => (timings[key]?.avgMs ? timings[key].avgMs.toFixed(0) : "0")

      const lines = [
        "记忆系统调用统计（进程内，重启归零）",
        `抽取(用户)：flush ${num("extract.user.flushed")} / buffer ${num("extract.user.buffered")} / opt-out ${num("extract.user.optedOut")}`,
        `抽取(群)：run ${num("extract.group.run")} / 节流 ${num("extract.group.throttled")} / 边界丢弃 ${num("extract.boundary.drop")}`,
        `LLM 抽取：调用 ${num("llm.extract.call")}，失败 ${num("llm.extract.fail")}（${extractFailRate}%），平均 ${avgMs("llm.extract.ms")}ms`,
        `LLM 反思：调用 ${num("llm.reflect.call")}，失败 ${num("llm.reflect.fail")}（${reflectFailRate}%），平均 ${avgMs("llm.reflect.ms")}ms`,
        `Embedding：命中 ${num("embed.hit")} / 未命中 ${num("embed.miss")}（命中率 ${embedHitRate}%），失败 ${num("embed.fail")}，平均 ${avgMs("embed.ms")}ms`
      ]
      await this.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 读取记忆统计失败:", error)
      await this.sendObservedReply(e, "记忆统计读取失败，请看日志")
    }
    return true
  }

  async listMyMemory(e: CommandEvent) {
    try {
      const result = await this.memory().adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "我的记忆", [
        { title: "我的记忆", facts: result.facts }
      ])
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 读取我的记忆失败:", error)
      await this.sendObservedReply(e, "读取我的记忆失败，请看日志")
    }
    return true
  }

  async listGroupMemory(e: CommandEvent) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }

    try {
      const result = await this.memory().adminListMemories({
        scope: "group",
        groupId: e.group_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "群记忆", [
        { title: "群记忆", facts: result.facts }
      ])
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 读取群记忆失败:", error)
      await this.sendObservedReply(e, "读取群记忆失败，请看日志")
    }
    return true
  }

  async listGroupWorkflows(e: CommandEvent) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      const workflows = await this.memory().getGroupWorkflowRules(e.group_id)
      if (!workflows.length) {
        await this.sendObservedReply(e, "本群还没有已教会的工作流。")
        return true
      }
      const lines = ["本群已教会的工作流："]
      for (const rule of workflows) {
        const targets = (rule.targets || []).map(item => `${item.displayName || item.userId}(QQ:${item.userId})`).join("、")
        lines.push(`[${rule.id}] ${rule.condition} -> 通知 ${targets}`)
      }
      await this.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[群工作流] 列表失败:", error)
      await this.sendObservedReply(e, "读取群工作流失败，请看日志")
    }
    return true
  }

  async deleteGroupWorkflow(e: CommandEvent) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    const id = String(e.msg || "").replace(/^#删除群工作流\s+/, "").trim()
    try {
      const workflows = await this.memory().getGroupWorkflowRules(e.group_id)
      const rule = workflows.find(item => String(item?.id || "") === id)
      if (!rule) {
        await this.sendObservedReply(e, "没有找到这条群工作流。")
        return true
      }
      if (!this.isGroupMemoryAdmin(e) && String(rule.createdBy || "") !== String(e.user_id || "")) {
        await this.sendObservedReply(e, "只有创建者、群主、管理员或主人可以删除这条群工作流。")
        return true
      }
      const result = await this.memory().adminDeleteGroupWorkflow({ groupId: e.group_id, id })
      await this.sendObservedReply(e, result.deleted ? "已删除这条群工作流。" : "删除失败：没有找到这条群工作流。")
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[群工作流] 删除失败:", error)
      await this.sendObservedReply(e, "删除群工作流失败，请看日志")
    }
    return true
  }

  async listGroupKnowledge(e: CommandEvent) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      const entries = await this.memory().getGroupKnowledgeEntries(e.group_id)
      if (!entries.length) {
        await this.sendObservedReply(e, "本群还没有已教会的群知识。")
        return true
      }
      const lines = ["本群已教会的群知识："]
      for (const entry of entries) {
        if (entry.kind === "group_file") {
          lines.push(`[${entry.id}] ${entry.ownerQQ ? `QQ:${entry.ownerQQ} 的` : ""}${entry.subject} = 群文件「${entry.resource?.fileName || "未知"}」`)
        } else {
          const targets = (entry.targets || []).map(item => `${item.displayName || item.userId}(QQ:${item.userId})`).join("、")
          lines.push(`[${entry.id}] ${entry.subject} = ${targets}`)
        }
      }
      await this.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[群知识] 列表失败:", error)
      await this.sendObservedReply(e, "读取群知识失败，请看日志")
    }
    return true
  }

  async deleteGroupKnowledge(e: CommandEvent) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    const id = String(e.msg || "").replace(/^#删除群知识\s+/, "").trim()
    try {
      const entries = await this.memory().getGroupKnowledgeEntries(e.group_id)
      const entry = entries.find(item => String(item?.id || "") === id)
      if (!entry) {
        await this.sendObservedReply(e, "没有找到这条群知识。")
        return true
      }
      if (!this.isGroupMemoryAdmin(e) && String(entry.createdBy || "") !== String(e.user_id || "")) {
        await this.sendObservedReply(e, "只有创建者、群主、管理员或主人可以删除这条群知识。")
        return true
      }
      const result = await this.memory().adminDeleteGroupKnowledge({ groupId: e.group_id, id })
      await this.sendObservedReply(e, result.deleted ? "已删除这条群知识。" : "删除失败：没有找到这条群知识。")
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[群知识] 删除失败:", error)
      await this.sendObservedReply(e, "删除群知识失败，请看日志")
    }
    return true
  }

  async searchMemory(e: CommandEvent) {
    const query = String(e.msg || "").replace(/^#搜索记忆\s+/, "").trim()
    if (!query) {
      await this.sendObservedReply(e, "请输入要搜索的关键词")
      return true
    }

    try {
      const myResult = await this.memory().adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        query,
        limit: 10
      })
      const groupResult = e.group_id
        ? await this.memory().adminListMemories({
            scope: "group",
            groupId: e.group_id,
            query,
            limit: 10
          })
        : { facts: [] }
      await this.replyMemoryForward(e, "搜索记忆", [
        { title: "我的匹配记忆", facts: myResult.facts },
        { title: "群匹配记忆", facts: groupResult.facts }
      ])
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 搜索记忆失败:", error)
      await this.sendObservedReply(e, "搜索记忆失败，请看日志")
    }
    return true
  }

  async deleteMemory(e: CommandEvent) {
    const id = String(e.msg || "").replace(/^#删除记忆\s+/, "").trim()
    if (!id) {
      await this.sendObservedReply(e, "请输入要删除的记忆 id")
      return true
    }

    try {
      const result = await this.memory().adminDeleteMemory({ groupId: e.group_id, userId: e.user_id, id })

      await this.sendObservedReply(e, result.deleted ? `已删除记忆 ${id}` : "没有找到可删除的记忆，普通用户只能删除自己的记忆")
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 删除记忆失败:", error)
      await this.sendObservedReply(e, "删除记忆失败，请看日志")
    }
    return true
  }

  async clearMyMemory(e: CommandEvent) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      // P0-1：只删该用户自己的 entity（旧实现误调 adminClearMemories 会清整群）。
      const result = await this.memory().clearUserMemory(e.group_id, e.user_id)
      await this.sendObservedReply(e, result?.cleared ? "已清空你在本群的记忆" : "你在本群没有可清空的记忆")
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 清空我的记忆失败:", error)
      await this.sendObservedReply(e, "清空我的记忆失败，请看日志")
    }
    return true
  }

  async disableMyMemory(e: CommandEvent) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      // P0-2：按真实返回写文案。返回 {enabled:<是否仍在记>}，false 表示已退出记忆。
      const result = await this.memory().adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: false
      })
      await this.sendObservedReply(e, result?.enabled === false
        ? "已禁用你在本群的长期记忆，之后不再记录你的发言"
        : "操作未生效，你的记忆仍处于启用状态")
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 禁用我的记忆失败:", error)
      await this.sendObservedReply(e, "禁用失败，请看日志")
    }
    return true
  }

  async enableMyMemory(e: CommandEvent) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      // P0-2：返回 {enabled:<是否仍在记>}，true 表示已重新启用记忆。
      const result = await this.memory().adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: true
      })
      await this.sendObservedReply(e, result?.enabled
        ? "已启用你在本群的长期记忆"
        : "操作未生效，你的记忆仍处于禁用状态")
    } catch (error) {
      if (replyFailures.has(e) && Object.is(replyFailures.get(e)?.error, error)) throw error
      logger.error("[记忆管理] 启用我的记忆失败:", error)
      await this.sendObservedReply(e, "启用失败，请看日志")
    }
    return true
  }

  isGroupMemoryAdmin(e: CommandEvent) {
    return Boolean(e.isMaster || ["owner", "admin"].includes(e.sender?.role || ""))
  }

  formatMemoryTime(timestamp:unknown) {
    if (!timestamp) return "无"
    return new Date(typeof timestamp === "number" || typeof timestamp === "string" ? timestamp : 0).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
  }

  memoryAuthoritySource(authority:string | undefined) {
    const map:Record<string,string> = { config: "配置", self: "本人说", teaching: "群里教", mention: "提及推断" }
    return map[authority || ""] || "提及推断"
  }

  async replyMemoryForward(e:CommandEvent,title:string,sections:{title:string;facts:MemoryFact[]}[]) {
    const messages:string[]=[]
    for(const section of sections) {
      if(!section.facts.length) {messages.push(`${section.title}\n暂无记忆`);continue}
      const lines=section.facts.map(fact=>`ID:${factShortId(fact.text)} [${fact.tags?.[0] || '未分类'}] ${fact.text}`)
      for(let i=0;i<lines.length;i+=12) messages.push(`${section.title} (${Math.floor(i/12)+1}/${Math.ceil(lines.length/12)})\n${lines.slice(i,i+12).join('\n')}`)
    }
    messages.push('删除单条记忆可发送：#删除记忆 my:<id>（删自己事实）或 #删除记忆 alias:<别名> / #删除记忆 fact:<群事实前缀>')
    let payload:unknown
    try {payload=await ports.makeForwardMsg(e,messages,title)} catch(error) {logger.warn('[记忆管理] 构建转发失败，回退文本',error);payload=safeTruncateUnicode(messages.join('\n\n'),4500)}
    await this.sendObservedReply(e,payload)
  }
}

}
