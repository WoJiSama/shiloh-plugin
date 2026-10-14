import type {AdminEvent,CorpusEntry} from '../../../contracts/groupAdmin.js'
type PluginBase=new(options:Record<string,unknown>)=>object
import type {GroupGuardManager} from "./GroupGuardManager.js"

export function createGroupGuardMessage(Plugin:PluginBase,groupGuardManager:GroupGuardManager){
return class GroupGuardMessage extends Plugin {
  constructor() {
    super({
      name: "群管理-验证答案",
      dsc: "处理入群验证答案",
      event: "message",
      priority: 10000,
      rule: [
        {
          reg: ".*",
          fnc: "handleVerifyMessage",
          log: false
        }
      ]
    })
  }

  async handleVerifyMessage(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
    return await groupGuardManager.handleMessage(e)
  }
}

}
