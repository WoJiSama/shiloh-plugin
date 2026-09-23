import { readObservabilityTail, getObservabilityState } from "../utils/obsLog.js"

export class ObsLogQuery extends plugin {
  constructor() {
    super({
      name: "shiloh-plugin观测日志查询",
      dsc: "#观测日志 查看工具调用/路由决策/模型耗时流水",
      event: "message",
      priority: 100,
      rule: [
        { reg: "^#观测日志(状态)?(\\s+\\d+)?$", fnc: "query", permission: "master" }
      ]
    })
  }

  async query(e = this.e) {
    const match = String(e.msg || "").match(/^#观测日志(状态)?(?:\s+(\d+))?$/)
    if (match?.[1]) {
      const state = getObservabilityState()
      await e.reply(`观测日志状态:\n- 启用: ${state.installed ? "是" : "否"}\n- 目录: ${state.dir || "(未安装)"}\n- 保留: ${state.retentionDays} 天\n- 本次运行已记录: ${state.writeCount} 条`)
      return true
    }
    const lines = await readObservabilityTail(Number(match?.[2] || 60))
    if (!lines.length) {
      await e.reply("观测日志还没有内容(匹配标签的 info 尚未触发,或已过期清理)。")
      return true
    }
    const text = lines.join("\n")
    const body = text.length > 3500 ? `${text.slice(-3500)}\n…(仅展示末尾)` : text
    await e.reply(`最近 ${lines.length} 条观测记录:\n${body}`)
    return true
  }
}
