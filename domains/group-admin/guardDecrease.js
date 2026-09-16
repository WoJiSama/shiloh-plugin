import { groupGuardManager } from "./GroupGuardManager.js"

export class GroupGuardDecrease extends plugin {
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

  async handleGroupDecrease(e) {
    return await groupGuardManager.handleGroupDecrease(e)
  }
}
