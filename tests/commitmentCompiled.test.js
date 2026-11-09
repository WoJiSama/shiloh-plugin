// 承诺账本 compiled 集成测试:fake redis(仿 reminderCompiled)+ 注入时钟。
// 覆盖 create/list/cancel 权限、仿真群闸、tick 静态直发/agent 唤醒/顺延/重试/到期收档。
import test from 'node:test'
import assert from 'node:assert/strict'
import {createCommitmentRuntime} from '../dist/backend/modules/commitments/infrastructure/commitmentTool.js'

const prefix='bl-chat:commitment:'
function setup({ simGroups=['20'] } = {}) {
  const clock={value:Date.parse('2026-11-09T20:00:00+08:00')}
  const data=new Map(),botCalls=[],wakeCalls=[],logs=[]
  const redis={get:async k=>data.get(k)||null,set:async(k,v,opts)=>{if(opts?.NX&&data.has(k))return null;data.set(k,v);return 'OK'},del:async k=>data.delete(k),eval:async(_s,{keys,arguments:args})=>{if(data.get(keys[0])===args[0])data.delete(keys[0])}}
  const bot={uin:'200',sendApi:async(...args)=>{botCalls.push(args);return {retcode:0,data:{message_id:'m1'}}}}
  const runtime=createCommitmentRuntime({
    redis,logger:{info:m=>logs.push(String(m)),warn(){},error:(m,e)=>logs.push(`${m} ${e instanceof Error?e.message:String(e)}`)},
    getBot:id=>!id||id==='200'?bot:undefined,
    isSimulationGroup:async gid=>simGroups.includes(String(gid)),
    wakeSim:async (gid,card)=>{wakeCalls.push([String(gid),card])},
    loadConfig:()=>({}),
    now:()=>clock.value
  })
  return {clock,data,botCalls,wakeCalls,logs,bot,redis,...runtime,tool:new runtime.CommitmentTool()}
}
const ev={group_id:20,user_id:10001,isMaster:false,sender:{nickname:'星野'}}

test('create/list/cancel 全链路 + 权限',async()=>{
  const r=setup()
  const created=await r.tool.execute({action:'create',intent:'每天中午12点在群里发三角洲今日密码',schedule_kind:'daily',schedule_time:'12:00'},ev)
  assert.match(created,/已记下/)
  const listed=await r.tool.execute({action:'list'},ev)
  assert.match(listed,/每天 12:00.*三角洲今日密码.*星野/s)
  const [entry]=JSON.parse(r.data.get(prefix+'pending:list'))
  assert.match(await r.tool.execute({action:'cancel',commitment_id:entry.id.slice(4,14)},{...ev,user_id:999}),/只能取消自己创建的/)
  assert.match(await r.tool.execute({action:'cancel',commitment_id:entry.id.slice(4,14)},{...ev,isMaster:true}),/已取消/)
  assert.equal(JSON.parse(r.data.get(prefix+'pending:list')).length,0)
})

test('agent 类承诺要求仿真群;static 类任意群可建;私聊拒绝',async()=>{
  const r=setup({simGroups:[]})
  assert.match(await r.tool.execute({action:'create',intent:'每天中午12点发三角洲今日密码',schedule_kind:'daily',schedule_time:'12:00'},ev),/没开仿真/)
  assert.match(await r.tool.execute({action:'create',intent:'明天中午提醒我喝水',schedule_kind:'once',schedule_time:'2026-11-10T12:00:00+08:00',deliver:'static',static_message:'该喝水啦'},ev),/已记下/)
  assert.match(await r.tool.execute({action:'create',intent:'x',schedule_kind:'daily',schedule_time:'12:00'},{...ev,group_id:undefined}),/只能在群里创建/)
})

test('时间/参数错误诚实拒绝',async()=>{
  const r=setup()
  assert.match(await r.tool.execute({action:'create',intent:'每天发个东西',schedule_kind:'daily',schedule_time:'25:00'},ev),/HH:mm/)
  assert.match(await r.tool.execute({action:'create',intent:'x',schedule_kind:'once',schedule_time:'2020-01-01T00:00:00+08:00'},ev),/过去/)
  assert.match(await r.tool.execute({action:'create',intent:'x',schedule_kind:'daily',schedule_time:'12:00',deliver:'static'},ev),/static_message/)
  assert.match(await r.tool.execute({action:'create',schedule_kind:'daily',schedule_time:'12:00'},ev),/原话/)
})

test('tick 静态兑现:发送 + once 完结;agent 唤醒 + daily 顺延',async()=>{
  const r=setup()
  await r.tool.execute({action:'create',intent:'中午提醒',schedule_kind:'once',schedule_time:'2026-11-10T12:00:00+08:00',deliver:'static',static_message:'该喝水啦'},ev)
  await r.tool.execute({action:'create',intent:'每天中午12点在群里发三角洲今日密码',schedule_kind:'daily',schedule_time:'12:00'},ev)
  r.clock.value=Date.parse('2026-11-10T12:00:05+08:00')
  await r.commitmentTick()
  assert.equal(r.botCalls.length,1,'static 直发一次')
  assert.equal(r.botCalls[0][0],'send_group_msg')
  assert.deepEqual(r.botCalls[0][1].message,[{type:'at',data:{qq:'10001'}},{type:'text',data:{text:' 该喝水啦'}}])
  assert.equal(r.wakeCalls.length,1,'agent 唤醒一次')
  assert.equal(r.wakeCalls[0][0],'20')
  assert.match(r.wakeCalls[0][1],/星野 托付的事/)
  const pending=JSON.parse(r.data.get(prefix+'pending:list'))
  assert.equal(pending.length,1,'once 完结出列,daily 仍在')
  const daily=JSON.parse(r.data.get(prefix+'detail:'+pending[0].id))
  assert.equal(daily.schedule.kind,'daily')
  assert.equal(daily.next_run_at,Date.parse('2026-11-11T12:00:00+08:00'),'daily 顺延到明天')
  assert.equal(daily.last_result,'dispatched')
  // 重复 tick 不双发(已顺延到明天)
  await r.commitmentTick()
  assert.equal(r.botCalls.length,1)
  assert.equal(r.wakeCalls.length,1)
})

test('tick 失败重试 3 次后置 failed',async()=>{
  const r=setup()
  r.bot.sendApi=async()=>{throw new Error('send boom')}
  await r.tool.execute({action:'create',intent:'提醒',schedule_kind:'once',schedule_time:'2026-11-10T12:00:00+08:00',deliver:'static',static_message:'x'},ev)
  let at=Date.parse('2026-11-10T12:00:05+08:00')
  for(let i=0;i<6;i++){
    r.clock.value=at
    await r.commitmentTick()
    at+=20000
  }
  assert.equal(JSON.parse(r.data.get(prefix+'pending:list')).length,0,'重试超限后出列')
  assert.ok(r.logs.some(l=>/兑现.*失败/.test(l)))
})

test('到期承诺不再唤醒,直接收档',async()=>{
  const r=setup()
  await r.tool.execute({action:'create',intent:'每天发',schedule_kind:'daily',schedule_time:'12:00'},ev)
  r.clock.value=Date.parse('2026-12-25T12:00:05+08:00')
  await r.commitmentTick()
  assert.equal(r.wakeCalls.length,0,'过期承诺不再唤醒')
  assert.equal(JSON.parse(r.data.get(prefix+'pending:list')).length,0)
})

test('renew 续期:权限 + 顺延一个默认周期 + 重置问询标记',async()=>{
  const r=setup()
  await r.tool.execute({action:'create',intent:'每天中午12点发三角洲今日密码',schedule_kind:'daily',schedule_time:'12:00'},ev)
  const [entry]=JSON.parse(r.data.get(prefix+'pending:list'))
  const shortId=entry.id.slice(4,14)
  assert.match(await r.tool.execute({action:'renew',commitment_id:shortId},{...ev,user_id:999}),/只能续自己创建的/)
  assert.match(await r.tool.execute({action:'renew',commitment_id:'deadbeef12'}),/没找到/)
  const before=JSON.parse(r.data.get(prefix+'detail:'+entry.id))
  r.clock.value+=86400_000
  const renewed=await r.tool.execute({action:'renew',commitment_id:shortId},ev)
  assert.match(renewed,/已续期/)
  const after=JSON.parse(r.data.get(prefix+'detail:'+entry.id))
  assert.ok(after.expiry_at>r.clock.value+29*86400_000,'到期时间顺延约 30 天')
  assert.equal(after.renewal_asked_at,0,'问询标记重置')
  assert.equal(after.status,'active')
  assert.equal(JSON.parse(r.data.get(prefix+'pending:list')).length,1,'仍在活跃清单')
  assert.equal(before.expiry_at,after.expiry_at-86400_000,'恰好差一天的顺延')
})

test('失约明说:wake 连续失败 3 次后,群内收到坦白 + faillog 记录',async()=>{
  // agent 类承诺,wake 抛错但 bot 可用 → 重试超限后失约明说走 bot 直发
  const data=new Map(),botCalls=[],logs=[]
  const redis={get:async k=>data.get(k)||null,set:async(k,v,opts)=>{if(opts?.NX&&data.has(k))return null;data.set(k,v);return 'OK'},del:async k=>data.delete(k),eval:async(_s,{keys,arguments:args})=>{if(data.get(keys[0])===args[0])data.delete(keys[0])}}
  const bot={uin:'200',sendApi:async(...args)=>{botCalls.push(args);return {retcode:0,data:{message_id:'m1'}}}}
  const clock={value:Date.parse('2026-11-09T20:00:00+08:00')}
  const rt2=createCommitmentRuntime({
    redis,logger:{info:m=>logs.push(String(m)),warn:m=>logs.push(String(m)),error:(m,e)=>logs.push(`${m} ${e instanceof Error?e.message:String(e)}`)},
    getBot:()=>bot,
    isSimulationGroup:async()=>true,
    wakeSim:async()=>{throw new Error('sim wake boom')},
    loadConfig:()=>({}),
    now:()=>clock.value
  })
  const tool2=new rt2.CommitmentTool()
  await tool2.execute({action:'create',intent:'每天中午12点发三角洲今日密码',schedule_kind:'daily',schedule_time:'12:00'},ev)
  assert.equal(botCalls.length,0,'创建期不发消息')
  let at=Date.parse('2026-11-10T12:00:05+08:00')
  for(let i=0;i<6;i++){
    clock.value=at
    await rt2.commitmentTick()
    at+=20000
  }
  const admission=botCalls.find(call=>String(call[1]?.message?.[1]?.data?.text||'').includes('没办成'))
  assert.ok(admission,'失约明说消息已发出')
  assert.match(admission[1].message[1].data.text,/没办成.+sim wake boom/,'明说带真实原因')
  assert.equal(admission[1].message[0].data.qq,'10001','艾特创建人')
  const faillog=JSON.parse(data.get(prefix+'faillog'))
  assert.equal(faillog.length,1)
  assert.equal(faillog[0].reason,'sim wake boom')
  assert.equal(faillog[0].group_id,'20')
})

test('续约问询(static 群):到期前 3 天直发问一次,不重复追问',async()=>{
  const r=setup({simGroups:[]})
  await r.tool.execute({action:'create',intent:'每天9点说早安',schedule_kind:'daily',schedule_time:'09:00',deliver:'static',static_message:'早安'},ev)
  const [entry]=JSON.parse(r.data.get(prefix+'pending:list'))
  // 跳到到期前 2 天(进入 3 天问询窗;daily 也已到期会正常执行)
  r.clock.value=Date.parse('2026-12-07T09:00:05+08:00')
  await r.commitmentTick()
  const asks=r.botCalls.filter(call=>String(call[1]?.message?.[1]?.data?.text||'').includes('天到期'))
  assert.equal(asks.length,1,'问询恰好一次')
  assert.match(asks[0][1].message[1].data.text,/跟我说一声/)
  const detail=JSON.parse(r.data.get(prefix+'detail:'+entry.id))
  assert.ok(detail.renewal_asked_at>0,'问询时间已持久化')
  // 10 分钟后再 tick:不重复问
  r.clock.value+=11*60_000
  await r.commitmentTick()
  assert.equal(r.botCalls.filter(call=>String(call[1]?.message?.[1]?.data?.text||'').includes('天到期')).length,1,'问过不再追问')
  assert.match(r.botCalls[r.botCalls.length-1][1].message[1].data.text,/早安/,'日常 static 兑现不受影响')
})

test('续约问询(仿真群):agent 类到期前唤醒问续,renewal 卡片指引',async()=>{
  const r=setup()
  await r.tool.execute({action:'create',intent:'每天中午12点发三角洲今日密码',schedule_kind:'daily',schedule_time:'12:00'},ev)
  const [entry]=JSON.parse(r.data.get(prefix+'pending:list'))
  r.clock.value=Date.parse('2026-12-07T12:00:05+08:00')
  await r.commitmentTick()
  const renewalWake=r.wakeCalls.find(([,card])=>card.includes('天到期'))
  assert.ok(renewalWake,'续约问询唤醒已发出')
  assert.match(renewalWake[1],/action=renew/,'卡片指引 renew')
  assert.match(renewalWake[1],/不再追问/)
  const detail=JSON.parse(r.data.get(prefix+'detail:'+entry.id))
  assert.ok(detail.renewal_asked_at>0)
})
