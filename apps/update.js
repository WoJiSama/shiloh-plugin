import { update as Update } from "../../other/update.js"

export class BlChatUpdate extends plugin {
  constructor() {
    super({
      name: "shiloh-plugin更新（#希洛更新/#shiloh更新）",
      dsc: "#bl更新 #bl强制更新 #对话插件更新 #对话插件强制更新",
      event: "message",
      priority: 1000,
      rule: [
        { reg: /^#?(shiloh|SHILOH|希洛|bl|BL|对话插件)(强制)?更新$/, fnc: "update", permission: "master" }
      ]
    })
  }

  async update(e = this.e) {
    e.isMaster = true
    e.msg = `#${e.msg.includes("强制") ? "强制" : ""}更新shiloh-plugin`
    const up = new Update(e)
    up.e = e
    return up.update()
  }
}
