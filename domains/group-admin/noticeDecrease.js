import { groupNoticeManager } from "./GroupNoticeManager.js"

export class GroupNoticeDecrease extends plugin {
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

  async handleGroupDecrease(e) {
    return await groupNoticeManager.handleGroupDecrease(e)
  }
}
