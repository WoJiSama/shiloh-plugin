// 海龟汤数据存取:puzzles/plays/sessions 三份JSON,读走严格解码,写走原子落盘。
import path from 'node:path'
import fs from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import type {TurtleSoupConfig, TurtleSoupPuzzle, TurtleSoupPuzzleFile, TurtleSoupPlay, TurtleSoupPlayFile, TurtleSoupSession, TurtleSoupSessionFile, TurtleSoupCandidate, TurtleSoupCandidateFile, TurtleSoupState, TurtleSoupFeedbackCategory} from '../../../../contracts/turtleSoup.js'
import {decodeMiniGamesSettings, ensureDir, readPluginSettings, resolveDataDir, withFileLock, writeAtomicJson} from '../gameFiles.js'
import {decodeTurtleSoupPlayFile, decodeTurtleSoupPuzzleFile, decodeTurtleSoupSessionFile, decodeTurtleSoupCandidateFile, decodeTurtleSoupCandidate} from '../../domain/turtleSoup/turtleSoupSchema.js'

const DEFAULT_CONTENT_POLICY = "题材保持本格推理趣味,可以悬疑惊悚,但避免直白血腥、猎奇虐待细节与涉政内容"
const safeNumber=(value:unknown, fallback:number, min:number, max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.min(max, Math.max(min, value)):fallback
const safeText=(value:unknown, fallback:string)=>typeof value==='string'&&value.trim()?value.trim():fallback

export function readTurtleSoupConfig(cwd:string):TurtleSoupConfig {
  return resolveTurtleSoupConfig(readPluginSettings(cwd))
}

export function resolveTurtleSoupConfig(settings:Record<string,unknown>):TurtleSoupConfig {
  const {enabled,turtleSoup} = decodeMiniGamesSettings(settings)
  return {
    enabled: enabled && turtleSoup.enabled !== false,
    minPlayers: Math.floor(safeNumber(turtleSoup.minPlayers, 1, 1, 50)),
    joinWindowMinutes: Math.floor(safeNumber(turtleSoup.joinWindowMinutes, 5, 1, 60)),
    idleTimeoutMinutes: Math.floor(safeNumber(turtleSoup.idleTimeoutMinutes, 5, 1, 240)),
    guessCooldownSeconds: Math.floor(safeNumber(turtleSoup.guessCooldownSeconds, 30, 0, 3600)),
    similarityHitThreshold: safeNumber(turtleSoup.similarityHitThreshold, 0.9, 0.5, 1),
    similarityMissThreshold: safeNumber(turtleSoup.similarityMissThreshold, 0, 0, 0.9),
    freshPoolTarget: Math.floor(safeNumber(turtleSoup.freshPoolTarget, 2, 1, 50)),
    generationModel: safeText(turtleSoup.generationModel, ""),
    ratingWindowMinutes: Math.floor(safeNumber(turtleSoup.ratingWindowMinutes, 5, 1, 120)),
    maxHints: Math.floor(safeNumber(turtleSoup.maxHints, 3, 0, 10)),
    recapEveryQuestions: Math.floor(safeNumber(turtleSoup.recapEveryQuestions, 10, 0, 100)),
    chooseWindowSeconds: Math.floor(safeNumber(turtleSoup.chooseWindowSeconds, 60, 10, 300)),
    contentPolicy: safeText(turtleSoup.contentPolicy, DEFAULT_CONTENT_POLICY),
    baseDir: safeText(turtleSoup.baseDir, "data/turtle_soup"),
    hintCooldownSeconds: Math.floor(safeNumber(turtleSoup.hintCooldownSeconds,15,0,300)),
    generationCallBudget: Math.floor(safeNumber(turtleSoup.generationCallBudget,18,4,100)),
    maxPending: Math.floor(safeNumber(turtleSoup.maxPending,Math.max(4,safeNumber(turtleSoup.freshPoolTarget,2,1,50)*2),1,100)),
    reviewModel: safeText(turtleSoup.reviewModel,'')
  }
}

export class TurtleSoupStore {
  readonly dataDir:string
  constructor({cwd = process.cwd(), baseDir = "data/turtle_soup"}:{cwd?:string;baseDir?:string} = {}) {
    this.dataDir = resolveDataDir(cwd, baseDir)
    ensureDir(this.dataDir)
  }

  private readJson(name:string,fallback:unknown):unknown {
    try {return JSON.parse(fs.readFileSync(path.join(this.dataDir,name),'utf8'))}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw error}
  }

  private decodeState(raw:unknown):TurtleSoupState {
    if(!raw||typeof raw!=='object')throw new Error('海龟汤事务快照无效')
    const state=raw as TurtleSoupState
    return {puzzles:decodeTurtleSoupPuzzleFile({puzzles:state.puzzles}).puzzles,plays:decodeTurtleSoupPlayFile({plays:state.plays}).plays,sessions:decodeTurtleSoupSessionFile({sessions:state.sessions}).sessions,candidates:decodeTurtleSoupCandidateFile({candidates:state.candidates}).candidates}
  }

  private journal():{revision:string;state:TurtleSoupState}|null {
    const value=this.readJson('transaction-journal.json',null) as {revision:string;state:unknown}|null
    return value?{revision:value.revision,state:this.decodeState(value.state)}:null
  }

  // Reading the journal before/after the files and comparing the revision prevents
  // a cross-process reader from observing half of a committed multi-file update.
  readState():TurtleSoupState {
    for(let attempt=0;attempt<20;attempt++){
      const before=JSON.stringify(this.readJson('revision.json',null))
      const pending=this.journal()
      if(pending)return this.withLegacyData(pending.state)
      const state:TurtleSoupState={puzzles:decodeTurtleSoupPuzzleFile(this.readJson('puzzles.json',{puzzles:[]})).puzzles,plays:decodeTurtleSoupPlayFile(this.readJson('plays.json',{plays:[]})).plays,sessions:decodeTurtleSoupSessionFile(this.readJson('sessions.json',{sessions:{}})).sessions,candidates:decodeTurtleSoupCandidateFile(this.readJson('candidates.json',{candidates:[]})).candidates}
      const committed=this.journal()
      if(committed)return this.withLegacyData(committed.state)
      if(before===JSON.stringify(this.readJson('revision.json',null)))return this.withLegacyData(state)
    }
    throw new Error('海龟汤数据正在更新，请稍后重试')
  }

  private withLegacyData(state:TurtleSoupState):TurtleSoupState {
    // Older running games wrote an empty exposure list until the round ended.
    // Derive it from their persisted session immediately, including after a
    // restart, so another group cannot serve the same family in the meantime.
    for(const session of Object.values(state.sessions).filter(item=>item.phase==='playing')){
      const play=state.plays.filter(item=>session.playId?item.playId===session.playId:item.groupId===session.groupId&&item.puzzleId===session.puzzleId&&item.endedAt===undefined).sort((a,b)=>b.startedAt-a.startedAt)[0]
      if(!play)continue
      play.players=[...new Set([...play.players,...(session.participantHistory||session.players).map(player=>player.userId),...session.players.map(player=>player.userId),...Object.keys(session.surrendered)])]
      const puzzle=state.puzzles.find(item=>item.id===play.puzzleId)
      if(!play.familyId&&puzzle)play.familyId=puzzle.familyId||puzzle.parentPuzzleId||puzzle.id
    }
    let text:string
    try {text=fs.readFileSync(path.join(this.dataDir,'rejected.jsonl'),'utf8')}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return state;throw error}
    const ids=new Set(state.candidates.map(item=>item.id))
    for(const line of text.split('\n').filter(line=>line.trim())){
      try {
        const id=`legacy_${createHash('sha256').update(line).digest('hex').slice(0,24)}`
        if(ids.has(id))continue
        const entry=JSON.parse(line) as Record<string,unknown>,at=typeof entry.at==='number'?entry.at:0
        const issues=Array.isArray(entry.holes)?entry.holes.filter((v):v is string=>typeof v==='string'):[]
        const puzzle={...entry,id,familyId:id,version:1,status:'pending',source:'ai',createdAt:at,ratingCount:0,ratingSum:0,hints:Array.isArray(entry.hints)?entry.hints:[],tags:Array.isArray(entry.tags)?entry.tags:[],keyPoints:Array.isArray(entry.keyPoints)?entry.keyPoints:[]}
        const versions=entry.title&&entry.surface&&entry.solution?[{version:1,contentHash:'',puzzle,audits:[],issues,createdAt:at}]:[]
        const candidate=decodeTurtleSoupCandidate({id,familyId:id,status:'failed',stage:'logic',failureKind:'content',currentVersion:versions.length,versions,repairReason:issues.join(';'),lastError:issues.join(';'),createdAt:at,updatedAt:at,rawOutput:line})
        state.candidates.push(candidate);ids.add(id)
      } catch { /* Older append-only logs may contain a truncated final record. */ }
    }
    return state
  }

  private materialize(revision:string,state:TurtleSoupState):void {
    writeAtomicJson(path.join(this.dataDir,'puzzles.json'),{puzzles:state.puzzles})
    writeAtomicJson(path.join(this.dataDir,'plays.json'),{plays:state.plays})
    writeAtomicJson(path.join(this.dataDir,'sessions.json'),{sessions:state.sessions})
    writeAtomicJson(path.join(this.dataDir,'candidates.json'),{candidates:state.candidates})
    writeAtomicJson(path.join(this.dataDir,'revision.json'),{revision})
    fs.unlinkSync(path.join(this.dataDir,'transaction-journal.json'))
  }

  async transaction<Result>(operation:(state:TurtleSoupState)=>Result):Promise<Result> {
    let committed:{outcome:Result}|undefined
    try {
      return await withFileLock(path.join(this.dataDir,'.state-lock'),()=>{
        const recovery=this.journal()
        if(recovery)this.materialize(recovery.revision,recovery.state)
        const state=this.readState(),result=operation(state)
        if(result&&typeof (result as {then?:unknown}).then==='function')throw new Error('海龟汤事务回调必须同步完成')
        const normalized=this.decodeState(state),revision=randomUUID(),outcome=structuredClone(result)
        try {writeAtomicJson(path.join(this.dataDir,'transaction-journal.json'),{revision,state:normalized})}
        catch(error){
          // A directory fsync/close may fail after rename already published it.
          // Only this transaction's complete revision counts as committed.
          if(this.journal()?.revision!==revision)throw error
        }
        committed={outcome}
        this.materialize(revision,normalized)
        return outcome
      })
    } catch(error){
      // Once published, the journal is authoritative. Export or lock cleanup
      // failures cannot turn that accepted state into a rejected transaction.
      // Reads retain the journal; recovery must finish before the next write.
      if(committed)return committed.outcome
      throw error
    }
  }

  withGenerationLock<Result>(operation:()=>Promise<Result>):Promise<Result> {return withFileLock(path.join(this.dataDir,'.generation-lock'),operation)}

  readPuzzles():TurtleSoupPuzzleFile {return {puzzles:this.readState().puzzles}}
  readPlays():TurtleSoupPlayFile {return {plays:this.readState().plays}}
  readSessions():TurtleSoupSessionFile {return {sessions:this.readState().sessions}}
  readCandidates():TurtleSoupCandidateFile {return {candidates:this.readState().candidates}}
  async writePuzzles(file:TurtleSoupPuzzleFile):Promise<void>{await this.transaction(state=>{state.puzzles=file.puzzles})}
  async writePlays(file:TurtleSoupPlayFile):Promise<void>{await this.transaction(state=>{state.plays=file.plays})}
  async writeSessions(file:TurtleSoupSessionFile):Promise<void>{await this.transaction(state=>{state.sessions=file.sessions})}
  async savePuzzle(puzzle:TurtleSoupPuzzle):Promise<void>{await this.transaction(state=>{const index=state.puzzles.findIndex(p=>p.id===puzzle.id);if(index>=0)state.puzzles[index]=puzzle;else state.puzzles.push(puzzle)})}
  async upsertPlay(play:TurtleSoupPlay):Promise<void>{await this.transaction(state=>{const index=state.plays.findIndex(p=>p.playId===play.playId);if(index>=0)state.plays[index]=play;else state.plays.push(play)})}
  async saveSession(session:TurtleSoupSession):Promise<void>{await this.transaction(state=>{state.sessions[session.groupId]=session})}
  async removeSession(groupId:string):Promise<void>{await this.transaction(state=>{delete state.sessions[groupId]})}
  async saveCandidate(candidate:TurtleSoupCandidate):Promise<void>{await this.transaction(state=>{const index=state.candidates.findIndex(c=>c.id===candidate.id);if(index>=0)state.candidates[index]=candidate;else state.candidates.push(candidate)})}
  updatePuzzle(id:string,update:(puzzle:TurtleSoupPuzzle)=>TurtleSoupPuzzle):Promise<TurtleSoupPuzzle>{return this.transaction(state=>{const index=state.puzzles.findIndex(p=>p.id===id);if(index<0)throw Object.assign(new Error('题目不存在'),{status:404});const result=update(state.puzzles[index]!);if(result.id!==id)throw new Error('不可变更题目ID');state.puzzles[index]=result;return result})}
  updatePlay(id:string,update:(play:TurtleSoupPlay)=>TurtleSoupPlay):Promise<TurtleSoupPlay>{return this.transaction(state=>{const index=state.plays.findIndex(p=>p.playId===id);if(index<0)throw Object.assign(new Error('游玩记录不存在'),{status:404});const result=update(state.plays[index]!);if(result.playId!==id)throw new Error('不可变更游玩ID');state.plays[index]=result;return result})}
  updateCandidate(id:string,update:(candidate:TurtleSoupCandidate)=>TurtleSoupCandidate):Promise<TurtleSoupCandidate>{return this.transaction(state=>{const index=state.candidates.findIndex(c=>c.id===id);if(index<0)throw Object.assign(new Error('候选不存在'),{status:404});const result=update(state.candidates[index]!);if(result.id!==id)throw new Error('不可变更候选ID');state.candidates[index]=result;return result})}

  recordRating(input:{playId:string;userId:string;score:number;comment?:string;category?:TurtleSoupFeedbackCategory;atMs:number;ratingDeadlineAt?:number}):Promise<{play:TurtleSoupPlay;puzzle:TurtleSoupPuzzle;retired:boolean}> {
    return this.transaction(state=>{
      const play=state.plays.find(p=>p.playId===input.playId)
      if(!play||play.endedAt===undefined)throw new Error('本局尚未结束')
      if(!play.players.includes(input.userId))throw new Error('仅本局参与者可评分')
      const deadline=play.ratingDeadlineAt??input.ratingDeadlineAt??play.endedAt+5*60_000
      if(input.atMs>=deadline)throw new Error('评分窗口已结束')
      if(!Number.isInteger(input.score)||input.score<1||input.score>5)throw new Error('评分必须是1-5的整数')
      const puzzle=state.puzzles.find(p=>p.id===play.puzzleId)
      if(!puzzle)throw new Error('题目不存在')
      const rating={userId:input.userId,score:input.score,at:input.atMs,...(input.comment?{comment:input.comment.slice(0,1000)}:{}),...(input.category?{category:input.category}:{})}
      play.ratings=play.ratings.filter(r=>r.userId!==input.userId).concat(rating)
      const latest=new Map<string,TurtleSoupPlay['ratings'][number]>()
      for(const entry of state.plays.filter(p=>p.puzzleId===puzzle.id))for(const vote of entry.ratings){const previous=latest.get(vote.userId);if(!previous||vote.at>=previous.at)latest.set(vote.userId,vote)}
      const votes=[...latest.values()]
      puzzle.ratingCount=votes.length;puzzle.ratingSum=votes.reduce((sum,vote)=>sum+vote.score,0)
      const retired=puzzle.status==='active'&&votes.length>=3&&puzzle.ratingSum/votes.length<3
      if(retired){
        puzzle.status='pending'
        puzzle.statusHistory=[...(puzzle.statusHistory||[]),{from:'active',to:'pending',reason:'至少三位独立玩家均分低于3，暂停投放待复核',actor:'player-feedback',at:input.atMs,contentHash:puzzle.contentHash||''}]
      }
      return {play,puzzle,retired}
    })
  }
}
