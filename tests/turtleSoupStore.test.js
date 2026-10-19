import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {execFile,spawnSync} from 'node:child_process'
import {promisify} from 'node:util'
import {pathToFileURL} from 'node:url'
import {TurtleSoupStore, readTurtleSoupConfig} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js"
import {withFileLock} from '../dist/backend/modules/games/infrastructure/gameFiles.js'

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-soup-"))
  return {dir, store: new TurtleSoupStore({cwd: dir, baseDir: "data/turtle_soup"})}
}

const now = 1_700_000_000_000
function makePuzzle(id, overrides = {}) {
  return {id, title: `标题${id}`, surface: "汤面", solution: "汤底", keyPoints: ["关键点"], hints: ["提示一"], difficulty: "normal", tags: ["推理"], source: "ai", createdAt: now, status: "active", ratingSum: 0, ratingCount: 0, ...overrides}
}

test("store starts empty and round-trips puzzles, plays and sessions", async () => {
  const {dir, store} = makeStore()
  try {
    assert.deepEqual(store.readPuzzles(), {puzzles: []})
    await store.savePuzzle(makePuzzle("p1"))
    await store.savePuzzle(makePuzzle("p2"))
    await store.savePuzzle(makePuzzle("p1", {status: "retired", ratingSum: 9, ratingCount: 2}))
    const puzzles = store.readPuzzles().puzzles
    assert.equal(puzzles.length, 2)
    assert.equal(puzzles.find(item => item.id === "p1").status, "retired")
    assert.equal(puzzles.find(item => item.id === "p1").ratingSum, 9)

    const play = {playId: "pl1", puzzleId: "p1", puzzleTitle: "标题p1", groupId: "100", startedAt: now, endedAt: now + 1, endReason: "manual", solved: false, players: ["u1"], qaCount: 3, ratings: [{userId: "u1", score: 5, comment: "好玩", at: now}]}
    await store.upsertPlay(play)
    await store.upsertPlay({...play, solved: true, winnerId: "u1"})
    assert.equal(store.readPlays().plays.length, 1)
    assert.equal(store.readPlays().plays[0].winnerId, "u1")

    const session = {groupId: "100", phase: "playing", puzzleId: "p1", initiatorId: "u1", players: [{userId: "u1", nickname: "甲", joinedAt: now}], createdAt: now, joinDeadlineAt: now, startedAt: now, lastActivityAt: now, qaLog: [], guessLog: [], usedHints: 0, lastGuessAt: {}}
    await store.saveSession(session)
    assert.equal(store.readSessions().sessions["100"].phase, "playing")
    await store.removeSession("100")
    assert.deepEqual(store.readSessions().sessions, {})
    await store.removeSession("100")

    assert.equal(fs.existsSync(path.join(dir, "plugins/shiloh-plugin/data/turtle_soup/puzzles.json")), true)
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test("store rejects corrupted files instead of silently resetting data", async () => {
  const {dir, store} = makeStore()
  try {
    await store.savePuzzle(makePuzzle("p1"))
    fs.writeFileSync(path.join(store.dataDir, "puzzles.json"), "{ broken", "utf8")
    assert.throws(() => store.readPuzzles(), SyntaxError)
    fs.writeFileSync(path.join(store.dataDir, "puzzles.json"), JSON.stringify({puzzles: [{id: "p1"}]}), "utf8")
    assert.throws(() => store.readPuzzles(), /无效/)
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test("readTurtleSoupConfig reads miniGames.turtleSoup with defaults and clamping", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-soup-cfg-"))
  try {
    const configDir = path.join(dir, "plugins/shiloh-plugin/config_default")
    fs.mkdirSync(configDir, {recursive: true})
    let config = readTurtleSoupConfig(dir)
    assert.equal(config.enabled, true)
    assert.equal(config.minPlayers, 1)
    assert.equal(config.similarityHitThreshold, 0.9)
    assert.equal(config.similarityMissThreshold, 0)
    assert.equal(config.freshPoolTarget, 2)
    assert.equal(config.baseDir, "data/turtle_soup")

    fs.writeFileSync(path.join(configDir, "message.yaml"), [
      "pluginSettings:",
      "  miniGames:",
      "    enabled: true",
      "    turtleSoup:",
      "      enabled: true",
      "      minPlayers: 999",
      "      idleTimeoutMinutes: 3",
      "      generationModel: glm-4.7",
      "      contentPolicy: 自定义尺度"
    ].join("\n"), "utf8")
    config = readTurtleSoupConfig(dir)
    assert.equal(config.minPlayers, 50)
    assert.equal(config.idleTimeoutMinutes, 3)
    assert.equal(config.generationModel, "glm-4.7")
    assert.equal(config.contentPolicy, "自定义尺度")
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test('same directory is shared safely by concurrent store instances and processes', async t => {
  const {dir,store}=makeStore()
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const other=new TurtleSoupStore({cwd:dir,baseDir:'data/turtle_soup'})
  await Promise.all([store.savePuzzle(makePuzzle('one')),other.savePuzzle(makePuzzle('two'))])
  assert.deepEqual(new Set(store.readPuzzles().puzzles.map(p=>p.id)),new Set(['one','two']))
  const moduleUrl=pathToFileURL(path.resolve('dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js')).href
  const source=`import {TurtleSoupStore} from ${JSON.stringify(moduleUrl)};const store=new TurtleSoupStore({cwd:process.argv[1],baseDir:'data/turtle_soup'});const prefix=process.argv[2];for(let i=0;i<4;i++)await store.savePuzzle({id:prefix+i,title:prefix+i,surface:'surface',solution:'solution',keyPoints:[],hints:[],difficulty:'normal',source:'ai',createdAt:1,status:'pending',tags:[],ratingCount:0,ratingSum:0});`
  await Promise.all(['a','b','c'].map(prefix=>promisify(execFile)(process.execPath,['--input-type=module','-e',source,dir,prefix])))
  assert.equal(store.readPuzzles().puzzles.length,14)
})

test('rating transaction retains concurrent votes, counts unique players, and pauses low-rated content', async t=>{
  const {dir,store}=makeStore();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  await store.savePuzzle(makePuzzle('p'))
  for(const playId of ['first','second'])await store.upsertPlay({playId,puzzleId:'p',puzzleTitle:'p',groupId:playId,startedAt:1,endedAt:2,ratingDeadlineAt:500,solved:false,players:['a','b','c'],qaCount:0,ratings:[]})
  await Promise.all(['a','b','c'].map(userId=>store.recordRating({playId:'first',userId,score:1,atMs:10})))
  let p=store.readPuzzles().puzzles[0]
  assert.equal(p.ratingCount,3);assert.equal(p.ratingSum,3);assert.equal(p.status,'pending')
  assert.equal(store.readPlays().plays[0].ratings.length,3)
  await store.recordRating({playId:'second',userId:'a',score:5,atMs:20,category:'host',comment:'主持答错'})
  p=store.readPuzzles().puzzles[0]
  assert.equal(p.ratingCount,3);assert.equal(p.ratingSum,7)
  assert.equal(store.readPlays().plays[1].ratings[0].category,'host')
  await assert.rejects(()=>store.recordRating({playId:'first',userId:'a',score:5,atMs:500}),/窗口已结束/)
  await assert.rejects(()=>store.recordRating({playId:'first',userId:'outsider',score:5,atMs:100}),/参与者/)
})

test('committed multi-file journal is readable and recovered after an interrupted export', async t=>{
  const {dir,store}=makeStore();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  await store.savePuzzle(makePuzzle('old'))
  const state=store.readState()
  state.puzzles.push(makePuzzle('committed'))
  state.plays.push({playId:'play',puzzleId:'committed',puzzleTitle:'p',groupId:'g',startedAt:1,solved:false,players:[],qaCount:0,ratings:[]})
  fs.writeFileSync(path.join(store.dataDir,'transaction-journal.json'),JSON.stringify({revision:'recovered',state}))
  assert.equal(store.readPuzzles().puzzles.length,2)
  assert.equal(store.readPlays().plays.length,1)
  await store.updatePuzzle('committed',p=>({...p,manualScore:1,manualScoreReason:'contradiction'}))
  assert.equal(fs.existsSync(path.join(store.dataDir,'transaction-journal.json')),false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.dataDir,'plays.json'),'utf8')).plays.length,1)
  assert.equal(store.readPuzzles().puzzles.find(p=>p.id==='committed').manualScore,1)
})

test('an export failure after journal commit succeeds, remains readable and blocks writes until recovery',async t=>{
  const {dir,store}=makeStore();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  await store.savePuzzle(makePuzzle('old'))
  const blocked=path.join(store.dataDir,'plays.json')
  const result=await store.transaction(state=>{
    // Inject the export fault after the transaction has read its valid input.
    fs.unlinkSync(blocked);fs.mkdirSync(blocked)
    state.puzzles.push(makePuzzle('committed'))
    state.plays.push({playId:'committed-play',puzzleId:'committed',puzzleTitle:'p',groupId:'g',startedAt:1,solved:false,players:['u1'],qaCount:0,ratings:[]})
    return {saved:true}
  })
  assert.deepEqual(result,{saved:true})
  assert.equal(fs.existsSync(path.join(store.dataDir,'transaction-journal.json')),true)
  assert.equal(store.readState().puzzles.length,2)
  assert.equal(store.readState().plays[0].playId,'committed-play')
  await assert.rejects(()=>store.savePuzzle(makePuzzle('not-committed')))
  assert.equal(store.readPuzzles().puzzles.some(p=>p.id==='not-committed'),false)
  fs.rmdirSync(blocked)
  await store.savePuzzle(makePuzzle('after-recovery'))
  assert.equal(fs.existsSync(path.join(store.dataDir,'transaction-journal.json')),false)
  assert.equal(store.readPuzzles().puzzles.length,3)
  assert.equal(store.readPlays().plays[0].playId,'committed-play')
})

test('post-publish fsync and lock cleanup errors do not reject committed transactions',async t=>{
  const {dir,store}=makeStore();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  await store.savePuzzle(makePuzzle('initial'))
  const journal=path.join(store.dataDir,'transaction-journal.json'),lock=path.join(store.dataDir,'.state-lock')
  const originalSync=fs.fsyncSync,originalRemove=fs.rmSync
  let syncFault=false,cleanupFault=false
  try {
    fs.fsyncSync=function(fd){
      if(!syncFault&&fs.existsSync(journal)&&fs.fstatSync(fd).isDirectory()){
        syncFault=true;throw Object.assign(new Error('injected journal directory sync failure'),{code:'EIO'})
      }
      return originalSync.call(fs,fd)
    }
    await store.savePuzzle(makePuzzle('after-sync-fault'))
    assert.equal(syncFault,true)
    assert.equal(store.readPuzzles().puzzles.length,2)
    fs.fsyncSync=originalSync
    fs.rmSync=function(file,options){
      if(file===lock&&!cleanupFault){cleanupFault=true;throw Object.assign(new Error('injected lock cleanup failure'),{code:'EIO'})}
      return originalRemove.call(fs,file,options)
    }
    await store.savePuzzle(makePuzzle('after-cleanup-fault'))
    assert.equal(cleanupFault,true)
    assert.equal(store.readPuzzles().puzzles.length,3)
  }finally{
    fs.fsyncSync=originalSync;fs.rmSync=originalRemove
    fs.rmSync(lock,{recursive:true,force:true})
  }
  await store.savePuzzle(makePuzzle('subsequent'))
  assert.equal(store.readPuzzles().puzzles.length,4)
})

test('uncloneable transaction outcomes fail before publishing any state',async t=>{
  const {dir,store}=makeStore();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  await assert.rejects(()=>store.transaction(state=>{
    state.puzzles.push(makePuzzle('must-not-commit'))
    return ()=>undefined
  }),{name:'DataCloneError'})
  assert.equal(store.readPuzzles().puzzles.length,0)
  assert.equal(fs.existsSync(path.join(store.dataDir,'transaction-journal.json')),false)
})

test('candidate history, gameplay traces and strict puzzle status survive decoding', async t=>{
  const {dir,store}=makeStore();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const puzzle=makePuzzle('version',{familyId:'family',parentPuzzleId:'parent',version:2,contentHash:'hash',facts:['known fact'],keyPointIds:['k1'],requiredKeyPointIds:['k1'],manualScoreReason:'reason',audits:[{domain:'simulation',pass:true,reason:'ok',contentHash:'hash',version:2,at:1}]})
  await store.saveCandidate({id:'candidate',familyId:'family',status:'failed',stage:'simulation',failureKind:'technical',currentVersion:2,versions:[{version:2,contentHash:'hash',puzzle,audits:puzzle.audits,issues:[],createdAt:1}],createdAt:1,updatedAt:2})
  assert.deepEqual(store.readCandidates().candidates[0].versions[0].puzzle,puzzle)
  await assert.rejects(()=>store.savePuzzle(makePuzzle('bad',{status:'typo'})),/状态无效/)
  fs.writeFileSync(path.join(store.dataDir,'rejected.jsonl'),JSON.stringify({title:'legacy',surface:'surface',solution:'solution',keyPoints:['point'],holes:['repair this'],at:1})+'\n{truncated')
  const legacy=store.readCandidates().candidates.find(c=>c.id.startsWith('legacy_'))
  assert.ok(legacy);assert.deepEqual(legacy.versions[0].puzzle.hints,[])
  await store.saveCandidate({...legacy,status:'recovered',recoveredPuzzleId:'new'})
  assert.equal(store.readCandidates().candidates.filter(c=>c.id===legacy.id).length,1)
})

test('legacy running sessions expose their players immediately before round completion',async t=>{
  const {dir,store}=makeStore();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  await store.savePuzzle(makePuzzle('old',{familyId:'story-family'}))
  await store.upsertPlay({playId:'legacy-play',puzzleId:'old',puzzleTitle:'old',groupId:'g',startedAt:10,solved:false,players:[],qaCount:0,ratings:[]})
  // Write the old layout directly to reproduce a process restarting mid-game.
  fs.writeFileSync(path.join(store.dataDir,'sessions.json'),JSON.stringify({sessions:{g:{groupId:'g',phase:'playing',puzzleId:'old',initiatorId:'alice',players:[{userId:'alice',nickname:'Alice',joinedAt:1}],createdAt:1,joinDeadlineAt:2,startedAt:10,lastActivityAt:10,qaLog:[],guessLog:[],usedHints:0,lastGuessAt:{},surrendered:{bob:{at:11,delivered:true}}}}}))
  const play=new TurtleSoupStore({cwd:dir,baseDir:'data/turtle_soup'}).readPlays().plays[0]
  assert.equal(play.endedAt,undefined)
  assert.deepEqual(new Set(play.players),new Set(['alice','bob']))
  assert.equal(play.familyId,'story-family')
})

test('plugin and host roots resolve the same effective config, including legacy fields and global switch', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'soup-root-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const plugin=path.join(dir,'plugins/shiloh-plugin');fs.mkdirSync(path.join(plugin,'config'),{recursive:true})
  fs.writeFileSync(path.join(plugin,'config/message.yaml'),'pluginSettings:\n  turtleSoup:\n    hintCooldownSeconds: 7\n  miniGames:\n    enabled: false\n    turtleSoup:\n      enabled: true\n      freshPoolTarget: 9\n      generationCallBudget: 12\n      baseDir: custom/soup\n')
  const hostConfig=readTurtleSoupConfig(dir),pluginConfig=readTurtleSoupConfig(plugin)
  assert.deepEqual(hostConfig,pluginConfig)
  assert.equal(hostConfig.enabled,false);assert.equal(hostConfig.freshPoolTarget,9);assert.equal(hostConfig.generationCallBudget,12);assert.equal(hostConfig.hintCooldownSeconds,7)
  assert.equal(new TurtleSoupStore({cwd:dir,baseDir:hostConfig.baseDir}).dataDir,new TurtleSoupStore({cwd:plugin,baseDir:pluginConfig.baseDir}).dataDir)
  fs.writeFileSync(path.join(plugin,'package.json'),JSON.stringify({name:'shiloh-plugin'}))
  const staleNested=path.join(plugin,'plugins/shiloh-plugin/config')
  fs.mkdirSync(staleNested,{recursive:true})
  fs.writeFileSync(path.join(staleNested,'message.yaml'),'pluginSettings:\n  miniGames:\n    turtleSoup:\n      freshPoolTarget: 1\n')
  assert.deepEqual(readTurtleSoupConfig(plugin),hostConfig,'an old nested data directory must not shadow the plugin itself')
})

test('dead lock owners and abandoned recovery locks recover without stealing a live long-running generation', async t=>{
  const {dir,store}=makeStore();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const lock=path.join(store.dataDir,'.generation-lock')
  const deadPid=spawnSync(process.execPath,['-e','']).pid
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:deadPid,token:'crashed'}))
  const recovery=lock+'.recovery'
  fs.mkdirSync(recovery)
  fs.utimesSync(recovery,new Date(0),new Date(0))
  assert.equal(await withFileLock(lock,()=>42,200),42)
  assert.equal(fs.existsSync(lock),false)
  assert.equal(fs.existsSync(recovery),false)

  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,token:'reused-pid',processIdentity:'a-previous-process-lifetime'}))
  assert.equal(await withFileLock(lock,()=>43,200),43)
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,token:'legacy-reused-pid'}))
  fs.utimesSync(lock,new Date(0),new Date(0))
  assert.equal(await withFileLock(lock,()=>44,200),44)

  let release,entered
  const held=new Promise(resolve=>{release=resolve})
  const ready=new Promise(resolve=>{entered=resolve})
  const owner=withFileLock(lock,()=>{entered();return held})
  await ready
  fs.utimesSync(lock,new Date(0),new Date(0))
  try {await assert.rejects(()=>withFileLock(lock,()=>assert.fail('live owner must retain lock'),60),/生成任务进行中/)}
  finally {release();await owner}

  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:deadPid,token:'crashed-again'}))
  fs.mkdirSync(recovery)
  fs.writeFileSync(path.join(recovery,'owner.json'),JSON.stringify({pid:process.pid,token:'recovering'}))
  await assert.rejects(()=>withFileLock(lock,()=>assert.fail('live recovery must retain lock'),60),/生成任务进行中/)
})
