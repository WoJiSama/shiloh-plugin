import { explainCompiledPluginUpdate } from "./pluginUpdateBuild.js"

interface AdminEvent {msg?:string;isMaster?:boolean;reply(message:string):Promise<unknown>}
type PluginBase=new(options:{name:string;dsc:string;event:string;priority:number;rule:{reg:string|RegExp;fnc:string;permission:string}[]})=>{e:AdminEvent}
export function createBlChatUpdate(plugin:PluginBase){
class BlChatUpdate extends plugin {
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

  async update(e:AdminEvent = this.e) {
    return explainCompiledPluginUpdate(e)
  }
}

return BlChatUpdate
}
