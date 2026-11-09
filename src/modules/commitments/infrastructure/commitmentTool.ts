// 承诺账本运行时:CommitmentTool(create/list/cancel,主链路与仿真共用)+ commitmentTick(每秒到期兑现)。
// 设计原则见 contracts/commitments.ts 头注。静态直发出站必经 sanitizeFinalReplyText(RULES.md 红线)。
import {randomUUID} from 'node:crypto'
import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
import {sanitizeFinalReplyText} from '../../conversation/domain/replySanitizer.js'
import {createCommitmentStore} from './commitmentStore.js'
import {
  advanceCommitmentAfterRun,buildMissAdmissionText,buildRenewalAskText,checkCommitmentCaps,formatCommitmentLine,formatScheduleText,
  isCommitmentExpired,normalizeSchedule,renderCommitmentCard,renderRenewalCard,resolvedCommitmentConfig,shouldAskRenewal
} from '../domain/commitments.js'
import type {CommitmentData,CommitmentEvent,CommitmentPorts} from '../../../contracts/commitments.js'

function event(value:unknown):CommitmentEvent {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as CommitmentEvent:{}
}

export function createCommitmentRuntime(ports:CommitmentPorts) {
  const store=createCommitmentStore({redis:ports.redis,logger:ports.logger})
  const now=()=>ports.now?ports.now():Date.now()

  class CommitmentTool extends AbstractTool {
    constructor(){
      super()
      this.name='commitmentTool'
      this.description=[
        '把群友托付的定时/循环事务记进承诺账本，到期由机器人兑现。',
        '用户说"每天X点做Y""定时Z""每隔…发…"或要我按时间执行动作时调用；一次性提醒（"10分钟后提醒我"）也走本工具。',
        'intent 必须保留用户原话（含时间语境），不要改写；时间信息缺失时先追问，不要编。'
      ].join('')
      this.skill={
        name:'commitmentTool',
        purpose:'把群友托付的定时/循环事务记进承诺账本，到期兑现。',
        whenToUse:'用户表达"到某个时间点/每天某时要做某事"且执行者是我（发消息、查东西、提醒、每日定点任务）时。',
        boundaries:'只接时间明确的托付，时间缺失先追问。deliver=static 仅限固定文字；要查数据/调工具的活必须 deliver=agent（需该群开仿真）。非定时请求、纯提醒类一次性闹钟也走本工具（once）。群成员都可创建，创建人和群管理可取消/续期。',
        instructions:[
          'schedule_kind: 循环=daily（schedule_time 填 HH:mm 24小时制）；一次性=once（schedule_time 填 ISO 8601 带 +08:00，按当前北京时间换算）。',
          'intent 保留用户原话，如"每天中午12点在群里发三角洲今日密码"。',
          'deliver: 默认 agent（到点我自己完成）；只有用户要发的就是一句固定文字时才 static 并把原文放 static_message。',
          '创建成功后向用户轻确认一句（什么时候会做什么），不要念参数。',
          '续期：承诺到期前几天系统会提醒你问创建人还续不续；对方说"续/继续/还要"就调 renew（commitment_id 用 list 查），回一句"好，继续给你记着"即可。'
        ].join('\n')
      }
      this.parameters={
        type:'object',
        properties:{
          action:{type:'string',enum:['create','list','cancel','renew'],description:'create 创建承诺；list 查看当前群承诺；cancel 取消（commitment_id 填 list 里的短 id）；renew 续期（创建人说"续"时用）'},
          intent:{type:'string',description:'用户托付的原话（含时间语境），如"每天中午12点在群里发三角洲今日密码"。create 必填'},
          schedule_kind:{type:'string',enum:['once','daily'],description:'once=一次性；daily=每天循环'},
          schedule_time:{type:'string',description:'once 填 ISO 8601 带 +08:00（如 2026-11-10T12:00:00+08:00）；daily 填 HH:mm（如 12:00）'},
          deliver:{type:'string',enum:['agent','static'],description:'agent=到点我自己动手完成（默认）；static=到点直接发固定文字'},
          static_message:{type:'string',description:'deliver=static 时必填：到点要发的原文'},
          commitment_id:{type:'string',description:'cancel/renew 时填 list 结果里的短 id'}
        },
        required:['action'],
        additionalProperties:false
      }
    }

    async func(opts:Record<string,unknown>,e:unknown){
      const ev=event(e)
      const action=String(opts.action||'').trim()
      if(action==='create')return await create(opts,ev)
      if(action==='list')return await list(ev)
      if(action==='cancel')return await cancel(opts,ev)
      if(action==='renew')return await renew(opts,ev)
      return `未知操作：${action||'(空)'}（可用 create/list/cancel/renew）`
    }
  }

  async function create(opts:Record<string,unknown>,ev:CommitmentEvent){
    const groupId=String(ev.group_id||'')
    const creatorId=String(ev.user_id||'')
    if(!groupId)return '承诺只能在群里创建（私聊没有群的上下文）'
    if(!creatorId)return 'error: 缺少创建人身份'
    const intent=String(opts.intent||'').trim()
    if(!intent)return '托付内容是空的——要记什么事？请把用户原话放 intent'

    const cfg=resolvedCommitmentConfig(ports.loadConfig())
    const active=await store.listActiveCommitments()
    const capError=checkCommitmentCaps(active,groupId,creatorId,cfg)
    if(capError)return capError

    const deliver=opts.deliver==='static'?'static':'agent'
    if(deliver==='agent'){
      const simGroup=await ports.isSimulationGroup(groupId)
      if(!simGroup)return '这个群没开仿真模式，到点需要我自己动手的活干不了；固定文字的定时发送可以（deliver=static 并给 static_message）'
    }
    const staticMessage=deliver==='static'?String(opts.static_message||'').trim():''
    if(deliver==='static'&&!staticMessage)return 'deliver=static 需要 static_message（到点要发的固定文字）'

    const at=now()
    const normalized=normalizeSchedule(opts.schedule_kind,opts.schedule_time,at)
    if('error'in normalized)return normalized.error

    const botId=String((ports.getBot()?.uin)||'')
    const commitment:CommitmentData={
      id:`cmt_${at}_${creatorId}_${randomUUID().slice(0,6)}`,
      group_id:groupId,creator_id:creatorId,
      creator_name:String(ev.sender?.card||ev.sender?.nickname||creatorId),
      intent:intent.slice(0,200),
      schedule:normalized.schedule,deliver,
      static_message:staticMessage||null,
      expiry_at:at+cfg.defaultExpiryDays*86400_000,
      next_run_at:normalized.nextRunAt,status:'active',
      last_run_at:0,last_result:'',retry_count:0,created_at:at,bot_id:botId
    }
    await store.createCommitment(commitment)
    ports.logger.info(`[承诺] 群 ${groupId} 用户 ${creatorId} 创建 ${commitment.schedule.kind}「${intent.slice(0,40)}」下次 ${formatScheduleText(commitment.schedule)}`)
    const deliverNote=deliver==='agent'?'到点我来办':'到点会原样发出来'
    return `已记下：「${intent}」——${formatScheduleText(commitment.schedule)}，${deliverNote}（${cfg.defaultExpiryDays} 天后到期会再确认要不要续）。跟用户轻确认一句就行，别念参数。`
  }

  async function list(ev:CommitmentEvent){
    const groupId=String(ev.group_id||'')
    if(!groupId)return '承诺是群维度的，请在群里查'
    const userId=String(ev.user_id||'')
    const active=(await store.listActiveCommitments()).filter(c=>c.group_id===groupId)
    const visible=ev.isMaster===true?active:active.filter(c=>c.creator_id===userId)
    if(!visible.length)return ev.isMaster===true?'这个群目前没有任何定时托付':'你名下目前没有定时托付（群主/管理可看全部）'
    const at=now()
    return [`当前群的定时托付（取消用 commitment_id）：`,...visible.map(c=>formatCommitmentLine(c,at))].join('\n')
  }

  async function cancel(opts:Record<string,unknown>,ev:CommitmentEvent){
    const groupId=String(ev.group_id||'')
    const shortId=String(opts.commitment_id||'').trim()
    if(!shortId)return '要取消哪个？先 list 看短 id'
    const active=(await store.listActiveCommitments()).filter(c=>c.group_id===groupId)
    const matches=active.filter(c=>c.id.includes(shortId))
    if(!matches.length)return `没找到 id 含「${shortId}」的托付，先 list 确认`
    if(matches.length>1)return `「${shortId}」匹配到 ${matches.length} 条，把 id 抄全一点`
    const target=matches[0]!
    const userId=String(ev.user_id||'')
    if(target.creator_id!==userId&&ev.isMaster!==true)return '只能取消自己创建的托付（群主/管理可取消任何人的）'
    await store.cancelCommitment(target.id)
    ports.logger.info(`[承诺] 群 ${groupId} 取消 ${target.id}「${target.intent.slice(0,40)}」`)
    return `已取消：「${target.intent.slice(0,60)}」（${formatScheduleText(target.schedule)}）`
  }

  /** 续期:到期前问询后创建人说"续"→ 顺延一个默认周期,重置问询标记 */
  async function renew(opts:Record<string,unknown>,ev:CommitmentEvent){
    const groupId=String(ev.group_id||'')
    const shortId=String(opts.commitment_id||'').trim()
    if(!shortId)return '要续哪个？先 list 看短 id'
    const active=(await store.listActiveCommitments()).filter(c=>c.group_id===groupId)
    const matches=active.filter(c=>c.id.includes(shortId))
    if(!matches.length)return `没找到 id 含「${shortId}」的托付（可能已结束或已到期），先 list 确认`
    if(matches.length>1)return `「${shortId}」匹配到 ${matches.length} 条，把 id 抄全一点`
    const target=matches[0]!
    const userId=String(ev.user_id||'')
    if(target.creator_id!==userId&&ev.isMaster!==true)return '只能续自己创建的托付（群主/管理可续任何人的）'
    const cfg=resolvedCommitmentConfig(ports.loadConfig())
    const at=now()
    const updated={...target,expiry_at:at+cfg.defaultExpiryDays*86400_000,renewal_asked_at:0}
    await store.commitRunOutcome(updated)
    ports.logger.info(`[承诺] 群 ${groupId} 续期 ${target.id}「${target.intent.slice(0,40)}」至 ${cfg.defaultExpiryDays} 天后`)
    return `已续期：「${target.intent.slice(0,60)}」再跑 ${cfg.defaultExpiryDays} 天（到期前会再问一次）。轻确认一句就行，别念参数。`
  }

  /** 群内通知(失约明说/续约问询):static 直发出站红线——先 sanitize 再发;失败只记日志 */
  async function sendGroupNotice(c:CommitmentData,text:string){
    try{
      const Bot=ports.getBot(c.bot_id||undefined)||ports.getBot()
      if(!Bot?.sendApi)throw new Error('机器人未连接')
      const safe=sanitizeFinalReplyText(text)
      await Bot.sendApi('send_group_msg',{
        group_id:Number(c.group_id),
        message:[
          {type:'at',data:{qq:c.creator_id}},
          {type:'text',data:{text:` ${safe}`}}
        ]
      })
    }catch(error){
      ports.logger.warn(`[承诺] 群 ${c.group_id} 通知发送失败(明说/续约未送达,哨兵会看到失败日志): ${error instanceof Error?error.message:String(error)}`)
    }
  }

  /** 终态失败收口:记 faillog(哨兵告警)+ 失约明说(失败可见比失约本身伤信任得多) */
  async function finalizeFailure(c:CommitmentData,reason:string,at:number){
    await store.appendFailLog({id:c.id,intent:c.intent,group_id:c.group_id,reason:reason.slice(0,80),at}).catch(()=>{})
    await sendGroupNotice(c,buildMissAdmissionText(c,reason))
  }

  /** 续约问询扫描(10 分钟一拍,闭内冷却):到期前 3 天问一次,只问一次 */
  let nextRenewalScanAt=0
  async function maybeAskRenewals(){
    const at=now()
    if(at<nextRenewalScanAt)return
    nextRenewalScanAt=at+10*60_000
    const active=await store.listActiveCommitments()
    for(const c of active){
      if(!shouldAskRenewal(c,at))continue
      try{
        if(c.deliver==='agent'&&await ports.isSimulationGroup(c.group_id)){
          await ports.wakeSim(c.group_id,renderRenewalCard(c,at))
        }else{
          await sendGroupNotice(c,buildRenewalAskText(c,at))
        }
        await store.commitRunOutcome({...c,renewal_asked_at:at})
        ports.logger.info(`[承诺] ${c.id}「${c.intent.slice(0,40)}」续约问询已发出`)
      }catch(error){
        ports.logger.warn(`[承诺] ${c.id} 续约问询失败(下轮扫描重试): ${error instanceof Error?error.message:String(error)}`)
      }
    }
  }

  /**
   * 到期兑现:static 直发(经 sanitize);agent 唤醒仿真群回合。daily 立即顺延防双发;
   * 失败 +10s 重试至 3 次,终态 failed 时失约明说+记 faillog(哨兵告警)。
   * 续约问询扫描同拍运行(10 分钟冷却),到期前 3 天问创建人一次。
   */
  async function commitmentTick(){
    await maybeAskRenewals().catch(()=>{})
    const at=now()
    const due=await store.takeDueCommitments(at)
    if(!due.length)return
    for(const c of due){
      try{
        if(c.status!=='active')continue
        if(isCommitmentExpired(c,at)){
          await store.commitRunOutcome({...c,status:'expired',last_result:'已到期'})
          ports.logger.info(`[承诺] ${c.id}「${c.intent.slice(0,40)}」到期收档`)
          continue
        }
        if(c.deliver==='agent'){
          const simGroup=await ports.isSimulationGroup(c.group_id)
          if(!simGroup){
            await store.commitRunOutcome({...c,status:'failed',last_run_at:at,last_result:'群未开仿真,无法兑现'})
            await finalizeFailure(c,'群没开仿真模式，到点干不了活',at)
            continue
          }
          await ports.wakeSim(c.group_id,renderCommitmentCard(c))
          const advanced=advanceCommitmentAfterRun(c,at)
          await store.commitRunOutcome({...c,last_run_at:at,retry_count:0,last_result:'dispatched',next_run_at:advanced.nextRunAt??0,status:advanced.status})
          ports.logger.info(`[承诺] ${c.id} 已唤醒仿真群 ${c.group_id} 兑现「${c.intent.slice(0,40)}」`)
          continue
        }
        // static 直发:出站红线,先 sanitize 再出机
        const Bot=ports.getBot(c.bot_id||undefined)||ports.getBot()
        if(!Bot?.sendApi)throw new Error('机器人未连接')
        const text=sanitizeFinalReplyText(String(c.static_message||c.intent))
        await Bot.sendApi('send_group_msg',{
          group_id:Number(c.group_id),
          message:[
            {type:'at',data:{qq:c.creator_id}},
            {type:'text',data:{text:` ${text}`}}
          ]
        })
        const advanced=advanceCommitmentAfterRun(c,at)
        await store.commitRunOutcome({...c,last_run_at:at,retry_count:0,last_result:'sent',next_run_at:advanced.nextRunAt??0,status:advanced.status})
        ports.logger.info(`[承诺] ${c.id} 静态兑现到群 ${c.group_id}「${c.intent.slice(0,40)}」`)
      }catch(error){
        const reason=String(error instanceof Error?error.message:error).slice(0,80)
        ports.logger.error(`[承诺] 兑现 ${c.id} 失败:`,error)
        const outcome=await store.requeueForRetry({...c,last_result:reason},at).catch(()=>'retrying' as const)
        if(outcome==='failed')await finalizeFailure(c,reason,at)
      }
    }
  }

  return {CommitmentTool,commitmentTick,store}
}
