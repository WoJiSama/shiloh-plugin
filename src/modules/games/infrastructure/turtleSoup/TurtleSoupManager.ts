// 海龟汤会话管理:命令处理、开局选汤、问答调度、揭晓收局与超时sweeper。
// 会话内存缓存+落盘恢复;时间驱动统一走sweep(),重启后靠时间戳继续判定,无僵尸局。
import type {TurtleSoupConfig, TurtleSoupEvent, TurtleSoupLogger, TurtleSoupPuzzle, TurtleSoupPlay, TurtleSoupSession, TurtleSoupHost} from '../../../../contracts/turtleSoup.js'
import {TurtleSoupStore, readTurtleSoupConfig} from './TurtleSoupStore.js'
import type {TurtleSoupGenerator, GenerateOutcome} from './TurtleSoupGenerator.js'
import {buildMvpBrief, canManualStart, guessCooldownRemainingMs, isParticipant, joiningOutcome, playingTimedOut, revealTimedOut, selectPuzzleId, shouldRetirePuzzle, takeHint, upsertRating, buildCatchUpText, buildStatusText, buildRevealText, buildRecapText, classifyThresholds, formatDuration, formatCountdown, stripAsideSegments, isAsideOnlyText, SOUP_COMMAND, surrenderPlayer, looksLikeSoupQuestion, isRepeatedQuestion, choosingTimedOut, chooseWindowMs, puzzlePlayStats, soupCandidatesFor} from '../../domain/turtleSoup/turtleSoupRules.js'
import {classifySoupGuess, looksLikeSolutionLeak} from '../../domain/turtleSoup/turtleSoupSimilarity.js'

export interface TurtleSoupManagerPorts {
  sendSmartReply(event:TurtleSoupEvent, message:unknown, options?:{kind?:string}):Promise<unknown>
  replyGroup?:(groupId:string, message:string)=>Promise<unknown>
  host:TurtleSoupHost
  generator:TurtleSoupGenerator
  logger?:TurtleSoupLogger
  cwd?:string
  config?:() => TurtleSoupConfig
  now?:() => number
  sweepIntervalMs?:number
  isOtherGameActive?:(groupId:string)=>boolean
  sendPrivate?:(userId:string,message:string,groupId?:string)=>Promise<unknown>
}

const HELP_TEXT = [
  "🐢 海龟汤(情境推理)玩法:",
  `${SOUP_COMMAND} 开局 —— 发起报名(也可由我自动开局)`,
  `${SOUP_COMMAND} 加入 —— 报名/中途加入(开局后随时可加入)`,
  `${SOUP_COMMAND} 开始 —— 人数够后由发起人提前开局,随后三选一挑汤`,
  `${SOUP_COMMAND} 选 <序号|随机> —— 选汤环节参与者先到先得`,
  `${SOUP_COMMAND} 取消 —— 报名期取消本局;游戏中期等价于 结束`,
  "开局后自由发言提问,我只回答:是 / 不是 / 是也不是 / 与此无关",
  "括号里的内容算场外(角色扮演/旁白),我不会回应",
  `${SOUP_COMMAND} 猜 <答案> —— 猜汤底,猜中即胜`,
  `${SOUP_COMMAND} 投降 —— 个人投降,汤底私发给你(退场,请勿剧透)`,
  `${SOUP_COMMAND} 提示 —— 逐级取提示(每局有限)`,
  `${SOUP_COMMAND} 状态 / ${SOUP_COMMAND} 结束(发起人或管理)`,
  `揭晓后:${SOUP_COMMAND} 评分 1-5 [一句话评论]`
].join('\n')

const HUB_TEXT = [
  '【小游戏中心】',
  `${SOUP_COMMAND} —— AI主持的情境推理(海龟汤):出题/问答/猜汤底/MVP评选`,
  '后续小游戏将统一挂到 .游戏 <游戏名> 下'
].join('\n')

export class TurtleSoupManager {
  private readonly ports:TurtleSoupManagerPorts
  private readonly store:TurtleSoupStore
  private readonly sessions:Map<string, TurtleSoupSession>
  private sweeperTimer:ReturnType<typeof setInterval>|null = null
  private sweeping = false
  private playSequence = 0

  constructor(ports:TurtleSoupManagerPorts) {
    this.ports = ports
    this.store = new TurtleSoupStore({cwd: ports.cwd ?? process.cwd(), baseDir: this.config().baseDir})
    this.sessions = new Map(Object.entries(this.store.readSessions().sessions))
  }

  config():TurtleSoupConfig { return this.ports.config ? this.ports.config() : readTurtleSoupConfig(this.ports.cwd ?? process.cwd()) }

  start() {
    const interval = this.ports.sweepIntervalMs ?? 30_000
    if (!this.sweeperTimer) this.sweeperTimer = setInterval(() => { void this.sweep() }, interval)
  }

  stop() {
    if (this.sweeperTimer) { clearInterval(this.sweeperTimer); this.sweeperTimer = null }
  }

  getUserId(e:TurtleSoupEvent) { return String(e?.user_id || e?.sender?.user_id || "") }
  getNickname(e:TurtleSoupEvent) { return String(e?.sender?.card || e?.sender?.nickname || e?.nickname || this.getUserId(e)) }
  getGroupId(e:TurtleSoupEvent) { return String(e?.group_id || "") }
  isAdmin(e:TurtleSoupEvent) { return !!e?.isMaster || e?.sender?.role === 'admin' || e?.sender?.role === 'owner' }
  private now() { return this.ports.now ? this.ports.now() : Date.now() }

  getSession(groupId:string):TurtleSoupSession|undefined { return this.sessions.get(groupId) }

  // 问答进行中的群——这些群的主聊天人格(希洛)应整体静默,游戏主持人是唯一的bot声音
  playingGroupIds():Set<string> {
    const result = new Set<string>()
    for (const [groupId, session] of this.sessions) if (session.phase === 'playing' || session.phase === 'choosing') result.add(groupId)
    return result
  }

  private findPuzzle(puzzleId:string):TurtleSoupPuzzle|null {
    return this.store.readPuzzles().puzzles.find(puzzle => puzzle.id === puzzleId) ?? null
  }

  private findOpenPlay(groupId:string):TurtleSoupPlay|null {
    return this.store.readPlays().plays.find(play => play.groupId === groupId && play.endedAt === undefined) ?? null
  }

  private findLatestPlay(groupId:string):TurtleSoupPlay|null {
    const plays = this.store.readPlays().plays.filter(play => play.groupId === groupId)
    if (!plays.length) return null
    return plays.reduce((best, item) => (item.startedAt >= best.startedAt ? item : best))
  }

  private makePlayId() { return `pl_${this.now().toString(36)}_${(this.playSequence++).toString(36)}` }

  private async persist(session:TurtleSoupSession) {
    this.sessions.set(session.groupId, session)
    await this.store.saveSession(session)
  }

  private async drop(groupId:string) {
    this.sessions.delete(groupId)
    await this.store.removeSession(groupId)
  }

  // —— 命令入口(返回文本由app层发送;返回null表示不处理) ——

  showHelp():string { return HELP_TEXT }

  showHub():string { return HUB_TEXT }

  async openGame(e:TurtleSoupEvent):Promise<string> {
    if (!this.config().enabled) return "小游戏功能未开启"
    const groupId = this.getGroupId(e)
    if (!groupId) return "海龟汤仅支持群聊"
    const existing = this.sessions.get(groupId)
    if (existing) {
      if (existing.phase === 'reveal') return `上局已揭晓,评分窗口中:${SOUP_COMMAND} 评分 1-5;发起人或管理发 ${SOUP_COMMAND} 结束 可立即归档后再开局`
      return `本局还在进行中(${phaseLabel(existing)}),可用 ${SOUP_COMMAND} 状态 查看,或 ${SOUP_COMMAND} 结束 收局`
    }
    if (this.ports.isOtherGameActive?.(groupId)) return "本群有进行中的赛马娘比赛,等它结束再开海龟汤" 
    const nowMs = this.now()
    const session:TurtleSoupSession = {
      groupId, phase: 'joining', puzzleId: '', initiatorId: this.getUserId(e),
      players: [{userId: this.getUserId(e), nickname: this.getNickname(e), joinedAt: nowMs}], createdAt: nowMs,
      joinDeadlineAt: nowMs + this.config().joinWindowMinutes * 60_000,
      lastActivityAt: nowMs, qaLog: [], guessLog: [], usedHints: 0, lastGuessAt: {}, surrendered: {}
    }
    await this.persist(session)
    const minutes = formatDuration(this.config().joinWindowMinutes * 60_000)
    return [
      "🐢 海龟汤开局报名开始!",
      `发起人:${this.getNickname(e)}已自动上桌`,
      `其他人想玩的发送 ${SOUP_COMMAND} 加入 (最少${this.config().minPlayers}人,${minutes}内有效)`,
      `人齐后发起人可发 ${SOUP_COMMAND} 开始 提前开局,随后全员三选一挑汤;不想玩了发 ${SOUP_COMMAND} 取消 立即取消(到点人数够也会自动开局)`
    ].join("\n")
  }

  async joinGame(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session) return `本群还没有报名中的海龟汤,发送 ${SOUP_COMMAND} 开局 发起`
    const nowMs = this.now()
    const userId = this.getUserId(e), nickname = this.getNickname(e)
    const existing = session.players.find(player => player.userId === userId)
    if (existing) return `${nickname}已经在牌桌上了`
    if (session.phase !== 'joining' && session.phase !== 'choosing' && session.phase !== 'playing') return "本局已结束,等待下一局"
    if (session.phase === 'choosing') {
      session.players.push({userId, nickname, joinedAt: nowMs})
      session.lastActivityAt = nowMs
      await this.persist(session)
      return `${nickname}加入!正在选汤,开局后一起玩`
    }
    if (session.phase === 'playing') {
      if (session.surrendered[userId]) return `${nickname}已投降并看过汤底,本局不能再加入`
      session.players.push({userId, nickname, joinedAt: nowMs})
      session.lastActivityAt = nowMs
      await this.persist(session)
      return `${nickname}中途加入!\n${this.buildCatchUp(session)}`
    }
    session.players.push({userId, nickname, joinedAt: nowMs})
    session.lastActivityAt = nowMs
    await this.persist(session)
    return `${nickname}加入!当前${session.players.length}人(最少${this.config().minPlayers}人)`
  }

  // 报名期:发起人/管理可立即取消本局;问答期与评分窗等价于 结束(揭晓/归档)。
  async cancelGame(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session) return "本群没有进行中的海龟汤"
    if (session.phase === 'joining' || session.phase === 'choosing') {
      if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) return "只有发起人或群管理可以取消报名"
      await this.drop(session.groupId)
      return `报名已取消,本局作废。想玩再 ${SOUP_COMMAND} 开局`
    }
    return await this.endGame(e)
  }

  async startGame(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session || session.phase !== 'joining') return `本群没有报名中的海龟汤(发送 ${SOUP_COMMAND} 开局 发起)`
    if (!canManualStart(session, this.config().minPlayers)) return `人数还不够(最少${this.config().minPlayers}人),继续 ${SOUP_COMMAND} 加入`
    if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) return "只有发起人或群管理可以提前开局"
    return await this.launchPlay(session)
  }

  // 开局上菜:多于一道可选时进入三选一窗口,只有一道直接开局,没有则提示补库
  private async launchPlay(session:TurtleSoupSession):Promise<string> {
    const puzzles = this.store.readPuzzles().puzzles.filter(puzzle => puzzle.status === 'active')
    const stats = puzzlePlayStats(this.store.readPlays().plays)
    const {strict, groupOnly} = soupCandidatesFor(puzzles, stats, session.groupId, session.players.map(player => player.userId))
    const available = strict.length ? strict : groupOnly
    if (!available.length) {
      await this.drop(session.groupId)
      return "题库里已经没有本群没玩过的汤了,请管理员用 .游戏 海龟汤 生成 补充题库后再开局"
    }
    if (available.length === 1) return await this.beginPlay(session, available[0]!.id)
    const shuffled = [...available].sort(() => Math.random() - 0.5).slice(0, 3)
    session.phase = 'choosing'
    session.choosing = {candidates: shuffled.map(puzzle => puzzle.id), deadlineAt: this.now() + chooseWindowMs(this.config())}
    session.lastActivityAt = this.now()
    await this.persist(session)
    const menu = shuffled.map((puzzle, index) => `${index + 1}.【${puzzle.title}】(${puzzle.difficulty})${puzzle.tags.length ? ' ' + puzzle.tags.slice(0, 2).join('/') : ''}`)
    return [
      '🍽 上菜!三选一:',
      ...menu,
      `想玩哪个?参与者发 ${SOUP_COMMAND} 选 1/${shuffled.length}(先到先得),或 ${SOUP_COMMAND} 选 随机`,
      `${formatCountdown(chooseWindowMs(this.config()))}没人选就自动随机开局`
    ].join('\n')
  }

  // 选汤:参与者先到先得;随机则从候选里随机
  async choosePuzzle(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session || session.phase !== 'choosing' || !session.choosing) return "现在不在选汤环节(先用 .游戏 海龟汤 开始 进入选汤)"
    if (!isParticipant(session, this.getUserId(e))) return "先 .游戏 海龟汤 加入 才能选汤"
    const pick = String(e?.msg || '').match(/^[.。]游戏\s+海龟汤\s*选\s*(随机|1|2|3|一|二|三)\s*$/)?.[1]
    if (!pick) return `用法:${SOUP_COMMAND} 选 1~${session.choosing.candidates.length} 或 ${SOUP_COMMAND} 选 随机`
    const index = pick === '随机' ? Math.floor(Math.random() * session.choosing.candidates.length)
      : (({'1': 0, '一': 0, '2': 1, '二': 1, '3': 2, '三': 2} as Record<string, number>)[pick] ?? 0)
    const puzzleId = session.choosing.candidates[index] ?? session.choosing.candidates[0] ?? ''
    const puzzle = this.findPuzzle(puzzleId)
    if (!puzzle) return "候选记录异常,请重试或等待超时随机开局"
    const title = puzzle.title
    const result = await this.beginPlay(session, puzzleId)
    return `就吃【${title}】!\n${result}`
  }

  private async beginPlay(session:TurtleSoupSession, chosenPuzzleId?:string):Promise<string> {
    const puzzles = this.store.readPuzzles().puzzles
    const plays = this.store.readPlays().plays
    const puzzleId = chosenPuzzleId ?? selectPuzzleId(puzzles, plays, session.groupId, Math.random, session.players.map(player => player.userId))
    if (!puzzleId) {
      await this.drop(session.groupId)
      return "题库里已经没有本群没玩过的汤了,请管理员用 .海龟汤 生成 补充题库后再开局"
    }
    const puzzle = this.findPuzzle(puzzleId)
    if (!puzzle) {
      await this.drop(session.groupId)
      return "题库记录异常,本局取消"
    }
    const nowMs = this.now()
    session.phase = 'playing'
    delete session.choosing
    session.puzzleId = puzzleId
    session.startedAt = nowMs
    session.lastActivityAt = nowMs
    await this.persist(session)
    await this.store.upsertPlay({
      playId: this.makePlayId(), puzzleId, puzzleTitle: puzzle.title, groupId: session.groupId,
      startedAt: nowMs, solved: false, players: [], qaCount: 0, ratings: []
    })
    // 消费了一条鲜汤,后台补货(失败不影响本局)
    void this.ports.generator.ensureFreshPool().catch(error => {
      this.ports.logger?.warn?.(`[海龟汤] 后台补货失败: ${error instanceof Error ? error.message : String(error)}`)
    })
    const idle = formatDuration(this.config().idleTimeoutMinutes * 60_000)
    const every = this.config().recapEveryQuestions
    return [
      `【${puzzle.title}】(${puzzle.difficulty})`,
      "",
      puzzle.surface,
      "",
      `现在开始自由提问,我只回答:是 / 不是 / 是也不是 / 与此无关`,
      `(括号)里的内容算场外,我不会回应`,
      `${SOUP_COMMAND} 猜 <答案> —— 猜汤底,猜中即胜`,
      `${SOUP_COMMAND} 提示 —— 卡住了要提示(每局${this.config().maxHints}条)`,
      `${SOUP_COMMAND} 投降 —— 汤底私发给你并退场,别剧透`,
      `围观想上车:随时 ${SOUP_COMMAND} 加入`,
      ...(every > 0 ? [`每${every}次提问我会发一张进度卡(汤面+问答汇总)`] : []),
      `${idle}无人发言本局自动揭晓`
    ].join("\n")
  }

  async guessSoup(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session || session.phase !== 'playing') return "现在没有进行中的海龟汤"
    const userId = this.getUserId(e), nickname = this.getNickname(e)
    if (!isParticipant(session, userId)) return `先 ${SOUP_COMMAND} 加入 才能猜汤底`
    const puzzle = this.findPuzzle(session.puzzleId)
    if (!puzzle) return "题库记录异常,请联系管理员"
    const guess = String(e?.msg || "").replace(/^[.。]游戏\s+海龟汤\s*(?:猜|猜汤底|答案)\s*/, "").trim()
    if (!guess) return `猜点什么?用法:${SOUP_COMMAND} 猜 <你的答案>`
    const nowMs = this.now()
    const cooldown = guessCooldownRemainingMs(session, userId, nowMs, this.config().guessCooldownSeconds * 1000)
    if (cooldown > 0) return `猜测冷却中,还剩${formatCountdown(cooldown)}`
    session.lastGuessAt[userId] = nowMs
    session.lastActivityAt = nowMs
    const classification = classifySoupGuess(guess, puzzle.solution, classifyThresholds(this.config()))
    if (classification.verdict === 'hit') {
      session.guessLog.push({userId, guess, literalScore: classification.score, final: 'hit', at: nowMs})
      return await this.finishGame(session, 'solved', userId)
    }
    if (classification.verdict === 'gray') {
      const verdict = await this.ports.host.judgeGuess({guess, solution: puzzle.solution, keyPoints: puzzle.keyPoints, literalScore: classification.score})
      if (verdict.correct) {
        session.guessLog.push({userId, guess, literalScore: classification.score, final: 'hit', at: nowMs})
        return await this.finishGame(session, 'solved', userId)
      }
      session.guessLog.push({userId, guess, literalScore: classification.score, final: 'miss', at: nowMs})
      await this.persist(session)
      return `主持人:${nickname}没猜中——与汤底关联度约${verdict.closeness}%`
    }
    session.guessLog.push({userId, guess, literalScore: classification.score, final: 'miss', at: nowMs})
    await this.persist(session)
    return `${nickname},没猜中,继续问吧`
  }

  async useHint(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session || session.phase !== 'playing') return "现在没有进行中的海龟汤"
    if (!isParticipant(session, this.getUserId(e))) return `先 ${SOUP_COMMAND} 加入 才能用提示`
    const puzzle = this.findPuzzle(session.puzzleId)
    if (!puzzle) return "题库记录异常,请联系管理员"
    const hint = takeHint(session, puzzle.hints, this.config().maxHints)
    if (hint === null) return session.usedHints >= this.config().maxHints ? "本局提示已用完" : "这道题没有更多提示了"
    session.lastActivityAt = this.now()
    await this.persist(session)
    return `提示(${session.usedHints}/${this.config().maxHints}):${hint}`
  }

  showStatus(e:TurtleSoupEvent):string {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session) return "本群没有进行中的海龟汤,发送 .海龟汤 开局 发起"
    return buildStatusText(session, this.config(), this.now())
  }

  async endGame(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session) return "本群没有进行中的海龟汤"
    // 报名期结束 = 取消本局；不处理会让会话留在 joining，被 sweeper 到点自动开局"复活"
    if (session.phase === 'joining') {
      if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) return "只有发起人或群管理可以取消"
      await this.drop(session.groupId)
      return `报名期已结束,本局取消。想玩再 ${SOUP_COMMAND} 开局`
    }
    if (session.phase === 'choosing') {
      if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) return "只有发起人或群管理可以取消"
      await this.drop(session.groupId)
      return "选汤阶段已取消,本局作废。想玩再 .游戏 海龟汤 开局"
    }
    if (session.phase === 'reveal') {
      if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) {
        return `评分窗口还有一会儿,等它自动归档;发起人或群管理可发 ${SOUP_COMMAND} 结束 立即归档`
      }
      return await this.archiveRevealed(session, '评分窗口提前关闭,')
    }
    if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) return "只有发起人或群管理可以结束本局"
    return await this.finishGame(session, 'manual')
  }

  // 个人投降:汤底私发给投降者,其退出本局;最后一名玩家投降则公开收局。
  async surrender(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session) return "本群没有进行中的海龟汤"
    const userId = this.getUserId(e)
    if (session.phase === 'joining') {
      if (!isParticipant(session, userId)) return "你还没有加入报名"
      session.players = session.players.filter(player => player.userId !== userId)
      await this.persist(session)
      return `${this.getNickname(e)}已退出报名,当前${session.players.length}人`
    }
    if (session.phase !== 'playing') return "本局已揭晓,无需投降"
    const nowMs = this.now()
    const outcome = surrenderPlayer(session, userId, nowMs)
    if (outcome === 'not_participant' && !session.surrendered[userId]) return "你不在本局中(可能已投降过)"
    if (outcome === 'not_playing') return "本局已揭晓,无需投降"
    const record = session.surrendered[userId]
    if (!record) return "你不在本局中"
    const puzzle = this.findPuzzle(session.puzzleId)
    if (!puzzle) return "题库记录异常,请联系管理员"
    const privateText = [
      `【${puzzle.title}】汤底(仅发给你,请勿在群里剧透)`,
      '',
      puzzle.solution,
      puzzle.keyPoints.length ? `关键点:${puzzle.keyPoints.join(';')}` : '',
      '',
      '本局仍在继续,祝其他人好运。'
    ].filter(line => line !== '').join('\n')
    try {
      if (!this.ports.sendPrivate) throw new Error('私聊通道未配置')
      await this.ports.sendPrivate(userId, privateText, session.groupId)
      record.delivered = true
      await this.persist(session)
      if (outcome === 'last_player') return await this.finishGame(session, 'all_surrendered')
      return `${this.getNickname(e)}已投降并退场,汤底已私发。剩余${session.players.length}人继续`
    } catch (error) {
      await this.persist(session)
      this.ports.logger?.warn?.(`[海龟汤] 汤底私发失败: ${error instanceof Error ? error.message : String(error)}`)
      return `投降已记录,但汤底私发失败(已尝试群临时会话和好友私聊)。可加机器人为好友后再发一次 ${SOUP_COMMAND} 投降 重发汤底`
    }
  }

  async rateGame(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session || session.phase !== 'reveal' || !session.reveal) return "没有待评分的海龟汤(揭晓后才能评分)"
    if (this.now() >= session.reveal.ratingDeadlineAt) return "评分窗口已结束"
    const match = String(e?.msg || "").match(/^[.。]游戏\s+海龟汤\s*评分\s+([1-5])(?:\s+([\s\S]*?))?\s*$/)
    if (!match) return `用法:${SOUP_COMMAND} 评分 1-5 [一句话评论]`
    const userId = this.getUserId(e)
    const play = this.findLatestPlay(session.groupId)
    const puzzle = this.findPuzzle(session.puzzleId)
    if (!play || play.puzzleId !== session.puzzleId || !puzzle) return "记录异常,评分失败"
    try {
      const applied = upsertRating(play, puzzle, {userId, score: Number(match[1]), ...(match[2] ? {comment: match[2]} : {}), atMs: this.now()})
      await this.store.upsertPlay(applied.play)
      await this.store.savePuzzle(applied.puzzle)
      let extra = ''
      if (shouldRetirePuzzle(applied.puzzle)) {
        await this.store.savePuzzle({...applied.puzzle, status: 'retired'})
        extra = "\n(这道汤评分偏低,已自动出池不再投放)"
      }
      return `已记录评分:${applied.play.ratings.find(rating => rating.userId === userId)?.score ?? Number(match[1])}星${extra}`
    } catch (error) {
      return error instanceof Error ? error.message : "评分失败"
    }
  }

  inventory(e:TurtleSoupEvent):string {
    if (!this.isAdmin(e)) return "仅管理员可查看库存"
    const {puzzles} = this.store.readPuzzles()
    const plays = this.store.readPlays().plays
    const played = new Set(plays.map(play => play.puzzleId))
    const fresh = puzzles.filter(puzzle => puzzle.status === 'active' && !played.has(puzzle.id)).length
    const retired = puzzles.filter(puzzle => puzzle.status === 'retired').length
    const pending = puzzles.filter(puzzle => puzzle.status === 'pending').length
    return `题库:共${puzzles.length}道(鲜汤${fresh}/目标${this.config().freshPoolTarget},待审${pending},已玩过${played.size},低分出池${retired})${pending ? `\n有${pending}道待审:.游戏 海龟汤 待审 查看并发 过审/淘汰` : ""}${fresh + pending < this.config().freshPoolTarget ? "\n鲜汤不足,后台补货中;也可 .游戏 海龟汤 生成 <条数> 手动补充" : ""}`
  }

  // —— 题库审核:生成的新汤默认待审,过审才进入投放池 ——

  private findPending(selector:string):TurtleSoupPuzzle|null {
    const pending = this.store.readPuzzles().puzzles.filter(puzzle => puzzle.status === 'pending')
    const index = Number(selector)
    if (Number.isInteger(index) && index >= 1 && index <= pending.length) return pending[index - 1]!
    const hit = pending.find(puzzle => puzzle.id.startsWith(selector) || puzzle.title.includes(selector))
    return hit ?? null
  }

  listPending(e:TurtleSoupEvent):string {
    if (!this.isAdmin(e)) return "仅管理员可查看待审题"
    const pending = this.store.readPuzzles().puzzles.filter(puzzle => puzzle.status === 'pending')
    if (!pending.length) return "没有待审的海龟汤"
    const lines = [`待审海龟汤 ${pending.length} 道(过审后才会进入投放池):`]
    pending.forEach((puzzle, index) => {
      lines.push(`${index + 1}.【${puzzle.title}】(${puzzle.difficulty}) ${puzzle.surface.slice(0, 48)}…`)
    })
    lines.push(`.游戏 海龟汤 过审 <编号> 通过 · .游戏 海龟汤 淘汰 <编号> 弃用`)
    return lines.join("\n")
  }

  async reviewPuzzle(e:TurtleSoupEvent, action:'approve'|'reject'):Promise<string> {
    if (!this.isAdmin(e)) return "仅管理员可审核题库"
    const selector = String(e?.msg || "").match(/^[.。]游戏\s+海龟汤\s*(?:过审|淘汰)\s+(\S+)\s*$/)?.[1] || ""
    if (!selector) return "用法:.游戏 海龟汤 过审 <编号或标题> / 淘汰 <编号或标题>"
    const puzzle = this.findPending(selector)
    if (!puzzle) return `没找到对应的待审汤(可用编号或标题关键词)。发送 .游戏 海龟汤 待审 查看列表`
    await this.store.savePuzzle({...puzzle, status: action === 'approve' ? 'active' : 'retired'})
    return action === 'approve'
      ? `【${puzzle.title}】已过审,进入投放池`
      : `【${puzzle.title}】已淘汰`
  }

  async generateMore(e:TurtleSoupEvent):Promise<string> {
    if (!this.isAdmin(e)) return "仅管理员可生成题库"
    const count = Number(String(e?.msg || "").match(/^[.。]游戏\s+海龟汤\s*生成(?:\s+(\d+))?\s*$/)?.[1] || 5)
    const outcome:GenerateOutcome = await this.ports.generator.seed(count)
    if (outcome.lastError === 'busy') return "已有生成任务进行中,稍后再试"
    return `生成完成:成功${outcome.added}道,失败${outcome.failed}道${outcome.failed ? `\n最后错误:${outcome.lastError}` : ""}`
  }

  // 问答期兜底:已报名玩家的自由发言视为向主持人提问;括号内容算场外,整条只剩括号则忽略。
  async handleChat(e:TurtleSoupEvent):Promise<{reply:string;recap?:string}|null> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session || session.phase !== 'playing') return null
    const userId = this.getUserId(e)
    if (!isParticipant(session, userId)) return null
    const raw = String(e?.msg || '').replace(/\[CQ:[^\]]*\]/g, '')
    if (isAsideOnlyText(raw)) return null
    const question = stripAsideSegments(raw)
    if (!question || question.length > 300) return null
    // 提及命令本身(教别人发命令/讨论用法)属于游戏元讨论,不是提问
    if (question.includes('.游戏') || question.includes('。游戏')) return null
    if (!looksLikeSoupQuestion(question)) return null
    if (isRepeatedQuestion(session, userId, question)) return null
    const puzzle = this.findPuzzle(session.puzzleId)
    if (!puzzle) return null
    const nickname = this.getNickname(e)
    const answer = await this.ports.host.answerQuestion({
      question, solution: puzzle.solution, keyPoints: puzzle.keyPoints,
      history: session.qaLog.slice(-20).map(entry => ({question: entry.question, answer: entry.answer})),
      asker: nickname
    })
    const safeAnswer = looksLikeSolutionLeak(answer, puzzle.solution) ? '与此无关' : answer
    const nowMs = this.now()
    session.qaLog.push({userId, nickname, question, answer: safeAnswer, at: nowMs})
    session.lastActivityAt = nowMs
    await this.persist(session)
    const every = this.config().recapEveryQuestions
    const recap = every > 0 && session.qaLog.length > 0 && session.qaLog.length % every === 0 ? buildRecapText(session, puzzle) : undefined
    return recap === undefined ? {reply: safeAnswer} : {reply: safeAnswer, recap}
  }

  // —— 收局 ——

  private async finishGame(session:TurtleSoupSession, endReason:'solved'|'manual'|'idle_timeout'|'all_surrendered', winnerId?:string):Promise<string> {
    if (session.phase !== 'playing') return "本局已结束"
    const puzzle = this.findPuzzle(session.puzzleId)
    if (!puzzle) { await this.drop(session.groupId); return "题库记录异常,本局作废" }
    const nowMs = this.now()
    session.phase = 'reveal'
    session.reveal = {at: nowMs, ratingDeadlineAt: nowMs + this.config().ratingWindowMinutes * 60_000}
    let mvp = null
    try { mvp = await this.ports.host.selectMvp({brief: buildMvpBrief(session, winnerId)}) } catch (error) {
      this.ports.logger?.warn?.(`[海龟汤] MVP评选失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    const play = this.findOpenPlay(session.groupId)
    if (play) {
      play.endedAt = nowMs
      play.endReason = endReason
      play.solved = endReason === 'solved'
      if (winnerId) play.winnerId = winnerId
      if (mvp && session.players.some(player => player.userId === mvp.userId)) play.mvp = mvp
      // 投降者拿过汤底也算玩过(参与人维度去重需要)
      play.players = [...new Set([...session.players.map(player => player.userId), ...Object.keys(session.surrendered || {})])]
      play.qaCount = session.qaLog.length
      await this.store.upsertPlay(play)
    }
    await this.persist(session)
    return buildRevealText(session, puzzle, endReason, mvp, this.config())
  }

  private buildCatchUp(session:TurtleSoupSession):string {
    const puzzle = this.findPuzzle(session.puzzleId)
    return buildCatchUpText(session, puzzle, this.config())
  }

  // —— 超时sweeper ——

  async sweep():Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const nowMs = this.now()
      const config = this.config()
      for (const session of [...this.sessions.values()]) {
        if (session.phase === 'joining') {
          const outcome = joiningOutcome(session, nowMs, config.minPlayers)
          if (outcome === 'start') await this.broadcast(session.groupId, await this.launchPlay(session))
          else if (outcome === 'cancel') {
            await this.drop(session.groupId)
            await this.broadcast(session.groupId, `报名窗口结束,人数不足,本局取消。想玩再 ${SOUP_COMMAND} 开局`)
          }
        } else if (session.phase === 'choosing' && choosingTimedOut(session, nowMs)) {
          const candidates = session.choosing?.candidates ?? []
          const pickId = candidates[Math.floor(Math.random() * candidates.length)]
          await this.broadcast(session.groupId, `(无人选汤,自动随机)\n${await this.beginPlay(session, pickId)}`)
        } else if (session.phase === 'playing') {
          if (playingTimedOut(session, nowMs, config.idleTimeoutMinutes * 60_000)) {
            await this.broadcast(session.groupId, await this.finishGame(session, 'idle_timeout'))
          }
        } else if (session.phase === 'reveal' && revealTimedOut(session, nowMs)) {
          await this.broadcast(session.groupId, await this.archiveRevealed(session, '评分窗口结束,'))
        }
      }
    } finally { this.sweeping = false }
  }

  // 收掉评分窗口并归档本局:评分窗口超时(sweeper)与手动提前结束(endGame)共用
  private async archiveRevealed(session:TurtleSoupSession, opener:string):Promise<string> {
    await this.drop(session.groupId)
    const play = this.store.readPlays().plays.find(item => item.groupId === session.groupId && item.puzzleId === session.puzzleId)
    const summary = play && play.ratings.length
      ? `本局评分:${(play.ratings.reduce((sum, rating) => sum + rating.score, 0) / play.ratings.length).toFixed(1)}分(${play.ratings.length}人)`
      : '本局无人评分'
    return `${opener}${summary},本局归档。想再玩:${SOUP_COMMAND} 开局`
  }

  private async broadcast(groupId:string, message:string) {
    if (!this.ports.replyGroup) return
    try { await this.ports.replyGroup(groupId, message) } catch (error) {
      this.ports.logger?.warn?.(`[海龟汤] 群播报失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function phaseLabel(session:TurtleSoupSession):string {
  if (session.phase === 'joining') return '报名中'
  if (session.phase === 'playing') return '问答中'
  return '已揭晓待评分'
}
