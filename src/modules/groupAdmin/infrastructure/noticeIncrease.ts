import type {AdminEvent,CorpusEntry} from '../../../contracts/groupAdmin.js'
type PluginBase=new(options:Record<string,unknown>)=>object
import type {GroupNoticeManager} from "./GroupNoticeManager.js"

export function createGroupNoticeIncrease(Plugin:PluginBase,groupNoticeManager:GroupNoticeManager){
return class GroupNoticeIncrease extends Plugin {
  constructor() {
    super({
      name: "群通知-入群欢迎",
      dsc: "新成员入群后发送自定义欢迎语",
      event: "notice.group.increase",
      priority: 4900,
      rule: [
        {
          fnc: "handleGroupIncrease",
          log: false
        }
      ]
    })
  }

  async handleGroupIncrease(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
    return await groupNoticeManager.handleGroupIncrease(e)
  }
}

}
