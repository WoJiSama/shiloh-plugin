// 海龟汤生成器:调主模型出题 -> 审题自评 -> 去重 -> 入库;维护鲜汤池保有量。
// 进程内互斥锁防并发重复生成(单进程Yunzai足够,无需跨进程锁)。
import type {TurtleSoupLogger, TurtleSoupPuzzle, TurtleSoupConfig, TurtleSoupAuditRecord} from '../../../../contracts/turtleSoup.js'
import fs from 'fs'
import path from 'path'
import type {ChatMessage} from '../../../../contracts/modelGateway.js'
import {buildPuzzleGenerationMessages, buildPuzzleReviewMessages, parseGeneratedPuzzle, parsePuzzleReview} from '../../domain/turtleSoup/turtleSoupPrompts.js'
import {auditPuzzleStructure, freshPuzzleIds, pendingPuzzleIds, puzzlePlayStats} from '../../domain/turtleSoup/turtleSoupRules.js'
import {buildLogicAuditMessages, parseLogicAudit, buildPuzzleRepairMessages} from '../../domain/turtleSoup/turtleSoupPrompts.js'
import {literalSoupSimilarity} from '../../domain/turtleSoup/turtleSoupSimilarity.js'
import type {TurtleSoupStore} from './TurtleSoupStore.js'

export interface TurtleSoupModelCallOptions {model?:string|undefined;temperature?:number|undefined}
export type TurtleSoupModelCall = (messages:ChatMessage[], options?:TurtleSoupModelCallOptions) => Promise<string>

export interface TurtleSoupGeneratorPorts {
  store:TurtleSoupStore
  config:() => TurtleSoupConfig
  callModel:TurtleSoupModelCall
  logger?:TurtleSoupLogger
  now?:() => number
  random?:() => number
}

export interface GenerateOutcome {added:number;failed:number;lastError:string|undefined}

export class TurtleSoupGenerator {
  private readonly ports:TurtleSoupGeneratorPorts
  private generating = false
  private sequence = 0
  constructor(ports:TurtleSoupGeneratorPorts) { this.ports = ports }

  get busy() { return this.generating }

  freshCount():number {
    const {puzzles} = this.ports.store.readPuzzles()
    return freshPuzzleIds(puzzles, puzzlePlayStats(this.ports.store.readPlays().plays)).length
  }

  // 鲜汤保有量含待审:待审不算可玩,但已占生成额度,避免管理员未过审时无限生成
  readyFreshCount():number {
    const {puzzles} = this.ports.store.readPuzzles()
    const played = puzzlePlayStats(this.ports.store.readPlays().plays)
    return freshPuzzleIds(puzzles, played).length + pendingPuzzleIds(puzzles).length
  }

  // 鲜汤不足时补货到目标值;拿不到锁说明已有补货在进行,直接返回。
  async ensureFreshPool():Promise<GenerateOutcome> {
    if (this.generating) return {added: 0, failed: 0, lastError: 'busy'}
    this.generating = true
    try {
      let added = 0, failed = 0, lastError:string|undefined
      const attemptsLimit = this.ports.config().freshPoolTarget * 3
      let attempts = 0
      while (this.readyFreshCount() < this.ports.config().freshPoolTarget && attempts < attemptsLimit) {
        attempts++
        try { await this.generateOne(); added++ }
        catch (error) { failed++; lastError = error instanceof Error ? error.message : String(error) }
      }
      return {added, failed, lastError}
    } finally { this.generating = false }
  }

  // 手动种子生成(管理命令),同样受互斥锁保护。
  async seed(count:number, difficulty?:'easy'|'normal'|'hard'):Promise<GenerateOutcome> {
    const total = Math.max(1, Math.min(20, Math.floor(count) || 1))
    if (this.generating) return {added: 0, failed: 0, lastError: 'busy'}
    this.generating = true
    try {
      let added = 0, failed = 0, lastError:string|undefined
      for (let index = 0; index < total; index++) {
        try { await this.generateOne(difficulty); added++ }
        catch (error) { failed++; lastError = error instanceof Error ? error.message : String(error) }
      }
      return {added, failed, lastError}
    } finally { this.generating = false }
  }

  // 汇总评分反馈:高分解构风格、低分带玩家批评,喂给出题模型迭代质量
  buildGenerationFeedback():{high:{title:string;score:number;comments:string[]}[];low:{title:string;score:number;comments:string[]}[]} {
    const {store} = this.ports
    // 玩家评分与手动标记分都纳入反馈:手动分优先(管理员终审),无手动分时用玩家均分
    const puzzles = store.readPuzzles().puzzles.filter(puzzle => puzzle.ratingCount > 0 || (puzzle.manualScore ?? 0) >= 1)
    const commentsOf = (puzzleId:string) => store.readPlays().plays
      .filter(play => play.puzzleId === puzzleId)
      .flatMap(play => play.ratings)
      .filter(rating => rating.comment && rating.comment.trim())
      .map(rating => String(rating.comment).trim())
    const ranked = puzzles
      .map(puzzle => ({title: puzzle.title, score: (puzzle.manualScore ?? 0) >= 1 ? puzzle.manualScore! : puzzle.ratingSum / puzzle.ratingCount, comments: commentsOf(puzzle.id)}))
      .sort((left, right) => right.score - left.score)
    return {
      high: ranked.filter(item => item.score >= 4).slice(0, 5),
      low: ranked.filter(item => item.score < 3.5).reverse().slice(0, 5)
    }
  }

  async generateOne(difficulty?:'easy'|'normal'|'hard'):Promise<TurtleSoupPuzzle> {
    const {store, config} = this.ports
    const {puzzles} = store.readPuzzles()
    const settings = config()
    const avoidTitles = puzzles.map(puzzle => puzzle.title).slice(-60)
    const feedback = this.buildGenerationFeedback()
    let lastError:unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rejectionLessons = this.readRejectionLessons()
        const text = await this.ports.callModel(buildPuzzleGenerationMessages({contentPolicy: settings.contentPolicy, avoidTitles, feedback, rejectionLessons, ...(difficulty ? {difficulty} : {})}), {temperature: 0.9, model: settings.generationModel || undefined})
        const puzzle = parseGeneratedPuzzle(text, {nowMs: this.now() + this.sequence++, random: this.random(), model: settings.generationModel || '主模型'})
        if (!puzzle) throw new Error('生成产物不是合法汤面JSON')
        if (difficulty && puzzle.difficulty !== difficulty) throw new Error(`难度不符:要求${difficulty},产出${puzzle.difficulty}`)
        if (this.duplicatesExisting(puzzle, puzzles)) throw new Error(`生成产物与现有汤面重复: ${puzzle.title}`)
        // 三道关全部通过才入库,且各域审核结论随题保存,供控制台展示与追溯
        const audits:TurtleSoupAuditRecord[] = []
        const auditAt = this.now()
        // 第一关:确定性结构审核(长度/条数/关键点泄露)
        const structureIssues = auditPuzzleStructure(puzzle)
        audits.push({domain: 'structure', pass: !structureIssues.length, reason: structureIssues.length ? '存在结构性问题' : '结构合规(长度/条数/无泄底)', ...(structureIssues.length ? {holes: structureIssues} : {}), at: auditAt})
        if (structureIssues.length) {
          this.logRejected({...puzzle, audits}, [`结构: ${structureIssues.join(';')}`])
          throw new Error(`结构审核未通过: ${structureIssues.join(';')}`)
        }
        // 第二关:可玩性审题
        const reviewText = await this.ports.callModel(buildPuzzleReviewMessages(puzzle), {temperature: 0.2, model: settings.generationModel || undefined})
        const review = parsePuzzleReview(reviewText)
        if (!review) throw new Error('审题产物无法解析')
        audits.push({domain: 'playability', pass: review.pass === true, reason: review.reason || (review.pass ? '可玩性通过' : '审题未通过'), at: auditAt, ...(settings.generationModel ? {model: settings.generationModel} : {})})
        if (!review.pass) {
          this.logRejected({...puzzle, audits}, [`审题: ${review.reason}`])
          throw new Error(`审题未通过: ${review.reason}`)
        }
        // 第三关:独立逻辑审计(逐句对照/时间线/物件流转/动机链),发现漏洞直接废弃
        const auditText = await this.ports.callModel(buildLogicAuditMessages(puzzle), {temperature: 0.2, model: settings.generationModel || undefined})
        const audit = parseLogicAudit(auditText)
        if (!audit) throw new Error('逻辑审计产物无法解析')
        audits.push({domain: 'logic', pass: audit.pass === true, reason: audit.reason || (audit.pass ? '无逻辑漏洞' : '存在逻辑漏洞'), ...(audit.holes.length ? {holes: audit.holes} : {}), at: auditAt, ...(settings.generationModel ? {model: settings.generationModel} : {})})
        let finalPuzzle = puzzle
        if (!audit.pass) {
          // 修复式重生成:把漏洞喂回模型修同一道题,修完重审;最多两轮
          let repaired = false
          for (let repairRound = 0; repairRound < 2 && !repaired; repairRound++) {
            try {
              const repairText = await this.ports.callModel(buildPuzzleRepairMessages(finalPuzzle, audit.holes), {temperature: 0.3, model: settings.generationModel || undefined})
              const repairedPuzzle = parseGeneratedPuzzle(repairText, {nowMs: this.now() + this.sequence++, random: this.random(), model: settings.generationModel || '主模型'})
              if (!repairedPuzzle) throw new Error('修复产物不是合法JSON')
              if (repairedPuzzle.title !== puzzle.title) throw new Error('修复改了标题')
              const repairIssues = auditPuzzleStructure(repairedPuzzle)
              if (repairIssues.length) throw new Error(`修复后结构问题: ${repairIssues.join(';')}`)
              const reAuditText = await this.ports.callModel(buildLogicAuditMessages(repairedPuzzle), {temperature: 0.2, model: settings.generationModel || undefined})
              const reAudit = parseLogicAudit(reAuditText)
              if (!reAudit) throw new Error('重审产物无法解析')
              if (reAudit.pass) {
                finalPuzzle = repairedPuzzle
                audits.push({domain: 'logic', pass: true, reason: `修复后通过(第${repairRound + 1}轮),原漏洞: ${audit.holes.slice(0, 2).join(';').slice(0, 80)}`, holes: audit.holes, at: this.now(), ...(settings.generationModel ? {model: settings.generationModel} : {})})
                repaired = true
                this.ports.logger?.info?.(`[海龟汤] 修复成功: ${finalPuzzle.title}(第${repairRound + 1}轮)`)
              } else {
                audit.holes = reAudit.holes
                audit.reason = reAudit.reason
              }
            } catch (repairError) {
              this.ports.logger?.warn?.(`[海龟汤] 修复失败(第${repairRound + 1}轮): ${repairError instanceof Error ? repairError.message : String(repairError)}`)
              break
            }
          }
          if (!repaired) {
            // 最终失败:留档(汤面/汤底/漏洞),不进主池
            this.logRejected({...finalPuzzle, audits}, audit.holes)
            throw new Error(`逻辑审计未通过(含修复尝试): ${audit.holes.slice(0, 2).join(';') || audit.reason}`)
          }
        }
        // 入库即待审,管理员过审后才进入投放池
        const pending = {...finalPuzzle, status: 'pending' as const, audits}
        await store.savePuzzle(pending)
        this.ports.logger?.info?.(`[海龟汤] 新汤待审: ${pending.title}(${pending.difficulty})`)
        return pending
      } catch (error) { lastError = error }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  // 读取最近的被拒记录,提取教训喂给出题提示词——让模型"从错误中学习"
  readRejectionLessons():{title:string;holes:string[]}[] {
    try {
      const rejectedPath = path.join(this.ports.store.dataDir, 'rejected.jsonl')
      const text = fs.readFileSync(rejectedPath, 'utf8')
      const lines = text.split('\n').filter(line => line.trim())
      // 取最近 8 条,同标题去重(修复尝试可能产生多条同名记录)
      const seen = new Set<string>()
      const lessons:{title:string;holes:string[]}[] = []
      for (let index = lines.length - 1; index >= 0 && lessons.length < 8; index--) {
        try {
          const entry = JSON.parse(lines[index]!) as {title?:string;holes?:string[]}
          const title = String(entry.title || '').trim()
          if (!title || seen.has(title)) continue
          seen.add(title)
          lessons.push({title, holes: (entry.holes || []).map(hole => String(hole).slice(0, 80))})
        } catch {}
      }
      return lessons
    } catch {
      return []
    }
  }

  // 失败留档:追加到 data/turtle_soup/rejected.jsonl,含汤面汤底和拒绝原因
  private logRejected(puzzle:TurtleSoupPuzzle, holes:string[]) {
    try {
      const rejectedPath = path.join(this.ports.store.dataDir, 'rejected.jsonl')
      const entry = JSON.stringify({
        title: puzzle.title, surface: puzzle.surface, solution: puzzle.solution,
        keyPoints: puzzle.keyPoints, difficulty: puzzle.difficulty, tags: puzzle.tags,
        holes, at: Date.now()
      })
      fs.appendFileSync(rejectedPath, entry + '\n')
    } catch (error) {
      this.ports.logger?.warn?.(`[海龟汤] 失败留档写入失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  duplicatesExisting(candidate:TurtleSoupPuzzle, puzzles:TurtleSoupPuzzle[]):boolean {
    return puzzles.some(existing =>
      literalSoupSimilarity(candidate.title, existing.title) >= 0.8 ||
      literalSoupSimilarity(candidate.surface, existing.surface) >= 0.9
    )
  }

  private now() { return this.ports.now ? this.ports.now() : Date.now() }
  private random() { return this.ports.random ? this.ports.random() : Math.random() }
}
