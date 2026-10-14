import test from 'node:test'
import assert from 'node:assert/strict'
import {createDicePlugin} from '../dist/backend/modules/dice/infrastructure/app.js'

function setup({receipt={message_id:'sent'},result}={}) {
  const logs=[],outcomes=[],sent=[]
  const manager={getConfig:()=>({enabled:true,customRulesEnabled:true}),isObserver:()=>false,isReplyEnabled:()=>true,isLogRecording:()=>true,recordDiceResult:async(_e,text)=>logs.push(text),handleRoll:(_e,text)=>`roll:${text}`}
  const ruleManager={warmupJsPacks:async()=>{},findInvocation:()=>({}),handleDynamicCommand:async()=>result,settlePrivateDeliveries:async(_g,_p,items)=>outcomes.push(...items)}
  class Plugin {constructor(options){Object.assign(this,options)}}
  const DicePlugin=createDicePlugin(Plugin,{diceManager:manager,deckManager:{},ruleManager,pluginRoot:'/unused',logger:{},sendSmartReply:async(_e,text)=>{sent.push(text);return receipt}})
  return {app:new DicePlugin(),logs,outcomes,sent,event:{group_id:'g',user_id:'u',msg:'.r d6',reply:async()=>receipt}}
}
test('compiled dice command split executes known commands and ignores parameter dots',async()=>{
  const r=setup();r.event.msg='.r d6.r d8';await r.app.roll(r.event)
  assert.deepEqual(r.sent,['roll:d8','roll:d6'])
  assert.equal(r.event.msg,'.r d6')
  assert.equal(await r.app.dispatchSplitCommands({...r.event,msg:'.draw 示例.牌组'}),false)
})
test('compiled dice result log requires confirmed delivery',async()=>{
  for(const receipt of [null,false,{retcode:100},{status:'ok'}]){
    const r=setup({receipt});await r.app.reply(r.event,'result');assert.deepEqual(r.logs,[])
  }
  const r=setup();await r.app.reply(r.event,'confirmed');assert.deepEqual(r.logs,['confirmed'])
})
test('compiled dice private delivery distinguishes rejection and uncertainty',async()=>{
  for(const [value,state] of [[{message_id:'1'},'sent'],[{retcode:100},'failed'],[undefined,'unknown']]){
    const r=setup({result:{matched:true,packId:'pack',text:'done',privateMessages:[{deliveryId:'d',userId:'other',text:'secret'}]}})
    r.event.bot={pickFriend:()=>({sendMsg:async()=>value})}
    await r.app.customDiceRule(r.event)
    assert.equal(r.outcomes[0].state,state);assert.equal(r.outcomes[0].ok,state==='sent')
    if(state==='unknown')assert.match(r.sent[0],/阻止重复投递/)
  }
})
test('compiled dice import management rejects ordinary users before loading source',async()=>{
  const r=setup();r.event.msg='.骰规则导入 payload';await r.app.manageDiceRules(r.event)
  assert.match(r.sent[0],/只有主人/)
})
test('compiled dice confirms Seal import using its textual result',async()=>{
  const r=setup();r.event.msg='.骰规则确认 seal-pack';r.event.isMaster=true
  // A Seal extension confirmation returns its own detailed summary.
  const manager={getConfig:()=>({enabled:true,customRulesEnabled:true}),isObserver:()=>false,isReplyEnabled:()=>true,isLogRecording:()=>false,recordDiceResult:async()=>{}}
  class Plugin {constructor(options){Object.assign(this,options)}}
  const sent=[]
  const PluginClass=createDicePlugin(Plugin,{diceManager:manager,deckManager:{},ruleManager:{warmupJsPacks:async()=>{},confirmImport:async()=> '海豹扩展已保存'},pluginRoot:'/unused',logger:{},sendSmartReply:async(_e,text)=>{sent.push(text);return {message_id:'1'}}})
  await new PluginClass().manageDiceRules(r.event)
  assert.deepEqual(sent,['海豹扩展已保存'])
})
test('compiled dice only retries errors known to precede transport',async()=>{
  for(const attempt of [false,true]){
    const r=setup({result:{matched:true,packId:'pack',text:'done',privateMessages:[{deliveryId:'d',userId:'other',text:'secret'}]}})
    if(attempt)r.event.bot={pickFriend:()=>({sendMsg:async()=>{throw new Error('connection lost')}})}
    await r.app.customDiceRule(r.event)
    assert.equal(r.outcomes[0].state,attempt?'unknown':'failed')
  }
})
