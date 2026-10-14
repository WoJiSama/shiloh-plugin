import type { QqToolEvent, QqToolBot, QqToolGroup, QqMember, QqToolPorts, PbObject, PbValue } from '../../../contracts/qqTools.js'
import { apiOk, asRecord, errorText, eventBot } from './qqToolRuntime.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js';

/**
 * 戳一戳工具类，用于对群聊中的用户进行戳一戳操作
 * 适配napcat-onebotv11版本
 */
export function createPokeTool(ports: QqToolPorts) {
class PokeTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'pokeTool';
    this.description = '对群聊中的用户进行戳一戳，戳的操作，进行戳一戳或者戳时请调用此工具';
    this.parameters = {
      type: 'object',
      required: [],
      properties: {
        target: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: '目标用户的QQ号（如 "1245934"）或群名片/昵称（如 "叶杨"）数组，支持单个或多个用户。每个元素只能是QQ号或名称，不能混合格式（如 "叶杨(QQ号:1245934)" 无效）。'
        },        
        times: {
          type: 'number',
          description: '每个目标的戳一戳次数，默认 1 次，最大 10 次',
          default: 1,
          maximum: 10
        },
        random: {
          type: 'boolean',
          description: '是否随机选择群成员进行戳一戳，默认为 true。启用时忽略 target 参数',
          default: false
        }
      }
    };
  }


  async callApi(bot: QqToolBot, action: string, params: Record<string, unknown> = {}) {
    return bot.sendApi(action, params)
  }
  async getGroupMemberList(groupId: string|number, bot: QqToolBot) {
    const response = asRecord(await this.callApi(bot,'get_group_member_list',{group_id:groupId}))
    if (!apiOk(response) || !Array.isArray(response.data)) throw new Error('获取群成员列表失败')
    const members: QqMember[]=[]
    for (const item of response.data) {
      const r=asRecord(item), id=Number(r.user_id)
      if (!Number.isSafeInteger(id)||id<=0) continue
      members.push({user_id:id,card:String(r.card??''),nickname:String(r.nickname??'')})
    }
    return members
  }
  async sendGroupPoke(groupId: string|number,userId: number,bot: QqToolBot) {
    // A timeout does not prove non-delivery; never switch to another send API.
    const response=await this.callApi(bot,'send_group_poke',{group_id:groupId,user_id:userId})
    if (!apiOk(response)) throw new Error('戳一戳响应未确认成功，请勿重复执行')
    return true
  }
  findMember(target:string,members:QqMember[]) {
    if (/^\d+$/.test(target)) return members.find(m=>m.user_id===Number(target))
    const query=target.trim().toLowerCase()
    if (!query) return undefined
    return members.find(m=>[m.card,m.nickname].some(n=>n?.toLowerCase()===query)) ?? members.find(m=>[m.card,m.nickname].some(n=>n?.toLowerCase().includes(query)))
  }
  async pokeSingleUser(groupId:string|number,target:string,members:QqMember[],pokeCount:number,bot:QqToolBot) {
    const member=this.findMember(target,members)
    if(!member)return {target,success:false,error:`未找到用户 ${target}`}
    let count=0
    try {
      for(let i=0;i<pokeCount;i++) {
        await this.sendGroupPoke(groupId,member.user_id,bot)
        count++
        if(i<pokeCount-1)await new Promise(resolve=>setTimeout(resolve,1500))
      }
      return {target,targetQQ:member.user_id,targetName:member.card||member.nickname,times:count,requestedTimes:pokeCount,success:true}
    } catch(error) {
      return {target,targetQQ:member.user_id,targetName:member.card||member.nickname,times:count,requestedTimes:pokeCount,success:false,error:`投递未确认，已停止后续发送：${errorText(error)}`}
    }
  }
  async func(opts:Record<string,unknown>,e:QqToolEvent) {
    const groupId=e.group_id
    if(!groupId)return '此功能仅支持群聊使用'
    try {
      const bot=eventBot(e,ports),members=await this.getGroupMemberList(groupId,bot)
      const pokeCount=typeof opts.times==='number'&&Number.isFinite(opts.times)?Math.min(Math.max(1,Math.floor(opts.times)),10):1
      let targets=typeof opts.target==='string'?[opts.target]:Array.isArray(opts.target)?opts.target.filter((v):v is string=>typeof v==='string'):[]
      if(!targets.length||opts.random===true) {
        const available=members.filter(m=>m.user_id!==bot.uin&&String(m.user_id)!==String(e.user_id??e.sender?.user_id))
        const chosen=available[Math.floor(Math.random()*available.length)]
        if(!chosen)return '群内没有可戳的成员'
        targets=[String(chosen.user_id)]
      }
      const results=await Promise.all(targets.map(t=>this.pokeSingleUser(groupId,t,members,pokeCount,bot)))
      const success=results.filter(r=>r.success),failed=results.filter(r=>!r.success)
      return {action:'poke',success:{count:success.length,targets:success.map(r=>({target:r.target,qq:r.targetQQ,name:r.targetName,times:r.times}))},errors:failed.map(r=>({target:r.target,error:r.error}))}
    } catch(error){return `戳一戳操作失败: ${errorText(error)}`}
  }
}
return {PokeTool}
}
