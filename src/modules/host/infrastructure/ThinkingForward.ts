import type {ThinkingCommandEvent} from '../../config/infrastructure/thinkingForwardSettings.js'
import type {HostPluginBase} from './hostMessageTypes.js'

export function createThinkingForwardPlugin(Plugin:HostPluginBase,handleThinkingForwardCommand:(event:ThinkingCommandEvent)=>Promise<unknown>){
return class ThinkingForwardPlugin extends Plugin {
  constructor() {
    super({
      name: '思考过程转发',
      dsc: '按群管理模型返回的思考内容转发',
      event: 'message',
      priority: 500,
      rule: [{ reg: '^#(?:思考过程\\s*(?:开启|关闭|状态)|(?:开启|关闭)思考过程)\\s*$', fnc: 'handleCommand' }]
    })
  }

  async handleCommand(event:ThinkingCommandEvent) {
    return handleThinkingForwardCommand(event)
  }
}

}
