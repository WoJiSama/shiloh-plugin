import {createUmaRacePlugin} from '../../../dist/backend/modules/games/infrastructure/uma/app.js'
import {umaRaceManager} from './UmaRaceManager.js'
import {sendSmartReply} from '../../../utils/SmartReply.js'
import {turtleSoupManager} from '../turtlesoup/app.js'

// 同群互斥:一个群同时只允许一个重度小游戏。赛马娘开赛前先让位给进行中的海龟汤。
const BaseUmaRacePlugin=createUmaRacePlugin(plugin,{umaRaceManager,sendSmartReply})
class MutexUmaRacePlugin extends BaseUmaRacePlugin {
  async startRace(e) {
    const session=turtleSoupManager.getSession(String(e?.group_id||""))
    if(session){
      await sendSmartReply(e,`本群有进行中的海龟汤(${session.phase==='playing'?'问答中':'报名中'}),先 .游戏 海龟汤 结束 它再开赛马`)
      return true
    }
    return await super.startRace(e)
  }
}
export const UmaRacePlugin=MutexUmaRacePlugin
