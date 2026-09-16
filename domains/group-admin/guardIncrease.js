import { groupGuardManager } from "./GroupGuardManager.js"

export class GroupGuardIncrease extends plugin {
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

  async handleGroupIncrease(e) {
    return await groupGuardManager.handleGroupIncrease(e)
  }
}
