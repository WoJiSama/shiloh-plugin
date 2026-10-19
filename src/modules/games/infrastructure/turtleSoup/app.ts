import type {TurtleSoupEvent} from '../../../../contracts/turtleSoup.js'
type AppEvent=TurtleSoupEvent & {reply(message:unknown):Promise<unknown>}
import type {MediaPluginConstructor} from '../../../../contracts/mediaCards.js'
import type {createSmartReply} from '../../../conversation/application/smartReply.js'
import type {TurtleSoupManager} from './TurtleSoupManager.js'
type ReplySender=ReturnType<typeof createSmartReply>['sendSmartReply']
export function createTurtleSoupPlugin(plugin:MediaPluginConstructor, ports:{turtleSoupManager:TurtleSoupManager;sendSmartReply:ReplySender}){
const {turtleSoupManager,sendSmartReply}=ports
class TurtleSoupPlugin extends plugin {
  constructor() {
    super({
      name: "海龟汤小游戏",
      dsc: "群聊海龟汤推理:AI主持问答、猜汤底、MVP评选与题库自动生成",
      event: "message",
      priority: 600,
      rule: [
        { reg: "^[.。]游戏\\s*$", fnc: "showHub" },
        { reg: "^[.。]游戏\\s*(帮助|help)\\s*$", fnc: "showHub" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*$", fnc: "showHelp" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(帮助|help|玩法)\\s*$", fnc: "showHelp" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(开局|开一局)\\s*$", fnc: "openGame" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(加入|报名|参加)\\s*$", fnc: "joinGame" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(开始|出题)\\s*$", fnc: "startGame" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*选\\s*(?:随机|1|2|3|一|二|三)?\\s*$", fnc: "choosePuzzle" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(取消|取消报名|取消开局)\\s*$", fnc: "cancelGame" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(猜|猜汤底|答案)[\\s\\S]+$", fnc: "guessSoup" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(提示|线索)\\s*$", fnc: "useHint" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(投降|认输)\\s*$", fnc: "surrender" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*换汤(?:\\s+[\\s\\S]*)?\\s*$", fnc: "switchPuzzleCmd" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(排行|榜单|汤榜)\\s*$", fnc: "rankingsCmd" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(状态|进度)\\s*$", fnc: "showStatus" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(结束|终止|收局)\\s*$", fnc: "endGame" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*评分\\s+(?:(?:上一局|pl_[\\w-]+)\\s+)?[1-5](\\s+[\\s\\S]*)?\\s*$", fnc: "rateGame" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*(库存|题库)\\s*$", fnc: "inventory" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*生成(\\s+\\d+)?\\s*$", fnc: "generateMore" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*待审\\s*$", fnc: "listPendingCmd" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*过审\\s+\\S+\\s*$", fnc: "approvePuzzleCmd" },
        { reg: "^[.。]游戏\\s+海龟汤\\s*淘汰\\s+\\S+\\s*$", fnc: "rejectPuzzleCmd" },
        { reg: "^[\\s\\S]*$", fnc: "handleChat", log: false }
      ]
    })
  }

  async reply(e:AppEvent, output:unknown, options:Parameters<ReplySender>[2] = {}) {
    return await sendSmartReply(e, output, options)
  }

  async showHub(e:AppEvent) {
    await this.reply(e, turtleSoupManager.showHub())
    return true
  }

  async showHelp(e:AppEvent) {
    await this.reply(e, turtleSoupManager.showHelp(), { kind: "diceLong" })
    return true
  }

  async openGame(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.openGame(e))
    return true
  }

  async joinGame(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.joinGame(e))
    return true
  }

  async startGame(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.startGame(e), { kind: "diceLong" })
    return true
  }

  async choosePuzzle(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.choosePuzzle(e), { kind: "diceLong" })
    return true
  }

  async cancelGame(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.cancelGame(e))
    return true
  }

  async guessSoup(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.guessSoup(e))
    return true
  }

  async surrender(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.surrender(e), { kind: "diceLong" })
    return true
  }

  async useHint(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.useHint(e))
    return true
  }

  async showStatus(e:AppEvent) {
    await this.reply(e, turtleSoupManager.showStatus(e))
    return true
  }

  async endGame(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.endGame(e), { kind: "diceLong" })
    return true
  }

  async rateGame(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.rateGame(e))
    return true
  }

  async inventory(e:AppEvent) {
    await this.reply(e, turtleSoupManager.inventory(e))
    return true
  }

  async generateMore(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.generateMore(e))
    return true
  }

  async switchPuzzleCmd(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.switchPuzzle(e))
    return true
  }

  async rankingsCmd(e:AppEvent) {
    await this.reply(e, turtleSoupManager.rankings())
    return true
  }

  async listPendingCmd(e:AppEvent) {
    await this.reply(e, turtleSoupManager.listPending(e))
    return true
  }

  async approvePuzzleCmd(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.reviewPuzzle(e, 'approve'))
    return true
  }

  async rejectPuzzleCmd(e:AppEvent) {
    await this.reply(e, await turtleSoupManager.reviewPuzzle(e, 'reject'))
    return true
  }

  // 问答期兜底:有进行中的局且是参与者提问时接管消息,其余情况放行给后续插件。
  // 回答引用玩家的提问;每N次提问额外发一张进度卡面(长结构文本自动渲染成图,不引用)。
  async handleChat(e:AppEvent) {
    if (!e?.group_id) return false
    const output = await turtleSoupManager.handleChat(e)
    if (output === null) return false
    await this.reply(e, output.reply, { quote: true })
    if (output.recap) await this.reply(e, output.recap, { kind: "diceLong" })
    return true
  }
}

return TurtleSoupPlugin
}
