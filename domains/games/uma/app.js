import { umaRaceManager } from "./UmaRaceManager.js"
import { sendSmartReply } from "../../../utils/SmartReply.js"

export class UmaRacePlugin extends plugin {
  constructor() {
    super({
      name: "赛马娘小游戏",
      dsc: "群聊赛马小游戏和全局 QQ 积分",
      event: "message",
      priority: 550,
      rule: [
        { reg: "^[.。]赛马娘\\s*$", fnc: "showHelp" },
        { reg: "^[.。]赛马娘\\s*(帮助|help)\\s*$", fnc: "showHelp" },
        { reg: "^[.。]赛马娘\\s*(领养|创建|注册)\\s+[\\s\\S]+$", fnc: "adoptUma" },
        { reg: "^[.。]赛马娘\\s*重新领养\\s+[\\s\\S]+$", fnc: "readoptUma" },
        { reg: "^[.。]赛马娘\\s*(弃养|放生)(\\s*确认)?\\s*$", fnc: "abandonUma" },
        { reg: "^[.。]赛马娘\\s*(我的赛马娘|赛马娘信息|属性|六维)\\s*$", fnc: "showUma" },
        { reg: "^[.。]赛马娘\\s*(词条|小马词条)\\s*$", fnc: "showAffix" },
        { reg: "^[.。]赛马娘\\s*(重铸|洗练|洗词条)\\s*$", fnc: "rerollAffix" },
        { reg: "^[.。]赛马娘\\s*(词条池|词条列表)\\s*$", fnc: "showAffixPool" },
        { reg: "^[.。]赛马娘\\s*(训练|训练状态|训练进度)\\s*$", fnc: "showTrainingStatus" },
        { reg: "^[.。]赛马娘\\s*训练\\s+[\\s\\S]+$", fnc: "trainUma" },
        { reg: "^[.。]赛马娘\\s*(开始|开局|创建)\\s*$", fnc: "startRace" },
        { reg: "^[.。]赛马娘\\s*(加入|参加|上马|报名)([\\s\\S]*)$", fnc: "joinRace" },
        { reg: "^[.。]赛马娘\\s*(决策|选择|行动|策略)\\s+[\\s\\S]+$", fnc: "raceDecision" },
        { reg: "^[.。]赛马娘\\s*(开跑|开赛|比赛|冲|跑)\\s*$", fnc: "runRace" },
        { reg: "^[.。]赛马娘\\s*(取消|关闭|结束)\\s*$", fnc: "cancelRace" },
        { reg: "^[.。]赛马娘\\s*(加积分|改积分|调整积分)\\s+[\\s\\S]+$", fnc: "adjustScore" },
        { reg: "^[.。]赛马娘\\s*(积分|分数|我的积分)\\s*$", fnc: "showScore" },
        { reg: "^[.。]赛马娘\\s*(排行|排行榜|排名)(\\s+\\d+)?\\s*$", fnc: "showRank" }
      ]
    })
  }

  async reply(e, output, options = {}) {
    return await sendSmartReply(e, output, options)
  }

  async showHelp(e) {
    await this.reply(e, umaRaceManager.showHelp(), { kind: "diceLong" })
    return true
  }

  async startRace(e) {
    await this.reply(e, await umaRaceManager.startRace(e), { kind: "umaRaceResult" })
    return true
  }

  async adoptUma(e) {
    await this.reply(e, await umaRaceManager.adoptUma(e))
    return true
  }

  async readoptUma(e) {
    await this.reply(e, await umaRaceManager.adoptUma(e, { overwrite: true }))
    return true
  }

  async abandonUma(e) {
    await this.reply(e, await umaRaceManager.abandonUma(e, { confirm: /确认/.test(String(e.msg || "")) }))
    return true
  }

  async showUma(e) {
    await this.reply(e, umaRaceManager.showUma(e), { kind: "umaRaceResult" })
    return true
  }

  async showAffix(e) {
    await this.reply(e, umaRaceManager.showAffix(e), { kind: "umaRaceResult" })
    return true
  }

  async rerollAffix(e) {
    await this.reply(e, await umaRaceManager.rerollAffix(e), { kind: "umaRaceResult" })
    return true
  }

  async showAffixPool(e) {
    await this.reply(e, umaRaceManager.showAffixPool(), { kind: "diceLong" })
    return true
  }

  async trainUma(e) {
    await this.reply(e, await umaRaceManager.trainUma(e), { kind: "umaRaceResult" })
    return true
  }

  async showTrainingStatus(e) {
    await this.reply(e, umaRaceManager.showTrainingStatus(e), { kind: "umaRaceResult" })
    return true
  }

  async joinRace(e) {
    await this.reply(e, await umaRaceManager.joinRace(e, e.msg), { kind: "umaRaceResult" })
    return true
  }

  async raceDecision(e) {
    const result = await umaRaceManager.raceDecision(e)
    if (result) await this.reply(e, result, { kind: "umaRaceResult" })
    return true
  }

  async runRace(e) {
    await this.reply(e, await umaRaceManager.runRace(e), { kind: "umaRaceResult" })
    return true
  }

  async cancelRace(e) {
    await this.reply(e, umaRaceManager.cancelRace(e))
    return true
  }

  async showScore(e) {
    await this.reply(e, umaRaceManager.showScore(e))
    return true
  }

  async adjustScore(e) {
    await this.reply(e, await umaRaceManager.adjustScore(e))
    return true
  }

  async showRank(e) {
    const match = String(e.msg || "").match(/\s+(\d+)\s*$/)
    await this.reply(e, umaRaceManager.showRank(match?.[1]), { kind: "ranking" })
    return true
  }
}
