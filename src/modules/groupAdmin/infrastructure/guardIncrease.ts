import type {AdminEvent,CorpusEntry} from '../../../contracts/groupAdmin.js'
type PluginBase=new(options:Record<string,unknown>)=>object
import type {GroupGuardManager} from "./GroupGuardManager.js"

export function createGroupGuardIncrease(Plugin:PluginBase,groupGuardManager:GroupGuardManager){
return class GroupGuardIncrease extends Plugin {
  constructor() {
    super({
      name: "群管理-入群验证",
      dsc: "新成员入群后发送十以内加减法验证",
      event: "notice.group.increase",
      priority: 5000,
      rule: [
        {
          fnc: "handleGroupIncrease",
          log: false
        }
      ]
    })
  }

  async handleGroupIncrease(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
    return await groupGuardManager.handleGroupIncrease(e)
  }
}

}
