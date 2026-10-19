// 海龟汤生成器:调主模型出题 -> 审题自评 -> 去重 -> 入库;维护鲜汤池保有量。
// 进程内互斥锁防并发重复生成(单进程Yunzai足够,无需跨进程锁)。
import type {TurtleSoupLogger, TurtleSoupPuzzle, TurtleSoupConfig} from '../../../../contracts/turtleSoup.js'
import type {ChatMessage} from '../../../../contracts/modelGateway.js'
import {buildPuzzleGenerationMessages, buildPuzzleReviewMessages, parseGeneratedPuzzle, parsePuzzleReview} from '../../domain/turtleSoup/turtleSoupPrompts.js'
import {freshPuzzleIds, puzzlePlayStats} from '../../domain/turtleSoup/turtleSoupRules.js'
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

  // 鲜汤不足时补货到目标值;拿不到锁说明已有补货在进行,直接返回。
  async ensureFreshPool():Promise<GenerateOutcome> {
    if (this.generating) return {added: 0, failed: 0, lastError: 'busy'}
    this.generating = true
    try {
      let added = 0, failed = 0, lastError:string|undefined
      const attemptsLimit = this.ports.config().freshPoolTarget * 3
      let attempts = 0
      while (this.freshCount() < this.ports.config().freshPoolTarget && attempts < attemptsLimit) {
        attempts++
        try { await this.generateOne(); added++ }
        catch (error) { failed++; lastError = error instanceof Error ? error.message : String(error) }
      }
      return {added, failed, lastError}
    } finally { this.generating = false }
  }

  // 手动种子生成(管理命令),同样受互斥锁保护。
  async seed(count:number):Promise<GenerateOutcome> {
    const total = Math.max(1, Math.min(20, Math.floor(count) || 1))
    if (this.generating) return {added: 0, failed: 0, lastError: 'busy'}
    this.generating = true
    try {
      let added = 0, failed = 0, lastError:string|undefined
      for (let index = 0; index < total; index++) {
        try { await this.generateOne(); added++ }
        catch (error) { failed++; lastError = error instanceof Error ? error.message : String(error) }
      }
      return {added, failed, lastError}
    } finally { this.generating = false }
  }

  // 汇总评分反馈:高分解构风格、低分带玩家批评,喂给出题模型迭代质量
  buildGenerationFeedback():{high:{title:string;score:number;comments:string[]}[];low:{title:string;score:number;comments:string[]}[]} {
    const {store} = this.ports
    const puzzles = store.readPuzzles().puzzles.filter(puzzle => puzzle.ratingCount > 0)
    const commentsOf = (puzzleId:string) => store.readPlays().plays
      .filter(play => play.puzzleId === puzzleId)
      .flatMap(play => play.ratings)
      .filter(rating => rating.comment && rating.comment.trim())
      .map(rating => String(rating.comment).trim())
    const ranked = puzzles
      .map(puzzle => ({title: puzzle.title, score: puzzle.ratingSum / puzzle.ratingCount, comments: commentsOf(puzzle.id)}))
      .sort((left, right) => right.score - left.score)
    return {
      high: ranked.filter(item => item.score >= 4).slice(0, 5),
      low: ranked.filter(item => item.score < 3.5).reverse().slice(0, 5)
    }
  }

  async generateOne():Promise<TurtleSoupPuzzle> {
    const {store, config} = this.ports
    const {puzzles} = store.readPuzzles()
    const settings = config()
    const avoidTitles = puzzles.map(puzzle => puzzle.title).slice(-60)
    const feedback = this.buildGenerationFeedback()
    let lastError:unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await this.ports.callModel(buildPuzzleGenerationMessages({contentPolicy: settings.contentPolicy, avoidTitles, feedback}), {temperature: 0.9, model: settings.generationModel || undefined})
        const puzzle = parseGeneratedPuzzle(text, {nowMs: this.now() + this.sequence++, random: this.random(), model: settings.generationModel || '主模型'})
        if (!puzzle) throw new Error('生成产物不是合法汤面JSON')
        if (this.duplicatesExisting(puzzle, puzzles)) throw new Error(`生成产物与现有汤面重复: ${puzzle.title}`)
        const reviewText = await this.ports.callModel(buildPuzzleReviewMessages(puzzle), {temperature: 0.2, model: settings.generationModel || undefined})
        const review = parsePuzzleReview(reviewText)
        if (!review) throw new Error('审题产物无法解析')
        if (!review.pass) throw new Error(`审题未通过: ${review.reason}`)
        await store.savePuzzle(puzzle)
        this.ports.logger?.info?.(`[海龟汤] 新汤入库: ${puzzle.title}(${puzzle.difficulty})`)
        return puzzle
      } catch (error) { lastError = error }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
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
