import type {MediaPluginConstructor} from '../../../contracts/mediaCards.js'
export function createDiceLogRecorder(plugin:MediaPluginConstructor,ports:{recordLogMessage(event:unknown):Promise<unknown>;warn(message:string):void}){
 return class DiceLogRecorder extends plugin {
 constructor(){super({name:'COC骰娘-log记录',dsc:'跑团 log 开启时后台记录群消息',event:'message.group',priority:10045,rule:[{reg:'.*',fnc:'recordDiceLog',log:false}]})}
 async recordDiceLog(event:unknown){void ports.recordLogMessage(event).catch(error=>ports.warn(`[骰娘] log 记录失败: ${error instanceof Error?error.message:String(error)}`));return false}
 }
}
