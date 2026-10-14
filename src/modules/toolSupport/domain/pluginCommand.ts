export async function isPluginCommand(msg:string,botName:string):Promise<false|undefined>{
 if((msg.startsWith('/')||msg.startsWith('#'))&&!msg.startsWith(botName)){console.log('检测到其他插件指令');return false}
}
