// 管理指令层:MCP 查询/调试 + 违禁词黑名单 + 多人设库的命令处理器。
// 从 apps/test.js 原样迁出(行为不变),this 依赖以 host(插件实例)注入——
// 热路径(聊天/工具)不经过这里,改动风险低。
import { mcpManager } from "../../utils/MCPClient.js"
import { formatTurnDiagnosticsText } from "../../utils/turnDiagnostics.js"
import { resolvePersonaName, renderPersonaTemplate } from "../../utils/personaSource.js"
import { findForbiddenWord } from "../../utils/forbiddenWordGuard.js"
import { applyFlatUpdates } from "../../utils/configWriter.js"

const logger = globalThis.logger

export async function mcpStatus(host, e) {
    await host.replyLongForward(e, "MCP状态", mcpManager.getStatusSummary())
    return true
}

export async function testMCPTool(host, e) {
    if (!e.isMaster) {
      await host.sendObservedReply(e, "只有主人才能执行此操作")
      return true
    }

    const input = String(e.msg || "").replace(/^#mcp\s+测试\s+/, "").trim()
    const spaceIndex = input.indexOf(" ")
    const alias = spaceIndex === -1 ? input : input.slice(0, spaceIndex)
    const rawParams = spaceIndex === -1 ? "{}" : input.slice(spaceIndex + 1).trim()

    if (!alias) {
      await host.sendObservedReply(e, "请输入要测试的 MCP 工具名，例如：#mcp 测试 mcp_server_search {\"query\":\"你好\"}")
      return true
    }

    let params = {}
    try {
      params = rawParams ? JSON.parse(rawParams) : {}
    } catch (error) {
      await host.sendObservedReply(e, `JSON 参数解析失败：${error.message}`)
      return true
    }

    try {
      const result = await mcpManager.executeToolByAlias(alias, params)
      await host.replyLongForward(e, `MCP测试 ${alias}`, result)
    } catch (error) {
      logger.error(`[MCP] 测试工具 ${alias} 失败:`, error)
      await host.sendObservedReply(e, `MCP工具测试失败：${error.message}`)
    }
    return true
}

export function isChatManager(host, e) {
    return Boolean(e?.isMaster || ["owner", "admin"].includes(e?.sender?.role))
}

export function forbiddenWordList(host) {
    const cfg = host.config?.forbiddenWords || {}
    return Array.isArray(cfg.words) ? cfg.words.map(w => String(w)).filter(Boolean) : []
}

export async function handleForbiddenList(host, e) {
    if (!e?.isMaster) {
      await host.sendObservedReply(e, "只有主人才能查看违禁词列表")
      return true
    }
    const words = host.forbiddenWordList()
    const cfg = host.config?.forbiddenWords || {}
    const lines = [
      `【违禁词黑名单】${cfg.enabled === false ? "(已停用)" : ""}`,
      words.length ? words.map((w, i) => `${i + 1}. ${w}`).join("\n") : "(空)",
      "",
      "命中即中断该群当前对话;bot 出站同样拦截。",
      "#加违禁词 <词> / #删违禁词 <词> 管理;支持 /正则/i 写法"
    ]
    await host.sendObservedReply(e, lines.join("\n"))
    return true
}

export async function handleForbiddenAdd(host, e) {
    if (!e?.isMaster) {
      await host.sendObservedReply(e, "只有主人才能添加违禁词")
      return true
    }
    const word = String(e.msg || "").replace(/^#加违禁词\s+/, "").trim()
    if (!word) {
      await host.sendObservedReply(e, "用法：#加违禁词 <词>,正则写法如 /xxx/i")
      return true
    }
    const words = host.forbiddenWordList()
    if (words.some(w => w === word)) {
      await host.sendObservedReply(e, `违禁词「${word}」已存在`)
      return true
    }
    words.push(word)
    applyFlatUpdates({ "forbiddenWords.words": words })
    logger.mark(`[违禁词] 新增「${word}」by=${e?.user_id}(热更新生效)`)
    await host.sendObservedReply(e, `已添加违禁词「${word}」,下一条消息起生效`)
    return true
}

export async function handleForbiddenRemove(host, e) {
    if (!e?.isMaster) {
      await host.sendObservedReply(e, "只有主人才能删除违禁词")
      return true
    }
    const word = String(e.msg || "").replace(/^#删违禁词\s+/, "").trim()
    const words = host.forbiddenWordList()
    const index = words.findIndex(w => w === word)
    if (index === -1) {
      await host.sendObservedReply(e, `没有找到违禁词「${word}」,发 #违禁词列表 看看`)
      return true
    }
    words.splice(index, 1)
    applyFlatUpdates({ "forbiddenWords.words": words })
    logger.mark(`[违禁词] 删除「${word}」by=${e?.user_id}(热更新生效)`)
    await host.sendObservedReply(e, `已删除违禁词「${word}」`)
    return true
}

export function resolvePersonaTargetGroup(host, e, explicit) {
    const target = String(explicit || "").trim()
    if (target) {
      if (!e?.isMaster) return { error: "带群号切换仅主人可用,群里直接发 #切换人设 <名字> 即可" }
      if (!/^\d{5,12}$/.test(target)) return { error: "群号格式不对" }
      return { groupId: target }
    }
    if (e?.message_type !== "group" || !e?.group_id) return { error: "这条命令要在群里用,或者主人用 #切换人设 <名字> <群号>" }
    return { groupId: String(e.group_id) }
}

export function formatPersonaDetail(host, detail) {
    const p = detail.persona || {}
    const lines = [`【人设:${p.name || "未命名"}】(id:${detail.id}${detail.source === "default" ? ",默认" : ""})`]
    const fieldLabels = [["identity", "身份"], ["tone", "语气"]]
    for (const [field, label] of fieldLabels) {
      const value = String(p[field] || "").trim()
      if (value) lines.push(`■ ${label}: ${value}`)
    }
    const listLabels = [["speechStyle", "说话风格"], ["preferences", "偏好"], ["boundaries", "边界"]]
    for (const [field, label] of listLabels) {
      const items = Array.isArray(p[field]) ? p[field].filter(Boolean) : []
      if (items.length) lines.push(`■ ${label}: ${items.join("、")}`)
    }
    const notes = String(p.notes || "").trim()
    if (notes) lines.push(`■ 备注: ${notes}`)
    return lines.join("\n")
}

export async function handlePersonaList(host, e) {
    try {
      const entries = host.personaLibrary.list()
      const resolved = host.personaLibrary.resolve({ messageType: e?.message_type, groupId: e?.group_id })
      const lines = ["【人设库】"]
      for (const item of entries) {
        const mark = item.id === resolved.id ? " ←当前" : ""
        lines.push(`- ${item.name}${item.source === "default" ? "(默认)" : ""} [${item.id}]${mark}`)
      }
      lines.push("", "#切换人设 <名字> 切换本群人设(管理)", "#人设详情 <名字> 查看内容", "#人设重置 回到默认")
      await host.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      await host.sendObservedReply(e, `人设列表读取失败：${error.message}`)
    }
    return true
}

export async function handlePersonaCurrent(host, e) {
    try {
      const detail = host.personaLibrary.resolve({ messageType: e?.message_type, groupId: e?.group_id })
      await host.sendObservedReply(e, host.formatPersonaDetail(detail))
    } catch (error) {
      await host.sendObservedReply(e, `读取当前人设失败：${error.message}`)
    }
    return true
}

export async function handlePersonaDetail(host, e) {
    const name = String(e.msg || "").replace(/^#人设详情\s+/, "").trim()
    const detail = host.personaLibrary.detail(name)
    if (!detail) {
      await host.sendObservedReply(e, `没有找到人设「${name}」,发 #人设列表 看看有哪些`)
      return true
    }
    await host.sendObservedReply(e, host.formatPersonaDetail(detail))
    return true
}

export async function handlePersonaSwitch(host, e) {
    const rest = String(e.msg || "").replace(/^#切换人设\s+/, "").trim()
    const spaceIndex = rest.indexOf(" ")
    const name = (spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)).trim()
    const explicitGroup = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1).trim()
    if (!host.isChatManager(e)) {
      await host.sendObservedReply(e, "切换人设要群主或群管理来操作哦")
      return true
    }
    const target = host.resolvePersonaTargetGroup(e, explicitGroup)
    if (target.error) {
      await host.sendObservedReply(e, target.error)
      return true
    }
    try {
      if (!name || name === "默认" || name === "default") {
        await host.personaLibrary.setGroupBinding(target.groupId, "default")
        await host.sendObservedReply(e, `群 ${target.groupId} 已切回默认人设`)
        return true
      }
      const entry = host.personaLibrary.detail(name)
      if (!entry) {
        await host.sendObservedReply(e, `没有找到人设「${name}」,发 #人设列表 看看有哪些`)
        return true
      }
      const bound = host.personaLibrary.setGroupBinding(target.groupId, entry.id)
      logger.mark(`[人设库] group=${target.groupId} 切换人设 -> ${entry.id}(${entry.persona?.name}) by=${e?.user_id}`)
      await host.sendObservedReply(e, `本群已切换为人设「${entry.persona?.name}」(id:${bound}),下一条回复开始生效`)
    } catch (error) {
      await host.sendObservedReply(e, `切换失败：${error.message}`)
    }
    return true
}

export async function handlePersonaReset(host, e) {
    const explicitGroup = String(e.msg || "").replace(/^#人设重置\s*/, "").trim()
    if (!host.isChatManager(e)) {
      await host.sendObservedReply(e, "重置人设要群主或群管理来操作哦")
      return true
    }
    const target = host.resolvePersonaTargetGroup(e, explicitGroup)
    if (target.error) {
      await host.sendObservedReply(e, target.error)
      return true
    }
    try {
      host.personaLibrary.setGroupBinding(target.groupId, "default")
      await host.sendObservedReply(e, `群 ${target.groupId} 已解绑,回到默认人设「${resolvePersonaName(host.config.persona)}」`)
    } catch (error) {
      await host.sendObservedReply(e, `重置失败：${error.message}`)
    }
    return true
}

export async function handlePersonaSave(host, e) {
    if (!e?.isMaster) {
      await host.sendObservedReply(e, "只有主人才能保存人设")
      return true
    }
    const name = String(e.msg || "").replace(/^#保存人设\s+/, "").trim()
    if (!name) {
      await host.sendObservedReply(e, "用法：#保存人设 <名字>,把当前会话生效的人设存成一套")
      return true
    }
    try {
      const resolved = host.personaLibrary.resolve({ messageType: e?.message_type, groupId: e?.group_id })
      const saved = host.personaLibrary.upsert({ ...resolved.persona, name })
      logger.mark(`[人设库] 保存人设 ${saved.id}(${saved.name}) by=${e?.user_id}`)
      await host.sendObservedReply(e, `已保存人设「${saved.name}」(id:${saved.id}),可以用 #切换人设 ${saved.name} 给群换上`)
    } catch (error) {
      await host.sendObservedReply(e, `保存失败：${error.message}`)
    }
    return true
}

export async function handlePersonaDelete(host, e) {
    if (!e?.isMaster) {
      await host.sendObservedReply(e, "只有主人才能删除人设")
      return true
    }
    const name = String(e.msg || "").replace(/^#删除人设\s+/, "").trim()
    if (!name || name === "default" || name === "默认") {
      await host.sendObservedReply(e, "默认人设不能删,它来自 message.yaml")
      return true
    }
    try {
      const removed = host.personaLibrary.remove(name)
      if (!removed) {
        await host.sendObservedReply(e, `没有找到人设「${name}」`)
        return true
      }
      logger.mark(`[人设库] 删除人设 ${removed.id}(${removed.name}) by=${e?.user_id}`)
      await host.sendObservedReply(e, `已删除人设「${removed.name}」,绑定它的群自动回到默认人设`)
    } catch (error) {
      await host.sendObservedReply(e, `删除失败：${error.message}`)
    }
    return true
}

export async function handlePersonaReload(host, e) {
    if (!e?.isMaster) {
      await host.sendObservedReply(e, "只有主人才能重载人设库")
      return true
    }
    try {
      const state = host.personaLibrary.reload()
      await host.sendObservedReply(e, `人设库已重载：${state.personas.length} 套自定义人设,${Object.keys(state.groupBindings).length} 个群绑定`)
    } catch (error) {
      await host.sendObservedReply(e, `重载失败：${error.message}`)
    }
    return true
}

export async function handlePersonaBindings(host, e) {
    if (!e?.isMaster) {
      await host.sendObservedReply(e, "只有主人才能查看全部绑定")
      return true
    }
    try {
      const bindings = host.personaLibrary.bindings()
      const entries = Object.entries(bindings).filter(([, id]) => id)
      if (!entries.length) {
        await host.sendObservedReply(e, "还没有任何群绑定自定义人设,全部用默认人设")
        return true
      }
      const lines = ["【人设绑定】"]
      for (const [groupId, personaId] of entries) {
        const detail = host.personaLibrary.detail(personaId)
        lines.push(`- ${groupId === "__private__" ? "私聊" : `群 ${groupId}`} → ${detail?.persona?.name || personaId}`)
      }
      await host.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      await host.sendObservedReply(e, `读取绑定失败：${error.message}`)
    }
    return true
}
