import { diceManager } from "./DiceManager.js"

export class DiceLogRecorder extends plugin {
  constructor() {
    super({
      name: "COC骰娘-log记录",
      dsc: "跑团 log 开启时后台记录群消息",
      event: "message.group",
      priority: 10045,
      rule: [
        { reg: ".*", fnc: "recordDiceLog", log: false }
      ]
    })
  }

  async recordDiceLog(e) {
    diceManager.recordLogMessage(e).catch(error => {
      logger.warn(`[骰娘] log 记录失败: ${error.message}`)
    })
    return false
  }
}
