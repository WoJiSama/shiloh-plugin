import { groupNoticeManager } from "./GroupNoticeManager.js"

export class GroupNoticeIncrease extends plugin {
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

  async handleGroupIncrease(e) {
    return await groupNoticeManager.handleGroupIncrease(e)
  }
}
