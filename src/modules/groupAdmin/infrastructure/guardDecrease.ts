import type {AdminEvent,CorpusEntry} from '../../../contracts/groupAdmin.js'
type PluginBase=new(options:Record<string,unknown>)=>object
import type {GroupGuardManager} from "./GroupGuardManager.js"

export function createGroupGuardDecrease(Plugin:PluginBase,groupGuardManager:GroupGuardManager){
return class GroupGuardDecrease extends Plugin {
  constructor() {
    super({
      name: "群管理-验证清理",
      dsc: "成员退群后清理入群验证状态",
      event: "notice.group.decrease",
      priority: 5000,
      rule: [
        {
          fnc: "handleGroupDecrease",
          log: false
        }
      ]
    })
  }

  async handleGroupDecrease(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
    return await groupGuardManager.handleGroupDecrease(e)
  }
}

}
