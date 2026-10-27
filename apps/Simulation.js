// 仿真模式命令插件：.仿真 开/关/状态/重置/帮助 + 戳一戳入流
import { simulationRuntime, parseSimulationCommand, isSimulationManager, SIMULATION_COMMAND_HELP } from '../utils/simulationRuntime.js'

export class SimulationCommandPlugin extends plugin {
  constructor() {
    super({
      name: 'shiloh-simulation',
      dsc: '自主仿真模式管理（AI 自主收发群消息）',
      event: 'message',
      priority: 2000,
      rule: [
        { reg: '^\\.仿真', fnc: 'handleSimulation', log: false },
        { reg: '^\\.好感度$', fnc: 'handleAffinity', log: false },
      ],
    })
  }

  async handleSimulation(e) {
    if (!e.group_id) return false
    const parsed = parseSimulationCommand(e.msg || e.raw_message)
    if (!parsed) return false
    if (!isSimulationManager(e)) {
      await e.reply('只有群管理或主人可以管理仿真模式', true)
      return true
    }
    const groupId = String(e.group_id)
    try {
      if (parsed.action === '开') await e.reply(await simulationRuntime.enableGroup(groupId), true)
      else if (parsed.action === '关') await e.reply(await simulationRuntime.disableGroup(groupId), true)
      else if (parsed.action === '状态') await e.reply(await simulationRuntime.groupStatus(groupId), true)
      else if (parsed.action === '记忆') await e.reply(await simulationRuntime.listMemories(groupId), true)
      else if (parsed.action === '重置') await e.reply(await simulationRuntime.resetGroup(groupId), true)
      else await e.reply(SIMULATION_COMMAND_HELP, true)
    } catch (error) {
      globalThis.logger?.error?.('[仿真] 命令处理失败', error)
      await e.reply(`仿真命令执行失败：${error?.message || error}`, true)
    }
    return true
  }

  async handleAffinity(e) {
    if (!e.group_id) return false
    try {
      await e.reply(await simulationRuntime.listAffinity(String(e.group_id), String(e.user_id || '')), true)
    } catch (error) {
      await e.reply(`好感度查询失败：${error?.message || error}`, true)
    }
    return true
  }
}


// 戳一戳入流：被戳到机器人 → 仿真会话收到一条 poke 消息并按 triggers.poke 唤醒
export class SimulationPokePlugin extends plugin {
  constructor() {
    super({
      name: 'shiloh-simulation-poke',
      dsc: '仿真模式戳一戳感知',
      event: 'notice',
      priority: 2000,
      rule: [
        { reg: '', fnc: 'handlePoke', log: false },
      ],
    })
  }

  async handlePoke(e) {
    if (e.notice_type !== 'notify' && e.notice_type !== 'poke') return false
    if (String(e.sub_type || '') !== 'poke') return false
    if (!e.group_id) return false
    try {
      await simulationRuntime.ingestPoke({
        group_id: e.group_id,
        user_id: e.user_id,
        self_id: e.self_id || e.bot?.uin,
        target_id: e.target_id,
        sender: e.sender,
      })
    } catch (error) {
      globalThis.logger?.warn?.(`[仿真] 戳一戳入流失败：${error?.message || error}`)
    }
    return false
  }
}
