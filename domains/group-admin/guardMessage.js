import { groupGuardManager } from "./GroupGuardManager.js"

export class GroupGuardMessage extends plugin {
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

  async handleVerifyMessage(e) {
    return await groupGuardManager.handleMessage(e)
  }
}
