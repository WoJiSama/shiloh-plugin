// Persist each candidate revision before reviewing it. All entry points share the store's generation lease.
import type {TurtleSoupLogger, TurtleSoupPuzzle, TurtleSoupConfig, TurtleSoupAuditRecord, TurtleSoupCandidate, TurtleSoupCandidateVersion, TurtleSoupRating} from '../../../../contracts/turtleSoup.js'
import fs from 'node:fs'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import type {ChatMessage} from '../../../../contracts/modelGateway.js'
import {buildPuzzleGenerationMessages, buildPuzzleReviewMessages, parseGeneratedPuzzle, parsePuzzleReview, buildLogicAuditMessages, parseLogicAudit, buildPuzzleRepairMessages, buildPuzzleSimulationMessages, parsePuzzleSimulation} from '../../domain/turtleSoup/turtleSoupPrompts.js'
import type {GenerationFeedbackItem, ParsedReview} from '../../domain/turtleSoup/turtleSoupPrompts.js'
import {auditPuzzleStructure, freshPuzzleIds, pendingPuzzleIds, puzzlePlayStats} from '../../domain/turtleSoup/turtleSoupRules.js'
import {comparablePuzzles, duplicatePuzzle, puzzleContentHash, puzzleFamilyId, hasCurrentPassingAudits} from '../../domain/turtleSoup/turtleSoupQuality.js'
import type {TurtleSoupStore} from './TurtleSoupStore.js'

export interface TurtleSoupModelCallOptions {model?:string|undefined;temperature?:number|undefined;signal?:AbortSignal|undefined}
export type TurtleSoupModelCall = (messages:ChatMessage[], options?:TurtleSoupModelCallOptions) => Promise<string>
export interface TurtleSoupGeneratorPorts {store:TurtleSoupStore;config:() => TurtleSoupConfig;callModel:TurtleSoupModelCall;logger?:TurtleSoupLogger;now?:() => number;random?:() => number;modelTimeoutMs?:number;retryDelayMs?:number}
export interface GenerateOutcome {added:number;failed:number;lastError:string|undefined}
type Difficulty = 'easy'|'normal'|'hard'
type Stage = TurtleSoupCandidate['stage']
interface Budget {used:number;limit:number}
interface RunContext {candidate?:TurtleSoupCandidate;budget:Budget;shared?:Budget}
class PipelineFailure extends Error {constructor(readonly kind:'technical'|'content', message:string, readonly repairable = true) {super(message)}}
const errorMessage = (error:unknown) => error instanceof Error ? error.message : String(error)
const difficulties:Difficulty[] = ['easy', 'normal', 'hard']
const themes = ['日常误会', '职业与规则', '家庭与记忆', '旅途与空间', '物件与时间', '社会关系']

export class TurtleSoupGenerator {
  private readonly ports:TurtleSoupGeneratorPorts
  private generating = false
  private sequence = 0
  constructor(ports:TurtleSoupGeneratorPorts) { this.ports = ports }
  get busy() { return this.generating }

  freshCount():number {
    const {puzzles} = this.ports.store.readPuzzles()
    return freshPuzzleIds(puzzles, puzzlePlayStats(this.ports.store.readPlays().plays, puzzles)).length
  }
  readyFreshCount():number { return this.freshCount() + pendingPuzzleIds(this.ports.store.readPuzzles().puzzles).length }

  async ensureFreshPool():Promise<GenerateOutcome> {
    if (!this.ports.config().enabled) return {added: 0, failed: 0, lastError: 'disabled'}
    if (this.generating) return {added: 0, failed: 0, lastError: 'busy'}
    return this.lock(async () => {
      const target = this.ports.config().freshPoolTarget
      const pendingLimit = this.ports.config().maxPending || Math.max(4, target * 2)
      const budget:Budget = {used: 0, limit: Math.min(48, pendingLimit * this.callBudget())}
      let added = 0, failed = 0, lastError:string|undefined
      while (this.ports.config().enabled && this.freshCount() < target && pendingPuzzleIds(this.ports.store.readPuzzles().puzzles).length < pendingLimit && added + failed < pendingLimit) {
        try { await this.runCandidate(this.createCandidate(), budget); added++ }
        catch (error) {
          failed++; lastError = errorMessage(error)
          this.ports.logger?.warn?.(`[海龟汤] 补货未完成: ${lastError}`)
          // A broken service/format should not drain a pool-sized retry multiplier.
          if (!(error instanceof PipelineFailure) || error.kind === 'technical') break
        }
      }
      if (this.freshCount() < target && pendingPuzzleIds(this.ports.store.readPuzzles().puzzles).length >= pendingLimit) {
        lastError = '可玩鲜汤不足，待审队列已满，请管理员审核后继续补货'
        this.ports.logger?.warn?.(`[海龟汤] ${lastError}`)
      }
      return {added, failed, lastError}
    }).catch(error => {
      if (/busy|生成任务.*进行|生成锁|generation.*lock/i.test(errorMessage(error))) return {added: 0, failed: 0, lastError: 'busy'}
      throw error
    })
  }

  async seed(count:number, difficulty?:Difficulty):Promise<GenerateOutcome> {
    if (this.generating) return {added: 0, failed: 0, lastError: 'busy'}
    return this.lock(async () => {
      const total = Math.max(1, Math.min(20, Math.floor(count) || 1))
      const budget:Budget = {used: 0, limit: Math.min(120, total * this.callBudget())}
      let added = 0, failed = 0, lastError:string|undefined
      for (let index = 0; index < total; index++) {
        try { await this.runCandidate(this.createCandidate(difficulty), budget); added++ }
        catch (error) {
          failed++; lastError = errorMessage(error)
          if (!(error instanceof PipelineFailure) || error.kind === 'technical') {
            failed += total - index - 1
            break
          }
        }
      }
      return {added, failed, lastError}
    }).catch(error => {
      if (/busy|生成任务.*进行|生成锁|generation.*lock/i.test(errorMessage(error))) return {added: 0, failed: 0, lastError: 'busy'}
      throw error
    })
  }

  generateOne(difficulty?:Difficulty):Promise<TurtleSoupPuzzle> { return this.lock(() => this.runCandidate(this.createCandidate(difficulty))) }

  repairPuzzle(id:string, reason?:string):Promise<TurtleSoupPuzzle> {
    return this.lock(async () => {
      const puzzle = this.ports.store.readPuzzles().puzzles.find(item => item.id === id)
      if (!puzzle) throw new Error('题目不存在')
      const candidate = this.createCandidate(difficulties.includes(puzzle.difficulty as Difficulty) ? puzzle.difficulty as Difficulty : 'normal', puzzle)
      candidate.repairReason = reason?.trim() || puzzle.manualScoreReason || this.feedbackFor(puzzle).comments.join(';') || '重新检查公平线索、固定事实、关键点和递进提示，修复质量问题'
      candidate.stage = 'repair'
      return this.runCandidate(candidate, undefined, true)
    })
  }

  recoverCandidate(id:string):Promise<TurtleSoupPuzzle> {
    return this.lock(async () => {
      const candidate = this.ports.store.readCandidates().candidates.find(item => item.id === id)
      if (!candidate) throw new Error('候选不存在')
      if (candidate.recoveredPuzzleId) {
        const existing = this.ports.store.readPuzzles().puzzles.find(item => item.id === candidate.recoveredPuzzleId)
        if (existing) return existing
      }
      const latest = candidate.versions.at(-1)
      if (latest?.audits.some(audit => !audit.pass && audit.repairable === false)) throw new Error('该候选存在不可修复或重复的核心机制，请参考失败教训生成新题')
      const repairFirst = !!latest && (candidate.stage === 'repair' || candidate.failureKind === 'content' || latest.issues.length > 0 || latest.puzzle.hints.length < 3)
      return this.runCandidate(candidate, undefined, repairFirst)
    })
  }

  /** Shared by admin re-review. Passing evidence is bound to this exact content. */
  auditPuzzle(puzzle:TurtleSoupPuzzle):Promise<TurtleSoupAuditRecord[]> {
    return this.lock(async () => {
      const context:RunContext = {budget: {used: 0, limit: 8}}
      const revision:TurtleSoupCandidateVersion = {version: puzzle.version || 1, contentHash: puzzleContentHash(puzzle), puzzle, audits: [], issues: [], createdAt: this.now()}
      await this.auditVersion(revision, context)
      return revision.audits
    })
  }

  buildGenerationFeedback():{high:GenerationFeedbackItem[];low:GenerationFeedbackItem[]} {
    const plays = this.ports.store.readPlays().plays
    const scored = this.ports.store.readPuzzles().puzzles.map(puzzle => {
      const ratings = this.contentRatings(plays.filter(play => play.puzzleId === puzzle.id).flatMap(play => play.ratings))
      return {feedback: this.feedbackFor(puzzle, ratings), praise: this.commentsFrom(ratings, true)}
    })
    return {
      high: scored.filter(({feedback:item}) => (item.sampleCount! >= 3 && (item.playerScore ?? 0) >= 4) || ((item.manualScore ?? 0) >= 4 && !!item.manualReason)).sort((a, b) => b.feedback.score - a.feedback.score).slice(0, 5).map(item => ({...item.feedback, comments: item.praise})),
      low: scored.map(item => item.feedback).filter(item => (item.sampleCount! >= 3 && (item.playerScore ?? 5) < 3.5) || ((item.manualScore ?? 5) <= 3 && !!item.manualReason)).sort((a, b) => a.score - b.score).slice(0, 5)
    }
  }

  readRejectionLessons():{title:string;holes:string[]}[] {
    const candidates = this.ports.store.readCandidates().candidates
    const lessons = candidates.filter(item => item.failureKind === 'content').sort((a, b) => b.updatedAt - a.updatedAt).map(item => ({title: item.versions.at(-1)?.puzzle.title || item.id, holes: item.versions.at(-1)?.issues || [item.lastError || '内容未通过']}))
    // Keep old append-only archives readable; malformed/truncated lines cannot poison feedback.
    try {
      for (const line of fs.readFileSync(path.join(this.ports.store.dataDir, 'rejected.jsonl'), 'utf8').split('\n').reverse()) {
        try {
          const item = JSON.parse(line) as {title?:unknown;holes?:unknown}
          if (typeof item.title === 'string' && Array.isArray(item.holes)) lessons.push({title: item.title, holes: item.holes.filter((hole):hole is string => typeof hole === 'string')})
        } catch {}
      }
    } catch {}
    const seen = new Set<string>()
    return lessons.filter(item => { if (seen.has(item.title) || !item.holes.length) return false; seen.add(item.title); return true }).slice(0, 8)
  }

  duplicatesExisting(candidate:TurtleSoupPuzzle, puzzles:TurtleSoupPuzzle[]):boolean { return !!duplicatePuzzle(candidate, puzzles) }

  private createCandidate(difficulty?:Difficulty, source?:TurtleSoupPuzzle):TurtleSoupCandidate {
    const now = this.now(), id = `candidate_${randomUUID()}`
    const candidate:TurtleSoupCandidate = {id, familyId: source ? puzzleFamilyId(source) : id, status: 'draft', stage: 'generation', requestedDifficulty: difficulty || this.diversity().difficulty, currentVersion: 0, versions: [], createdAt: now, updatedAt: now, modelCalls: 0}
    if (source) {
      candidate.sourcePuzzleId = source.id
      candidate.model = this.ports.config().generationModel || source.model || '主模型'
      candidate.currentVersion = source.version || 1
      candidate.versions.push({version: candidate.currentVersion, contentHash: puzzleContentHash(source), puzzle: source, audits: [], issues: [], createdAt: now})
    }
    return candidate
  }

  private async runCandidate(candidate:TurtleSoupCandidate, shared?:Budget, forceRepair = false):Promise<TurtleSoupPuzzle> {
    const context:RunContext = {candidate, budget: {used: 0, limit: this.callBudget()}, ...(shared ? {shared} : {})}
    candidate.status = 'draft'
    candidate.attempts = (candidate.attempts || 0) + 1
    delete candidate.lastError
    delete candidate.failureKind
    await this.persist(candidate)
    let repairs = 0
    try {
      if (!candidate.versions.length) {
        const puzzles = this.ports.store.readPuzzles().puzzles, diversity = this.diversity()
        const puzzle = await this.callStage('generation', buildPuzzleGenerationMessages({contentPolicy: this.ports.config().contentPolicy, avoidTitles: puzzles.map(item => item.title).slice(-60), ...(candidate.requestedDifficulty ? {difficulty: candidate.requestedDifficulty} : {}), preferredTheme: diversity.theme, avoidMechanisms: puzzles.slice(-16).map(item => item.mechanism || '').filter(Boolean), feedback: this.buildGenerationFeedback(), rejectionLessons: this.readRejectionLessons()}), text => this.parsePuzzle(text), context, 0.9)
        await this.appendVersion(candidate, puzzle)
      }
      while (true) {
        let revision = candidate.versions.at(-1)!
        if (forceRepair || revision.issues.length) {
          if (repairs >= 2) throw new PipelineFailure('content', `审核未通过(含两轮修复): ${revision.issues.join(';') || candidate.repairReason}`)
          repairs++
          const issues = [...revision.issues, ...(candidate.repairReason ? [candidate.repairReason] : [])]
          const repaired = await this.callStage('repair', buildPuzzleRepairMessages(revision.puzzle, issues, {contentPolicy: this.ports.config().contentPolicy, ...(candidate.requestedDifficulty ? {difficulty: candidate.requestedDifficulty} : {})}), text => this.parsePuzzle(text), context, 0.3)
          await this.appendVersion(candidate, repaired)
          forceRepair = false
          revision = candidate.versions.at(-1)!
        }
        if (revision.issues.length) continue
        const result = await this.auditVersion(revision, context)
        await this.persist(candidate)
        if (revision.issues.length) {
          if (!result.repairable) throw new PipelineFailure('content', revision.issues.join(';'), false)
          continue
        }
        const pending = {...revision.puzzle, status: 'pending' as const, contentHash: revision.contentHash, audits: revision.audits}
        if (!hasCurrentPassingAudits(pending)) throw new PipelineFailure('technical', '最终版本缺少完整审核证据')
        candidate.stage = 'save'
        await this.persist(candidate)
        await this.ports.store.transaction(state => {
          const duplicate = duplicatePuzzle(pending, state.puzzles)
          if (duplicate) throw new PipelineFailure('content', `入库前发现重复题:${duplicate.title}`, false)
          const already = state.puzzles.find(item => item.id === pending.id)
          if (already && puzzleContentHash(already) !== revision.contentHash) throw new PipelineFailure('technical', '题目ID冲突')
          if (!already) state.puzzles.push(pending)
          candidate.status = 'pending'; candidate.recoveredPuzzleId = pending.id; candidate.updatedAt = this.now()
          const index = state.candidates.findIndex(item => item.id === candidate.id)
          if (index >= 0) state.candidates[index] = candidate
          else state.candidates.push(candidate)
        })
        this.ports.logger?.info?.(`[海龟汤] 新汤待审: ${pending.title}(${pending.difficulty}),版本${pending.version}`)
        return pending
      }
    } catch (error) {
      const failure = error instanceof PipelineFailure ? error : new PipelineFailure('technical', errorMessage(error))
      candidate.status = 'failed'; candidate.failureKind = failure.kind; candidate.lastError = failure.message
      await this.persist(candidate)
      this.ports.logger?.warn?.(`[海龟汤] 候选${candidate.id}停在${candidate.stage}: ${failure.message}`)
      throw failure
    }
  }

  private async auditVersion(revision:TurtleSoupCandidateVersion, context:RunContext):Promise<{repairable:boolean}> {
    const puzzle = revision.puzzle, candidate = context.candidate
    const record = (domain:TurtleSoupAuditRecord['domain'], pass:boolean, reason:string, holes:string[] = [], repairable = true) => {
      const audit:TurtleSoupAuditRecord = {domain, pass, reason, holes, repairable, at: this.now(), contentHash: revision.contentHash, version: revision.version, ...((this.ports.config().reviewModel || this.ports.config().generationModel) ? {model: this.ports.config().reviewModel || this.ports.config().generationModel} : {})}
      revision.audits = [...revision.audits.filter(item => item.domain !== domain), audit]
    }
    if (candidate) { candidate.stage = 'structure'; candidate.status = 'reviewing' }
    const issues = auditPuzzleStructure(puzzle)
    if (!difficulties.includes(puzzle.difficulty as Difficulty)) issues.push('难度必须为easy/normal/hard')
    if (candidate?.requestedDifficulty && puzzle.difficulty !== candidate.requestedDifficulty) issues.push(`难度不符:要求${candidate.requestedDifficulty},产出${puzzle.difficulty}`)
    if (candidate && candidate.versions[0]!.puzzle.title !== puzzle.title) issues.push('修复不得更改标题或核心谜题')
    if (new Set(puzzle.hints).size !== 3 || puzzle.hints.length !== 3) issues.push('需三条不同的递进提示')
    if (new Set(puzzle.keyPoints).size !== puzzle.keyPoints.length) issues.push('关键点不可重复')
    const pointIds = puzzle.keyPointIds || puzzle.keyPoints.map((_, index) => `kp${index + 1}`)
    const requiredIds = puzzle.requiredKeyPointIds || pointIds
    if (pointIds.length !== puzzle.keyPoints.length || new Set(pointIds).size !== pointIds.length || !requiredIds.length || new Set(requiredIds).size !== requiredIds.length || requiredIds.some(id => !pointIds.includes(id))) issues.push('关键点ID与必要核心点引用无效')
    const duplicate = duplicatePuzzle(puzzle, this.ports.store.readPuzzles().puzzles)
    if (duplicate) issues.push(`与现有题重复:${duplicate.title}`)
    record('structure', !issues.length, issues.length ? '结构或准入条件未通过' : '结构与准入条件通过', issues, !duplicate)
    revision.issues = issues
    if (candidate) await this.persist(candidate)
    if (issues.length) return {repairable: !duplicate}
    let repairable = true
    const comparisons = comparablePuzzles(puzzle, this.ports.store.readPuzzles().puzzles)
    const stages:{domain:'playability'|'logic'|'simulation';messages:ChatMessage[];parse:(text:string)=>ParsedReview|null}[] = [
      {domain: 'playability', messages: buildPuzzleReviewMessages(puzzle, {contentPolicy: this.ports.config().contentPolicy, comparisons}), parse: parsePuzzleReview},
      {domain: 'logic', messages: buildLogicAuditMessages(puzzle), parse: parseLogicAudit},
      {domain: 'simulation', messages: buildPuzzleSimulationMessages(puzzle), parse: parsePuzzleSimulation}
    ]
    for (const stage of stages) {
      const previous = revision.audits.find(item => item.domain === stage.domain && item.contentHash === revision.contentHash)
      if (previous?.pass && !previous.holes?.length) continue
      const review = await this.callStage(stage.domain, stage.messages, text => {
        const parsed = stage.parse(text)
        if (parsed?.duplicateOf && !comparisons.some(item => item.id === parsed.duplicateOf)) return null
        return parsed
      }, context, 0.2)
      record(stage.domain, review.pass, review.reason, review.holes, review.repairable)
      if (!review.pass) {
        revision.issues.push(...review.holes.map(hole => `${stage.domain}:${hole}`))
        repairable = repairable && review.repairable
      }
      if (candidate) await this.persist(candidate)
      if (!repairable) break
    }
    return {repairable}
  }

  private async callStage<T>(stage:Stage, messages:ChatMessage[], parse:(text:string)=>T|null, context:RunContext, temperature:number):Promise<T> {
    const candidate = context.candidate
    if (candidate) { candidate.stage = stage; candidate.status = stage === 'repair' ? 'repairing' : 'reviewing'; await this.persist(candidate) }
    let lastError = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt && (this.ports.retryDelayMs ?? 250) > 0) await new Promise<void>(resolve => setTimeout(resolve, this.ports.retryDelayMs ?? 250))
      if (context.budget.used >= context.budget.limit || (context.shared && context.shared.used >= context.shared.limit)) throw new PipelineFailure('technical', '本次模型调用预算已用完，候选已保存，可稍后恢复')
      context.budget.used++; if (context.shared) context.shared.used++
      if (candidate) { candidate.modelCalls = (candidate.modelCalls || 0) + 1; await this.persist(candidate) }
      try {
        const text = await this.callWithTimeout(attempt ? [...messages, {role: 'user', content: '上一响应无法通过格式校验。请遵循要求返回完整严格JSON,通过与问题列表不得矛盾。'}] : messages, {temperature, model: (stage === 'generation' || stage === 'repair' ? this.ports.config().generationModel : this.ports.config().reviewModel || this.ports.config().generationModel) || undefined})
        if (candidate) { candidate.rawOutput = text; await this.persist(candidate) }
        const parsed = parse(text)
        if (parsed !== null) return parsed
        lastError = `${stage}产物无法解析或字段互相矛盾`
      } catch (error) { lastError = errorMessage(error) }
    }
    throw new PipelineFailure('technical', `${stage}阶段失败(已重试): ${lastError}`)
  }

  private async callWithTimeout(messages:ChatMessage[], options:TurtleSoupModelCallOptions):Promise<string> {
    const controller = new AbortController()
    let timer:ReturnType<typeof setTimeout>|undefined
    try {
      return await Promise.race([
        this.ports.callModel(messages, {...options, signal: controller.signal}),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('模型调用超时')); }, this.ports.modelTimeoutMs ?? 60_000) })
      ])
    } finally { if (timer) clearTimeout(timer) }
  }

  private parsePuzzle(text:string):TurtleSoupPuzzle|null { return parseGeneratedPuzzle(text, {nowMs: this.now() + this.sequence++, random: this.random(), model: this.ports.config().generationModel || '主模型'}) }
  private async appendVersion(candidate:TurtleSoupCandidate, puzzle:TurtleSoupPuzzle):Promise<void> {
    candidate.currentVersion++
    const next:TurtleSoupPuzzle = {...puzzle, id: `ts_${candidate.id.replace(/^candidate_/, '')}_v${candidate.currentVersion}`, familyId: candidate.familyId, version: candidate.currentVersion, ...(candidate.sourcePuzzleId ? {parentPuzzleId: candidate.sourcePuzzleId} : {})}
    const contentHash = puzzleContentHash(next)
    const unchanged = candidate.versions.at(-1)?.contentHash === contentHash
    next.contentHash = contentHash
    candidate.versions.push({version: candidate.currentVersion, contentHash, puzzle: next, audits: [], issues: unchanged ? ['修复没有改变任何题目内容'] : [], createdAt: this.now()})
    await this.persist(candidate)
  }
  private async persist(candidate:TurtleSoupCandidate):Promise<void> { candidate.updatedAt = this.now(); await this.ports.store.saveCandidate(candidate) }
  private async lock<T>(work:()=>Promise<T>):Promise<T> {
    if (this.generating) throw new Error('busy:已有生成或审核任务进行中')
    this.generating = true
    try { return await this.ports.store.withGenerationLock(work) } finally { this.generating = false }
  }
  private diversity():{difficulty:Difficulty;theme:string} {
    const puzzles = this.ports.store.readPuzzles().puzzles.filter(item => item.status !== 'retired')
    const difficulty = [...difficulties].sort((a, b) => puzzles.filter(item => item.difficulty === a).length - puzzles.filter(item => item.difficulty === b).length)[0]!
    const theme = [...themes].sort((a, b) => puzzles.filter(item => item.tags.includes(a)).length - puzzles.filter(item => item.tags.includes(b)).length)[0]!
    return {difficulty, theme}
  }
  private contentRatings(ratings:TurtleSoupRating[]):TurtleSoupRating[] {
    // Latest vote per player wins before classification. A later host complaint
    // replaces that player's earlier content vote rather than adding another sample.
    const latest = new Map<string, TurtleSoupRating>()
    for (const rating of ratings) if (!latest.has(rating.userId) || rating.at >= latest.get(rating.userId)!.at) latest.set(rating.userId, rating)
    return [...latest.values()].filter(rating => !rating.category || ['logic', 'clues', 'hints', 'other'].includes(rating.category))
  }
  private commentsFrom(ratings:TurtleSoupRating[], positive = false):string[] {
    return this.contentRatings(ratings).filter(rating => !!rating.comment?.trim() && (positive ? rating.score >= 4 : rating.score <= 3))
      .sort((a, b) => b.at - a.at).map(rating => rating.comment!.trim()).slice(0, 3)
  }
  private feedbackFor(puzzle:TurtleSoupPuzzle, ratings = this.ports.store.readPlays().plays.filter(play => play.puzzleId === puzzle.id).flatMap(play => play.ratings)):GenerationFeedbackItem {
    const contentVotes = this.contentRatings(ratings)
    const playerScore = contentVotes.length ? contentVotes.reduce((sum, vote) => sum + vote.score, 0) / contentVotes.length : null
    return {title: puzzle.title, score: playerScore ?? puzzle.manualScore ?? 3, sampleCount: contentVotes.length, playerScore,
      ...(puzzle.manualScore ? {manualScore: puzzle.manualScore} : {}), ...(puzzle.manualScoreReason ? {manualReason: puzzle.manualScoreReason} : {}),
      mechanism: puzzle.mechanism || '', solution: puzzle.solution, keyPoints: puzzle.keyPoints, comments: this.commentsFrom(contentVotes)}
  }
  private callBudget():number { return Math.max(1, Math.floor(this.ports.config().generationCallBudget || 18)) }
  private now() { return this.ports.now ? this.ports.now() : Date.now() }
  private random() { return this.ports.random ? this.ports.random() : Math.random() }
}
