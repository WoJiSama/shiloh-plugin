import type {AdminEvent,CorpusEntry} from '../../../contracts/groupAdmin.js'
type PluginBase=new(options:Record<string,unknown>)=>object
import type {GroupNoticeManager} from "./GroupNoticeManager.js"

export function createGroupNoticeDecrease(Plugin:PluginBase,groupNoticeManager:GroupNoticeManager){
return class GroupNoticeDecrease extends Plugin {
  constructor() {
    super({
      name: "群通知-退群提示",
      dsc: "成员退群后发送自定义提示",
      event: "notice.group.decrease",
      priority: 4900,
      rule: [
        {
          fnc: "handleGroupDecrease",
          log: false
        }
      ]
    })
  }

  async handleGroupDecrease(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
    return await groupNoticeManager.handleGroupDecrease(e)
  }
}

}
