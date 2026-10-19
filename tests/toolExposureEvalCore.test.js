import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {validateExposureFixture,replayToolExposureScenario,evaluateToolExposure,summarizeExposureRows,runLiveExposure,MODEL_REPLAYS} from '../dist/backend/scripts/toolExposureEval.js'

const fixture=validateExposureFixture(JSON.parse(readFileSync(new URL('./fixtures/toolIntentScenarios.json',import.meta.url),'utf8')))
const find=id=>fixture.scenarios.find(scenario=>scenario.id===id)

test('场景库包含八类工具的口语、结构上下文、独立留出样本和负例',()=>{
  const groups=new Map()
  for(const scenario of fixture.scenarios.filter(row=>row.expectedAction==='tool'))groups.set(scenario.expectedTool,[...(groups.get(scenario.expectedTool)||[]),scenario])
  assert.equal(groups.size,8)
  for(const [tool,rows] of groups){
    assert.ok(rows.length>=10,tool)
    assert.ok(rows.some(row=>row.split==='holdout'),tool)
    assert.ok(rows.some(row=>row.difficulty==='colloquial'),tool)
  }
  assert.ok(fixture.scenarios.some(row=>row.expectedAction==='clarify'&&row.text==='他上次说啥'))
  assert.ok(fixture.scenarios.some(row=>row.expectedAction==='answer'&&row.context?.quote))
  assert.ok(fixture.scenarios.some(row=>row.context?.atQq?.length))
  assert.ok(fixture.scenarios.some(row=>row.context?.history?.length))
})

test('重复id、未知工具与无效预期动作应拒绝，不能默默污染评测分母',()=>{
  assert.throws(()=>validateExposureFixture({...fixture,scenarios:[find('githubRepoTool-01'),find('githubRepoTool-01')]}),/重复/)
  assert.throws(()=>validateExposureFixture({...fixture,scenarios:[{...find('githubRepoTool-01'),expectedTool:'notRegisteredTool'}]}),/expectedTool/)
  assert.throws(()=>validateExposureFixture({...fixture,scenarios:[{...find('githubRepoTool-01'),expectedAction:'anything'}]}),/expectedAction/)
})

test('确定性Github直调属于成功旁路，模型完全不调用且参数可核验',async()=>{
  const row=await replayToolExposureScenario(find('githubRepoTool-01'),fixture,'timeout')
  assert.equal(row.directTool,'githubRepoTool')
  assert.equal(row.routingSuccess,true)
  assert.equal(row.parameterStatus,'pass')
  assert.equal(row.stages.intent.state,'bypass')
  assert.equal(row.stages.intent.reason,'deterministic_skip')
  assert.equal(row.stages.planner.state,'bypass')
  assert.equal(row.stages.request.state,'bypass')
  assert.deepEqual(row.requestTools,[],'确定性直调在主模型请求前返回，没有模型曝光')
  assert.deepEqual(row.modelCalls,{intent:0,planner:0})
  assert.equal(row.answerQuality,'unmeasured')
  assert.equal(row.toolResult,'not_executed')
})

test('正确模型、明确聊天、低置信度与模型故障分别回放真实分支',async()=>{
  const scenario=find('searchInformationTool-01')
  const rows=await Promise.all(MODEL_REPLAYS.map(mode=>replayToolExposureScenario(scenario,fixture,mode)))
  assert.equal(rows[0].routingSuccess,true)
  assert.equal(rows[1].plannerDecision?.intent,'chat')
  assert.equal(rows[1].routingSuccess,false)
  assert.equal(rows[1].deadAt,'planner_chat')
  assert.equal(rows[2].plannerDecision,null,'低置信度不是明确chat')
  assert.equal(rows[2].primaryIntent,'unavailable','生产host会拒绝低置信度primary结果')
  assert.deepEqual(rows[2].requestTools,rows[3].requestTools,'低信与超时都走同一规则兜底，不得偷用低信search标签')
  assert.equal(rows[3].primaryIntent,'unavailable')
  assert.match(rows[3].modelAssumption,/兜底/)
  assert.deepEqual(rows[4].modelCalls,{intent:0,planner:0})
  assert.equal(rows[5].plannerDecision,null)
})

test('只有曝光而尚未生成调用时参数标为unmeasured',async()=>{
  const row=await replayToolExposureScenario(find('searchInformationTool-01'),fixture,'unavailable')
  assert.equal(row.directTool,null)
  assert.equal(row.routingSuccess,true)
  assert.ok(row.requestTools.includes('searchInformationTool'))
  assert.equal(row.parameterStatus,'unmeasured')
})

test('request useTools关闭不把模型不可见的schema计为到达',async()=>{
  const scenario={...find('searchInformationTool-01'),config:{useTools:false}}
  const row=await replayToolExposureScenario(scenario,fixture,'unavailable')
  assert.equal(row.executionMode,'tool')
  assert.equal(row.routingSuccess,false)
  assert.equal(row.deadAt,'request')
  assert.deepEqual(row.requestTools,[])
})

test('负例单独记录误直调和曝光，不冒充最终回答/澄清准确率',async()=>{
  const scenario={...find('githubRepoTool-01'),id:'negative-deterministic',expectedAction:'answer'}
  const row=await replayToolExposureScenario(scenario,fixture,'tool')
  assert.equal(row.routingSuccess,null)
  assert.equal(row.unsafeDirectCall,true)
  assert.equal(row.answerQuality,'unmeasured')
  const summary=Object.values(summarizeExposureRows([row]))[0]
  assert.equal(summary.positives,0)
  assert.equal(summary.unsafeDirect,1)
})

test('旁路与不适用不进入环节丢分分母',async()=>{
  const row=await replayToolExposureScenario(find('githubRepoTool-01'),fixture,'unavailable')
  const summary=Object.values(summarizeExposureRows([row]))[0]
  assert.equal(summary.stages.intent.applicable,0)
  assert.equal(summary.stages.request.applicable,0)
  assert.equal(summary.reached,1)
})

test('场景和模型分支筛选可复现，不会混入其他样本',async()=>{
  const report=await evaluateToolExposure(fixture,{scenarioIds:['githubRepoTool-01'],modes:['tool','unavailable']})
  assert.equal(report.scenarioCount,1)
  assert.equal(report.rows.length,2)
  assert.ok(report.rows.every(row=>row.id==='githubRepoTool-01'))
})

test('live缺配置明确skipped，不访问网络或输出虚假的模型成功',async()=>{
  let requests=0
  const report=await runLiveExposure(fixture,{}, {scenarioIds:['searchInformationTool-01'],mainModel:true,fetchImpl:async()=>{requests++;throw new Error('must not fetch')}})
  assert.equal(requests,0)
  assert.deepEqual(report.observations[0].models.map(row=>row.status),['skipped','skipped','skipped'])
})

test('live沙箱只调用模型，保存文本/调用类型并脱敏endpoint和key',async()=>{
  const secret='sk-do-not-export',endpoint='https://private.example/v1'
  let requests=0
  const report=await runLiveExposure(fixture,{intentAiConfig:{intentAiUrl:endpoint,intentAiApikey:secret,intentAiModel:'intent-eval'},toolsAiConfig:{toolsAiUrl:endpoint,toolsAiApikey:secret,toolsAiModel:'main-eval'}},{scenarioIds:['searchInformationTool-01'],mainModel:true,fetchImpl:async(_url,options)=>{
    requests++
    const request=JSON.parse(options.body)
    if(request.tools)return new Response(JSON.stringify({choices:[{message:{tool_calls:[{function:{name:'searchInformationTool',arguments:'{"query":"上海天气"}'}}],content:`${endpoint} ${secret}`}}]}),{status:200})
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'search',confidence:0.99,query:'上海天气',reason:'需要实时信息'})}}]}),{status:200})
  }})
  assert.equal(requests,3)
  const observation=report.observations[0].models.find(row=>row.stage==='main')
  assert.equal(observation.status,'ok')
  assert.equal(observation.outputKind,'tool_calls')
  assert.equal(observation.calls[0].name,'searchInformationTool')
  const serialized=JSON.stringify(report)
  assert.ok(!serialized.includes(secret))
  assert.ok(!serialized.includes(endpoint))
})

test('live规划器门控也不能使用被生产host拒绝的低信search结果',async()=>{
  const scenario={...find('searchInformationTool-01'),id:'live-low-confidence',text:'这个怎么说呢',context:{}}
  let requests=0
  const report=await runLiveExposure({...fixture,scenarios:[scenario]},{intentAiConfig:{intentAiUrl:'https://eval.invalid/v1',intentAiApikey:'eval-placeholder',intentAiModel:'eval-only'}},{fetchImpl:async()=>{
    requests++
    return new Response(JSON.stringify({choices:[{message:{content:'{"intent":"search","confidence":0.2,"reason":"没把握"}'}}]}),{status:200})
  }})
  assert.equal(requests,1)
  const [intent,planner]=report.observations[0].models
  assert.equal(intent.accepted,false)
  assert.equal(intent.confidence,0.2)
  assert.equal(planner.status,'skipped')
})

test('live两模型分别遵守生产配置选择：primary整块选择，planner逐字段回退',async()=>{
  const requests=[]
  const report=await runLiveExposure(fixture,{intentAiConfig:{intentAiUrl:'https://eval.invalid/v1'},toolsAiConfig:{toolsAiUrl:'https://unused.invalid/v1',toolsAiApikey:'eval-placeholder',toolsAiModel:'planner-fallback'}},{scenarioIds:['searchInformationTool-01'],fetchImpl:async(url,options)=>{
    requests.push({url,body:JSON.parse(options.body)})
    return new Response(JSON.stringify({choices:[{message:{content:'{"intent":"search","confidence":0.99,"query":"上海天气"}'}}]}),{status:200})
  }})
  assert.equal(requests.length,1,'primary选择intent块缺key而skip，planner从tools回退key/model仍可调用')
  assert.equal(requests[0].url,'https://eval.invalid/v1/chat/completions')
  assert.equal(requests[0].body.model,'planner-fallback')
  assert.equal(report.observations[0].models[0].status,'skipped')
  assert.equal(report.observations[0].models[1].status,'ok')
})
