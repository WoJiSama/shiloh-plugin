import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {TurtleSoupStore} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js"
import {TurtleSoupGenerator} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.js"
import {parseGeneratedPuzzle, parseLogicAudit, parsePuzzleReview, parsePuzzleSimulation, buildPuzzleGenerationMessages, buildHostAnswerMessages, parseHostAnswer, parseGuessJudge} from "../dist/backend/modules/games/domain/turtleSoup/turtleSoupPrompts.js"
import {hasCurrentPassingAudits, puzzleContentHash} from "../dist/backend/modules/games/domain/turtleSoup/turtleSoupQuality.js"

const now = 1_700_000_000_000
const config = {enabled:true,minPlayers:1,joinWindowMinutes:5,idleTimeoutMinutes:5,guessCooldownSeconds:30,similarityHitThreshold:0.9,similarityMissThreshold:0,freshPoolTarget:1,maxPending:2,generationModel:"writer",reviewModel:"reviewer",ratingWindowMinutes:5,maxHints:3,contentPolicy:"测试尺度",baseDir:"data/turtle_soup",generationCallBudget:18}
const pass = () => JSON.stringify({pass:true,holes:[],reason:"固定事实与线索自洽",repairable:true})
const fail = (hole, repairable = true) => JSON.stringify({pass:false,holes:[hole],reason:hole,repairable})
const simulation = () => JSON.stringify({pass:true,holes:[],reason:"三问可推进",probes:[{question:"这是为了帮助别人吗",answer:"是",basis:"明确动机"},{question:"物品曾被移走吗",answer:"不是",basis:"明确位置"},{question:"前后信息不对称吗",answer:"是",basis:"明确事实"}]})
function soup(index = 0, overrides = {}) {
  const surface = ["甲","丙","戊","庚","壬"][index % 5].repeat(100)
  const solution = ["乙","丁","己","辛","癸"][index % 5].repeat(65)
  return {title:`独立题${index}`,surface,solution,keyPoints:["核心事实一","核心事实二","背景事实三"],keyPointIds:["kp1","kp2","kp3"],requiredKeyPointIds:["kp1","kp2"],facts:["固定事实"],hints:["方向提示","因果提示","核心提示"],difficulty:"normal",tags:["日常误会"],mechanism:`机制${index}的独立因果链`,...overrides}
}
function kind(messages) {
  const system = String(messages[0].content)
  if (system.includes("出题人")) return "generation"
  if (system.includes("修复师")) return "repair"
  if (system.includes("逻辑审计员")) return "logic"
  if (system.includes("试玩审核员")) return "simulation"
  return "playability"
}
function setup(t, respond, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"turtle-soup-pipeline-"))
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}))
  const store = new TurtleSoupStore({cwd:dir,baseDir:"data/turtle_soup"})
  const calls = []
  const generator = new TurtleSoupGenerator({store,config:()=>({...config,...overrides}),callModel:async (messages, options) => {
    const stage = kind(messages); calls.push({stage,messages,options})
    const value = await respond?.(stage,messages,calls)
    return value ?? (stage === "generation" ? JSON.stringify(soup()) : stage === "simulation" ? simulation() : pass())
  },now:()=>now,random:()=>0.5,retryDelayMs:0,logger:{info(){},warn(){}}})
  return {dir,store,generator,calls}
}
function savedPuzzle(id, index = 4, overrides = {}) { return {...soup(index),id,source:"manual",createdAt:now,status:"active",ratingCount:0,ratingSum:0,...overrides} }

test("生成最终版本四道审核与候选一起保存，审核绑定内容指纹",async t => {
  const {store,generator,calls} = setup(t)
  const puzzle = await generator.generateOne("normal")
  assert.equal(puzzle.status,"pending")
  assert.equal(calls.length,4)
  assert.equal(calls[0].options.model,"writer")
  assert.ok(calls.slice(1).every(call=>call.options.model === "reviewer"))
  assert.ok(hasCurrentPassingAudits(puzzle))
  assert.ok(puzzle.audits.every(audit=>audit.contentHash === puzzleContentHash(puzzle)))
  assert.equal(store.readCandidates().candidates[0].recoveredPuzzleId,puzzle.id)
  assert.equal(store.readCandidates().candidates[0].versions.length,1)
  assert.equal(hasCurrentPassingAudits({...puzzle,solution:puzzle.solution+"改变了真相"}),false)
})

test("两轮修复推进最新版本，最终稿重新经过全部审核",async t => {
  let repair = 0, logic = 0
  const inputs = []
  const {store,generator,calls} = setup(t,(stage,messages)=>{
    if (stage === "logic") return ++logic <= 2 ? fail(logic === 1 ? "原稿物件漏洞" : "新稿时间漏洞") : pass()
    if (stage === "repair") {
      inputs.push(JSON.parse(messages[1].content))
      return JSON.stringify(soup(0,{solution:(++repair === 1 ? "第一轮修复" : "第二轮修复")+"乙".repeat(65)}))
    }
  })
  const puzzle = await generator.generateOne("normal")
  assert.match(inputs[1].puzzle.solution,/第一轮修复/)
  assert.ok(inputs[1].issues.some(issue=>issue.includes("新稿时间漏洞")))
  assert.match(puzzle.solution,/第二轮修复/)
  assert.equal(calls.filter(call=>call.stage === "playability").length,3)
  assert.equal(calls.filter(call=>call.stage === "simulation").length,3)
  assert.equal(store.readCandidates().candidates[0].versions.length,3)
  assert.ok(puzzle.audits.every(audit=>audit.pass))
})

test("结构、可玩性和试玩问题均可进入同一修复链",async t => {
  for (const failing of ["structure","playability","simulation"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),"soup-stage-repair-")); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
    const store = new TurtleSoupStore({cwd:dir})
    let fixed = false
    const generator = new TurtleSoupGenerator({store,config:()=>config,callModel:async messages=>{
      const stage=kind(messages)
      if (stage === "generation") return JSON.stringify(soup(0,failing === "structure" ? {surface:"太短"} : {}))
      if (stage === "repair") {fixed=true; return JSON.stringify(soup(0,{solution:"已修复"+"乙".repeat(65)}))}
      if (stage === failing && !fixed) return failing === "simulation" ? JSON.stringify({...JSON.parse(simulation()),pass:false,holes:["核心事实没有可探询入口"]}) : fail("必要动机缺乏线索")
      return stage === "simulation" ? simulation() : pass()
    }})
    assert.ok(hasCurrentPassingAudits(await generator.generateOne("normal")),failing)
    assert.equal(fixed,true)
  }
})

test("修复不能偷改指定难度或生成现有题的复制稿",async t => {
  const {store,generator} = setup(t,(stage)=>{
    if (stage === "logic") return fail("动机不足")
    if (stage === "repair") return JSON.stringify(soup(0,{difficulty:"easy",surface:soup(4).surface}))
  })
  await store.savePuzzle(savedPuzzle("existing"))
  await assert.rejects(generator.generateOne("normal"),/重复/)
  assert.equal(store.readPuzzles().puzzles.length,1)
  const latest=store.readCandidates().candidates[0].versions.at(-1)
  assert.ok(latest.issues.some(issue=>issue.includes("难度不符")))
  assert.ok(latest.issues.some(issue=>issue.includes("重复")))
})

test("审核字段互相矛盾、缺少问题列表及无效试玩不能通过",()=>{
  assert.equal(parseLogicAudit('{"pass":true,"holes":["矛盾"],"reason":"错误"}'),null)
  assert.equal(parsePuzzleReview('{"pass":true,"reason":"通过"}'),null)
  assert.equal(parseLogicAudit('{"pass":false,"holes":[],"reason":"失败"}'),null)
  assert.equal(parsePuzzleSimulation(pass()),null)
  const unknown={...JSON.parse(simulation()),probes:JSON.parse(simulation()).probes.map(probe=>({...probe,answer:"无法确定"}))}
  assert.equal(parsePuzzleSimulation(JSON.stringify(unknown)),null)
  const injected=parseGeneratedPuzzle(JSON.stringify({...soup(),manualScore:5,manualScoreReason:"自己评的",familyId:"other",audits:[{domain:"logic",pass:true,reason:"自批"}]}),{nowMs:now,random:0.5,model:"test"})
  assert.equal(injected.manualScore,undefined)
  assert.equal(injected.familyId,undefined)
  assert.equal(injected.audits,undefined)
})

test("审核接口短暂失败只重试当前阶段，不丢弃已生成题",async t => {
  let logic=0
  const {generator,calls}=setup(t,stage=>{if(stage === "logic" && ++logic === 1)throw new Error("临时超时")})
  const puzzle=await generator.generateOne("normal")
  assert.ok(hasCurrentPassingAudits(puzzle))
  assert.equal(calls.filter(call=>call.stage === "generation").length,1)
  assert.equal(calls.filter(call=>call.stage === "playability").length,1)
  assert.equal(calls.filter(call=>call.stage === "logic").length,2)
})

test("失败候选保留阶段和原始输出，可重启后从审核阶段恢复且幂等",async t => {
  const {store,generator,calls}=setup(t,stage=>stage === "logic" ? "不是JSON" : undefined)
  await assert.rejects(generator.generateOne("normal"),/logic阶段失败/)
  const candidate=store.readCandidates().candidates[0]
  assert.equal(candidate.stage,"logic")
  assert.equal(candidate.failureKind,"technical")
  assert.equal(candidate.rawOutput,"不是JSON")
  assert.equal(candidate.versions.length,1)
  assert.equal(calls.filter(call=>call.stage === "generation").length,1)
  const resumed=[]
  const next=new TurtleSoupGenerator({store,config:()=>config,callModel:async messages=>{resumed.push(kind(messages));return kind(messages)==="simulation"?simulation():pass()}})
  const puzzle=await next.recoverCandidate(candidate.id)
  assert.deepEqual(resumed,["logic","simulation"])
  assert.equal((await next.recoverCandidate(candidate.id)).id,puzzle.id)
  assert.equal(store.readPuzzles().puzzles.length,1)
})

test("生成格式失败也持久化候选，服务不可用时补货及时停止",async t=>{
  const {store,generator,calls}=setup(t,()=>"broken")
  const outcome=await generator.ensureFreshPool()
  assert.equal(outcome.failed,1)
  assert.equal(calls.length,2)
  const candidate=store.readCandidates().candidates[0]
  assert.equal(candidate.stage,"generation")
  assert.equal(candidate.rawOutput,"broken")
  assert.equal(candidate.versions.length,0)
})

test("预算耗尽保存已完成阶段，恢复时不重复生成",async t=>{
  const {store,generator,calls}=setup(t,stage=>stage === "simulation"?"bad":undefined,{generationCallBudget:4})
  await assert.rejects(generator.generateOne("normal"),/预算已用完/)
  assert.equal(calls.length,4)
  assert.equal(store.readCandidates().candidates[0].versions.length,1)
  const resumed=[]
  const retry=new TurtleSoupGenerator({store,config:()=>({...config,generationCallBudget:4}),callModel:async messages=>{resumed.push(kind(messages));return kind(messages)==="simulation"?simulation():pass()}})
  await retry.recoverCandidate(store.readCandidates().candidates[0].id)
  assert.deepEqual(resumed,["simulation"])
})

test("旧坏题修复产生新pending版本，保留family与旧评分，不覆盖旧题",async t=>{
  const {store,generator}=setup(t,stage=>stage === "repair"?JSON.stringify(soup(4,{solution:"修复后的真相"+"癸".repeat(65)})):undefined)
  const original=savedPuzzle("old",4,{status:"retired",ratingCount:3,ratingSum:6,manualScore:2,manualScoreReason:"动机不充分"})
  await store.savePuzzle(original)
  const revised=await generator.repairPuzzle("old")
  assert.notEqual(revised.id,"old")
  assert.equal(revised.familyId,"old")
  assert.equal(revised.parentPuzzleId,"old")
  assert.equal(revised.version,2)
  assert.equal(revised.ratingCount,0)
  assert.equal(revised.manualScore,undefined)
  assert.deepEqual(store.readPuzzles().puzzles.find(item=>item.id==="old"),original)
})

test("历史rejected缺少提示仍能恢复，历史教训继续可读",async t=>{
  const {store,generator}=setup(t,stage=>stage === "repair"?JSON.stringify(soup(0,{solution:"已补公平线索"+"乙".repeat(65)})):undefined)
  const legacy={...soup(),holes:["提示不足"],at:now};delete legacy.hints
  fs.writeFileSync(path.join(store.dataDir,"rejected.jsonl"),JSON.stringify(legacy)+"\n{broken\n")
  const candidate=store.readCandidates().candidates[0]
  assert.match(candidate.id,/^legacy_/)
  assert.ok(generator.readRejectionLessons().some(item=>item.holes.includes("提示不足")))
  const puzzle=await generator.recoverCandidate(candidate.id)
  assert.equal(puzzle.hints.length,3)
  assert.equal(puzzle.familyId,candidate.familyId)
})

test("相同机制换皮由语义审题拒绝，题材相同不直接拒绝",async t=>{
  const {store,generator,calls}=setup(t,(stage,messages)=>{
    if(stage === "playability") {
      const comparisons=JSON.parse(messages[1].content).comparisons
      assert.ok(comparisons.some(item=>item.id==="known"))
      return JSON.stringify({pass:false,holes:["同一信息错位机制换了场景"],reason:"核心机制重复",repairable:false,duplicateOf:"known"})
    }
  })
  await store.savePuzzle(savedPuzzle("known"))
  await assert.rejects(generator.generateOne("normal"),/机制/)
  assert.equal(calls.filter(call=>call.stage==="repair").length,0)
  assert.equal(store.readPuzzles().puzzles.length,1)
  await assert.rejects(generator.recoverCandidate(store.readCandidates().candidates[0].id),/不可修复/)
})

test("待审上限不冒充可玩库存，后续补货不会无限生成",async t=>{
  let index=0
  const {store,generator,calls}=setup(t,(stage,messages)=>{
    if(stage === "generation") {
      const difficulty=String(messages[1].content).match(/难度定为:(\w+)/)[1]
      return JSON.stringify(soup(index++,{difficulty}))
    }
  })
  const first=await generator.ensureFreshPool()
  assert.equal(first.added,2)
  assert.equal(generator.freshCount(),0)
  assert.equal(generator.readyFreshCount(),2)
  assert.match(first.lastError,/待审队列已满/)
  assert.equal((await generator.ensureFreshPool()).added,0)
  assert.equal(calls.filter(call=>call.stage==="generation").length,2)
  assert.equal(new Set(store.readPuzzles().puzzles.map(item=>item.difficulty)).size,2)
})

test("公开单题、批量和补货共享互斥锁",async t=>{
  let release
  const gate=new Promise(resolve=>{release=resolve})
  const {generator}=setup(t,async stage=>{if(stage==="generation")await gate})
  const pending=generator.generateOne("normal")
  assert.equal(generator.busy,true)
  await assert.rejects(generator.generateOne("normal"),/busy/)
  assert.equal((await generator.seed(2)).lastError,"busy")
  assert.equal((await generator.ensureFreshPool()).lastError,"busy")
  release()
  await pending
  assert.equal(generator.busy,false)
})

test("评分反馈带结构与独立内容票证据，差评不夹入好评或主持故障",async t=>{
  const {store,generator}=setup(t)
  await store.savePuzzle(savedPuzzle("low",4,{ratingCount:4,ratingSum:9,manualScore:4,manualScoreReason:"谜题本身不错但主持答错"}))
  await store.upsertPlay({playId:"play",puzzleId:"low",puzzleTitle:"",groupId:"g",startedAt:1,endedAt:2,solved:false,players:["a","b","c","d"],qaCount:0,ratings:[{userId:"a",score:2,comment:"动机牵强",at:3},{userId:"b",score:5,comment:"反转精彩",at:4},{userId:"c",score:1,comment:"接口超时",category:"technical",at:5},{userId:"d",score:1,comment:"线索不足",category:"clues",at:6}]})
  const feedback=generator.buildGenerationFeedback()
  assert.deepEqual(feedback.low[0].comments,["线索不足","动机牵强"])
  assert.equal(feedback.low[0].playerScore,8/3)
  assert.equal(feedback.low[0].sampleCount,3)
  assert.equal(feedback.low[0].manualScore,4)
  assert.match(feedback.low[0].manualReason,/主持/)
  assert.deepEqual(feedback.high[0].comments,["反转精彩"])
  const prompt=buildPuzzleGenerationMessages({contentPolicy:"测试",avoidTitles:[],feedback})[1].content
  assert.match(prompt,/真相摘要/)
  assert.match(prompt,/动机牵强/)
  assert.doesNotMatch(prompt,/接口超时/)
})

function feedbackPlay(playId,puzzleId,ratings) {return {playId,puzzleId,puzzleTitle:"",groupId:playId,startedAt:1,endedAt:2,solved:false,players:ratings.map(r=>r.userId),qaCount:0,ratings}}

test("纯主持、技术、难度和喜好评分不决定生成正反例；无明细聚合不冒充内容证据",async t=>{
  const {store,generator}=setup(t)
  await store.savePuzzle(savedPuzzle("host-low",4,{ratingCount:4,ratingSum:4}))
  await store.savePuzzle(savedPuzzle("host-high",4,{ratingCount:4,ratingSum:20}))
  await store.savePuzzle(savedPuzzle("aggregate-low",4,{ratingCount:20,ratingSum:20}))
  await store.savePuzzle(savedPuzzle("aggregate-high",4,{ratingCount:20,ratingSum:100}))
  const categories=["host","technical","difficulty","taste"]
  for(const [puzzleId,score] of [["host-low",1],["host-high",5]])await store.upsertPlay(feedbackPlay(puzzleId,puzzleId,categories.map((category,index)=>({userId:`u${index}`,score,category,comment:"主持或体验问题",at:10}))))
  assert.deepEqual(generator.buildGenerationFeedback(),{high:[],low:[]})
  await store.updatePuzzle("aggregate-high",puzzle=>({...puzzle,manualScore:5,manualScoreReason:"线索和核心反转衔接公平"}))
  const manual=generator.buildGenerationFeedback()
  assert.equal(manual.high.length,1)
  assert.equal(manual.high[0].sampleCount,0)
  assert.equal(manual.high[0].playerScore,null)
  assert.equal(manual.low.length,0)
})

test("混合评分只按内容独立人数与内容均分达到反馈门槛，并按puzzleId关联",async t=>{
  const {store,generator}=setup(t)
  await store.savePuzzle(savedPuzzle("mixed",4,{title:"同名题",ratingCount:5,ratingSum:7}))
  await store.savePuzzle(savedPuzzle("another",4,{title:"同名题",ratingCount:3,ratingSum:15}))
  const content=[{userId:"a",score:2,category:"logic",comment:"动机不成立",at:10},{userId:"b",score:2,category:"hints",comment:"提示重复",at:10}]
  await store.upsertPlay(feedbackPlay("mixed","mixed",[...content,...["x","y","z"].map(userId=>({userId,score:1,category:"host",at:10}))]))
  await store.upsertPlay(feedbackPlay("another","another",["e","f","g"].map(userId=>({userId,score:5,category:"clues",at:10}))))
  let feedback=generator.buildGenerationFeedback()
  assert.equal(feedback.low.length,0,"两位内容差评不能用三位主持差评补样本")
  assert.equal(feedback.high.length,1,"同名不同id仍各自计算")
  await store.upsertPlay(feedbackPlay("third","mixed",[{userId:"c",score:2,category:"other",at:20}]))
  feedback=generator.buildGenerationFeedback()
  assert.equal(feedback.low.length,1)
  assert.equal(feedback.low[0].sampleCount,3)
  assert.equal(feedback.low[0].playerScore,2)
  assert.equal(feedback.high[0].playerScore,5)
})

test("重复玩家只使用最新票，后来的非内容评价替换早先内容票",async t=>{
  const {store,generator}=setup(t)
  await store.savePuzzle(savedPuzzle("repeated",4,{ratingCount:6,ratingSum:18}))
  const ratings=score=>["a","b","c"].map(userId=>({userId,score,category:"logic",comment:score===1?"旧批评":"修正好评",at:score===1?10:20}))
  await store.upsertPlay(feedbackPlay("old","repeated",ratings(1)))
  await store.upsertPlay(feedbackPlay("new","repeated",ratings(5)))
  let feedback=generator.buildGenerationFeedback()
  assert.equal(feedback.low.length,0)
  assert.equal(feedback.high[0].sampleCount,3)
  assert.equal(feedback.high[0].playerScore,5)
  assert.ok(feedback.high[0].comments.every(comment=>comment==="修正好评"))
  await store.upsertPlay(feedbackPlay("host-latest","repeated",[{userId:"a",score:1,category:"host",comment:"是主持问题",at:30}]))
  feedback=generator.buildGenerationFeedback()
  assert.deepEqual(feedback,{high:[],low:[]},"最新票先去重再分类，剩余两位内容票不够门槛")
})

test("主持固定事实含汤面，未知不否定；判题证据必须使用ID",()=>{
  const prompt=buildHostAnswerMessages({question:"他没有离开吗",surface:"他从未离开小屋",solution:"他在等待接班",facts:["没有离开"],keyPoints:["等接班"],history:[],asker:"u"})[0].content
  assert.match(prompt,/他从未离开小屋/)
  assert.match(prompt,/未知当否定/)
  assert.equal(parseHostAnswer("无法确定"),"无法确定")
  assert.equal(parseHostAnswer("我觉得应该是的"),"无法确定")
  assert.equal(parseGuessJudge('{"correct":true,"covered":["重复","重复"],"reason":"覆盖"}'),null)
  assert.deepEqual(parseGuessJudge('{"correct":true,"coveredIds":["kp1"],"contradictedIds":[],"reason":"已覆盖"}').coveredIds,["kp1"])
})


test("模型调用超时会取消请求并保留可恢复候选",async t=>{
  const {store}=setup(t)
  let calls=0,aborted=0
  const generator=new TurtleSoupGenerator({store,config:()=>config,modelTimeoutMs:10,retryDelayMs:0,callModel:async (_messages,options)=>{calls++;options.signal.addEventListener("abort",()=>aborted++);return new Promise(()=>{})}})
  await assert.rejects(generator.generateOne("normal"),/超时/)
  assert.equal(calls,2)
  assert.equal(aborted,2)
  assert.equal(store.readCandidates().candidates[0].failureKind,"technical")
})


test("关闭游戏不自动付费补货，管理员显式生成仍按原预算执行",async t=>{
  const {store,generator,calls}=setup(t,undefined,{enabled:false,generationCallBudget:3})
  assert.deepEqual(await generator.ensureFreshPool(),{added:0,failed:0,lastError:"disabled"})
  assert.equal(calls.length,0)
  await assert.rejects(generator.generateOne("normal"),/预算已用完/)
  assert.equal(calls.length,3)
  assert.equal(store.readCandidates().candidates[0].stage,"simulation")
})


test("不可修复审核立即停止后续模型调用，恢复不被技术故障分类绕过",async t=>{
  const {store,generator,calls}=setup(t,stage=>{
    if(stage==="playability")return fail("核心反转与已知题相同",false)
    if(stage==="logic")throw new Error("此处不应继续调用")
  })
  await assert.rejects(generator.generateOne("normal"),/核心反转/)
  assert.deepEqual(calls.map(call=>call.stage),["generation","playability"])
  const candidate=store.readCandidates().candidates[0]
  await store.updateCandidate(candidate.id,item=>({...item,failureKind:"technical",lastError:"后续逻辑接口故障",stage:"logic"}))
  const before=calls.length
  await assert.rejects(generator.recoverCandidate(candidate.id),/不可修复/)
  assert.equal(calls.length,before)
})
