// 委托记忆工具:remember/recall/list/forget。主链路(规划器路由)与仿真(白名单)共用。
// 原文锚定原则:content 存用户原话,召回时原样引用,模型只许念不许改写——防重构记忆导致的信任事故。
import {randomUUID} from 'node:crypto'
import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
import {createDelegatedMemoryStore} from './delegatedMemoryStore.js'
import {checkDelegatedCaps,formatDelegatedLine,resolvedDelegatedConfig,scoreDelegatedMatch} from '../domain/delegatedMemory.js'
import {parseOnceTime} from '../../commitments/domain/commitments.js'
import type {DelegatedMemoryEntry,DelegatedMemoryPorts} from '../../../contracts/delegatedMemory.js'

interface DelegatedEvent {
  group_id?:string|number|undefined
  user_id?:string|number|undefined
  isMaster?:boolean|undefined
  sender?:{nickname?:string|undefined;card?:string|undefined}|undefined
}

function event(value:unknown):DelegatedEvent {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as DelegatedEvent:{}
}

export function createDelegateMemoryRuntime(ports:DelegatedMemoryPorts) {
  const store=createDelegatedMemoryStore(ports)
  const now=()=>ports.now?ports.now():Date.now()

  class DelegateMemoryTool extends AbstractTool {
    constructor(){
      super()
      this.name='delegateMemoryTool'
      this.description=[
        '替群友记住托付的事，之后随时能原文背出来。',
        '用户说"帮我记住X""别忘了X""我跟你说过X吧""记住我的是X"时调用 remember；',
        '用户问"我上次让你记的啥""我跟你说过的那个X"时调用 recall；查看用 list、删除用 forget。'
      ].join('')
      this.skill={
        name:'delegateMemoryTool',
        purpose:'替群友记事/查事/忘事——机器人的"托付记忆"。',
        whenToUse:'用户明确让你记住某事、问起之前托付过的事、或要求忘掉某条托付时。',
        boundaries:'只记用户明确托付的事，闲聊中的信息不要自作主张记。content 必须是用户原话或含时间语境的忠实转述，禁止润色改写。记不得就直说，绝不编造。',
        instructions:[
          'remember: content 放用户原话（含"周五""下个月"这类时间词），due_time 仅当用户给了明确时间点时填 ISO 8601 带 +08:00。',
          'recall: query 放用户问的那个事的关键词（如"报告""我说的那个地名"），返回的是原文，回答时原样引用。',
          'forget: memory_id 填 list 结果里的短 id；只能删托付人自己的（群主可删任何人的）。',
          '记成功后像真人一样轻应一声（"行，记着了"），别报参数。'
        ].join('\n')
      }
      this.parameters={
        type:'object',
        properties:{
          action:{type:'string',enum:['remember','recall','list','forget'],description:'remember 记住；recall 查之前记的；list 列出；forget 忘掉一条'},
          content:{type:'string',description:'remember 必填：用户托付的原话（含时间语境），不要改写润色'},
          due_time:{type:'string',description:'可选：明确的时间点（ISO 8601 带 +08:00），到点机器人会自然提起'},
          query:{type:'string',description:'recall 必填：要找的那件事的关键词'},
          memory_id:{type:'string',description:'forget 必填：list 结果里的短 id'}
        },
        required:['action'],
        additionalProperties:false
      }
    }

    async func(opts:Record<string,unknown>,e:unknown){
      const ev=event(e)
      const action=String(opts.action||'').trim()
      if(action==='remember')return await remember(opts,ev)
      if(action==='recall')return await recall(opts,ev)
      if(action==='list')return await list(ev)
      if(action==='forget')return await forget(opts,ev)
      return `未知操作：${action||'(空)'}（可用 remember/recall/list/forget）`
    }
  }

  async function remember(opts:Record<string,unknown>,ev:DelegatedEvent){
    const groupId=String(ev.group_id||'')
    const ownerId=String(ev.user_id||'')
    if(!groupId)return '托付记忆是群维度的，请在群里说'
    if(!ownerId)return 'error: 缺少托付人身份'
    const content=String(opts.content||'').trim()
    if(!content)return '要记什么事？把用户托付的原话放 content'
    const cfg=resolvedDelegatedConfig(ports.loadConfig())
    const entries=await store.load(groupId)
    const capError=checkDelegatedCaps(entries,ownerId,cfg)
    if(capError)return capError
    const dueAt=String(opts.due_time||'').trim()?Number(parseOnceTime(opts.due_time)||0):0
    const entry:DelegatedMemoryEntry={
      id:`dlg_${now()}_${ownerId}_${randomUUID().slice(0,6)}`,
      owner:ownerId,ownerName:String(ev.sender?.card||ev.sender?.nickname||ownerId),
      content:content.slice(0,300),dueAt,status:'active',
      createdAt:now(),updatedAt:now()
    }
    await store.save(groupId,[...entries,entry])
    ports.logger.info(`[委托记忆] 群 ${groupId} 用户 ${ownerId} 托付「${content.slice(0,40)}」`)
    return `记下了：「${content.slice(0,80)}」${dueAt?'（到点会自然提起）':''}。轻应一声就行，别报参数。`
  }

  async function recall(opts:Record<string,unknown>,ev:DelegatedEvent){
    const groupId=String(ev.group_id||'')
    if(!groupId)return '请在群里问'
    const query=String(opts.query||'').trim()
    if(!query)return '要找哪件事？把用户问的关键词放 query（或用 list 全量看）'
    const at=now()
    const entries=(await store.load(groupId)).filter(e=>e.status==='active')
    if(!entries.length)return '这个群目前没人托付我记过事'
    const scored=entries.map(e=>({e,score:scoreDelegatedMatch(e,query)})).filter(x=>x.score>0)
      .sort((a,b)=>b.score-a.score||b.e.createdAt-a.e.createdAt).slice(0,5)
    if(!scored.length)return `没记住过和「${query.slice(0,30)}」相关的事——不确定的事直说记岔了/没记过，别编`
    return ['以下是托付的原话（回答时原样引用，不许改写）：',...scored.map(x=>formatDelegatedLine(x.e,at))].join('\n')
  }

  async function list(ev:DelegatedEvent){
    const groupId=String(ev.group_id||'')
    if(!groupId)return '请在群里查'
    const ownerId=String(ev.user_id||'')
    const at=now()
    const entries=(await store.load(groupId)).filter(e=>e.status==='active')
    const visible=ev.isMaster===true?entries:entries.filter(e=>e.owner===ownerId)
    if(!visible.length)return ev.isMaster===true?'这个群目前没有托付记忆':'你还没托付我记过事（群主可看全部）'
    return [`当前托付记忆（忘掉用 memory_id）：`,...visible.map(e=>formatDelegatedLine(e,at))].join('\n')
  }

  async function forget(opts:Record<string,unknown>,ev:DelegatedEvent){
    const groupId=String(ev.group_id||'')
    const ownerId=String(ev.user_id||'')
    const shortId=String(opts.memory_id||'').trim()
    if(!shortId)return '要忘掉哪条？先 list 看短 id'
    const entries=await store.load(groupId)
    const matches=entries.filter(e=>e.id.includes(shortId))
    if(!matches.length)return `没找到 id 含「${shortId}」的托付`
    if(matches.length>1)return `「${shortId}」匹配到 ${matches.length} 条，把 id 抄全一点`
    const target=matches[0]!
    if(target.owner!==ownerId&&ev.isMaster!==true)return '只能忘掉自己托付的事（群主可删任何人的）'
    await store.save(groupId,entries.filter(e=>e.id!==target.id))
    ports.logger.info(`[委托记忆] 群 ${groupId} 忘掉 ${target.id}「${target.content.slice(0,40)}」`)
    return `已忘掉：「${target.content.slice(0,60)}」`
  }

  return {DelegateMemoryTool,store}
}
