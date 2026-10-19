// 海龟汤会话管理:命令处理、开局选汤、问答调度、揭晓收局与超时sweeper。
// 会话内存缓存+落盘恢复;时间驱动统一走sweep(),重启后靠时间戳继续判定,无僵尸局。
import type {TurtleSoupConfig, TurtleSoupEvent, TurtleSoupLogger, TurtleSoupPuzzle, TurtleSoupSession, TurtleSoupHost, TurtleSoupFeedbackCategory, TurtleSoupGuessEntry} from '../../../../contracts/turtleSoup.js'
import {TurtleSoupStore, readTurtleSoupConfig} from './TurtleSoupStore.js'
import type {TurtleSoupGenerator, GenerateOutcome} from './TurtleSoupGenerator.js'
import {buildMvpBrief, canManualStart, guessCooldownRemainingMs, isParticipant, joiningOutcome, playingTimedOut, revealTimedOut, selectPuzzleId, takeHint, buildCatchUpText, buildStatusText, buildRevealText, buildRecapText, formatDuration, formatCountdown, stripAsideSegments, isAsideOnlyText, SOUP_COMMAND, surrenderPlayer, looksLikeSoupQuestion, isRepeatedQuestion, choosingTimedOut, chooseWindowMs, puzzlePlayStats, soupCandidatesFor, selectPuzzleMenu, puzzleFamilyId, nicknameOf, canServePuzzle} from '../../domain/turtleSoup/turtleSoupRules.js'
import {literalSoupSimilarity, looksLikeSolutionLeak, normalizeSoupText} from '../../domain/turtleSoup/turtleSoupSimilarity.js'
import {hasCurrentPassingAudits, puzzleContentHash} from '../../domain/turtleSoup/turtleSoupQuality.js'
import {randomUUID} from 'node:crypto'

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
  "开局后自由发言提问,我只回答:是 / 不是 / 是也不是 / 与此无关 / 无法确定",
  "括号里的内容算场外(角色扮演/旁白),我不会回应",
  `${SOUP_COMMAND} 猜 <答案> —— 猜汤底,猜中即胜`,
  `${SOUP_COMMAND} 投降 —— 个人投降,汤底私发给你(退场,请勿剧透)`,
  `${SOUP_COMMAND} 提示 —— 逐级取提示(每局有限)`,
  `${SOUP_COMMAND} 状态 / ${SOUP_COMMAND} 结束(发起人或管理)`,
  `${SOUP_COMMAND} 换汤 [原因] —— 旧局保留评分窗口`,
  `揭晓或换汤后:${SOUP_COMMAND} 评分 [局号|上一局] 1-5 [逻辑|线索|提示|主持|难度|题材|技术] [评论],可直接开下一局`
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
  private readonly groupQueues = new Map<string, Promise<unknown>>()
  private readonly pendingQuestions = new Set<string>()
  private readonly pendingGuesses = new Set<string>()
  private readonly backgroundTasks = new Set<Promise<unknown>>()
  private readonly hostControllers = new Map<string, Set<AbortController>>()

  constructor(ports:TurtleSoupManagerPorts) {
    this.ports = ports
    this.store = new TurtleSoupStore({cwd: ports.cwd ?? process.cwd(), baseDir: this.config().baseDir})
    this.sessions = new Map(Object.entries(this.store.readSessions().sessions))
    const plays = this.store.readPlays().plays
    for (const session of this.sessions.values()) {
      session.sessionId ||= randomUUID()
      session.revision ??= 0
      session.participantHistory ??= [...session.players]
      const play = plays.filter(play => play.groupId === session.groupId && play.puzzleId === session.puzzleId).sort((a, b) => b.startedAt - a.startedAt)[0]
      if (!session.playId && play) session.playId = play.playId
    }
  }

  config():TurtleSoupConfig { return this.ports.config ? this.ports.config() : readTurtleSoupConfig(this.ports.cwd ?? process.cwd()) }

  start() {
    const interval = this.ports.sweepIntervalMs ?? 30_000
    if (!this.sweeperTimer) this.sweeperTimer = setInterval(() => {
      void this.sweep().catch(error => this.ports.logger?.warn?.(`[海龟汤] 超时检查失败: ${error instanceof Error ? error.message : String(error)}`))
    }, interval)
  }

  stop() {
    if (this.sweeperTimer) { clearInterval(this.sweeperTimer); this.sweeperTimer = null }
  }

  async waitForBackgroundTasks():Promise<void> { await Promise.allSettled([...this.backgroundTasks]) }

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

  private makePlayId() { return `pl_${randomUUID()}` }

  private async hostCall<T>(call:(signal:AbortSignal) => Promise<T>, sessionId?:string):Promise<T> {
    const controller = new AbortController()
    if (sessionId) {
      const controllers = this.hostControllers.get(sessionId) ?? new Set<AbortController>()
      controllers.add(controller)
      this.hostControllers.set(sessionId, controllers)
    }
    const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {once: true}))
    const timer = setTimeout(() => controller.abort(new Error('主持请求超时')), 45_000)
    timer.unref?.()
    try { return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return call(controller.signal) }), cancelled]) }
    finally {
      clearTimeout(timer)
      if (sessionId) {
        const controllers = this.hostControllers.get(sessionId)
        controllers?.delete(controller)
        if (!controllers?.size) this.hostControllers.delete(sessionId)
      }
    }
  }

  private invalidateRequests(session:TurtleSoupSession) {
    if (session.sessionId) for (const controller of this.hostControllers.get(session.sessionId) ?? []) controller.abort(new Error('对局已结束或换汤'))
  }

  // 群内状态操作串行化;模型调用与私聊交付在锁外,换汤/结束不被网络请求阻塞。
  private async inGroup<T>(groupId:string, action:() => Promise<T>):Promise<T> {
    const previous = this.groupQueues.get(groupId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    this.groupQueues.set(groupId, next)
    try { return await next } finally { if (this.groupQueues.get(groupId) === next) this.groupQueues.delete(groupId) }
  }

  private requestIsCurrent(session:TurtleSoupSession, revision:number, userId?:string):boolean {
    const current = this.sessions.get(session.groupId)
    return current === session && current.phase === 'playing' && current.sessionId === session.sessionId && current.playId === session.playId && (current.revision ?? 0) === revision && (!userId || isParticipant(current, userId))
  }

  private async persist(session:TurtleSoupSession) {
    await this.store.saveSession(session)
    this.sessions.set(session.groupId, session)
  }

  private async drop(groupId:string) {
    await this.store.removeSession(groupId)
    this.sessions.delete(groupId)
  }

  async openGame(e:TurtleSoupEvent):Promise<string> { return this.inGroup(this.getGroupId(e), () => this.openGameLocked(e)) }
  async joinGame(e:TurtleSoupEvent):Promise<string> { return this.inGroup(this.getGroupId(e), () => this.joinGameLocked(e)) }
  async cancelGame(e:TurtleSoupEvent):Promise<string> { return this.inGroup(this.getGroupId(e), () => this.cancelGameLocked(e)) }
  async startGame(e:TurtleSoupEvent):Promise<string> { return this.inGroup(this.getGroupId(e), () => this.startGameLocked(e)) }
  async choosePuzzle(e:TurtleSoupEvent):Promise<string> { return this.inGroup(this.getGroupId(e), () => this.choosePuzzleLocked(e)) }
  async useHint(e:TurtleSoupEvent):Promise<string> { return this.inGroup(this.getGroupId(e), () => this.useHintLocked(e)) }
  async endGame(e:TurtleSoupEvent):Promise<string> { return this.inGroup(this.getGroupId(e), () => this.endGameLocked(e)) }
  async switchPuzzle(e:TurtleSoupEvent):Promise<string> { return this.inGroup(this.getGroupId(e), () => this.switchPuzzleLocked(e)) }

  // —— 命令入口(返回文本由app层发送;返回null表示不处理) ——

  showHelp():string { return HELP_TEXT }

  showHub():string { return HUB_TEXT }

  private async openGameLocked(e:TurtleSoupEvent):Promise<string> {
    if (!this.config().enabled) return "小游戏功能未开启"
    const groupId = this.getGroupId(e)
    if (!groupId) return "海龟汤仅支持群聊"
    const existing = this.sessions.get(groupId)
    if (existing) {
      if (existing.phase === 'reveal') await this.drop(groupId)
      else return `本局还在进行中(${phaseLabel(existing)}),可用 ${SOUP_COMMAND} 状态 查看,或 ${SOUP_COMMAND} 结束 收局`
    }
    if (this.ports.isOtherGameActive?.(groupId)) return "本群有进行中的赛马娘比赛,等它结束再开海龟汤" 
    const nowMs = this.now()
    const session:TurtleSoupSession = {
      groupId, phase: 'joining', puzzleId: '', initiatorId: this.getUserId(e),
      players: [{userId: this.getUserId(e), nickname: this.getNickname(e), joinedAt: nowMs}], createdAt: nowMs,
      joinDeadlineAt: nowMs + this.config().joinWindowMinutes * 60_000,
      lastActivityAt: nowMs, qaLog: [], guessLog: [], usedHints: 0, lastGuessAt: {}, surrendered: {}, sessionId: randomUUID(), revision: 0
    }
    session.participantHistory = [...session.players]
    await this.persist(session)
    const minutes = formatDuration(this.config().joinWindowMinutes * 60_000)
    return [
      "🐢 海龟汤开局报名开始!",
      `发起人:${this.getNickname(e)}已自动上桌`,
      `其他人想玩的发送 ${SOUP_COMMAND} 加入 (最少${this.config().minPlayers}人,${minutes}内有效)`,
      `人齐后发起人可发 ${SOUP_COMMAND} 开始 提前开局,随后全员三选一挑汤;不想玩了发 ${SOUP_COMMAND} 取消 立即取消(到点人数够也会自动开局)`
    ].join("\n")
  }

  private async joinGameLocked(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session) return `本群还没有报名中的海龟汤,发送 ${SOUP_COMMAND} 开局 发起`
    const nowMs = this.now()
    const userId = this.getUserId(e), nickname = this.getNickname(e)
    const existing = session.players.find(player => player.userId === userId)
    if (existing) return `${nickname}已经在牌桌上了`
    if (session.phase !== 'joining' && session.phase !== 'choosing' && session.phase !== 'playing') return "本局已结束,等待下一局"
    if (session.phase === 'choosing') {
      const puzzles = this.store.readPuzzles().puzzles
      const stats = puzzlePlayStats(this.store.readPlays().plays, puzzles)
      const eligible = new Set(soupCandidatesFor(puzzles, stats, session.groupId, [...session.players.map(player => player.userId), userId]).strict.map(puzzle => puzzle.id))
      const candidates = (session.choosing?.candidates ?? []).filter(id => eligible.has(id))
      if (!candidates.length) return `${nickname}已看过当前候选的汤底,本局不能加入;请等待下一道新汤`
      if (session.choosing) session.choosing.candidates = candidates
      session.players.push({userId, nickname, joinedAt: nowMs})
      session.participantHistory = [...session.players]
      session.lastActivityAt = nowMs
      await this.persist(session)
      return `${nickname}加入!正在选汤,开局后一起玩\n${candidates.map((id, index) => `${index + 1}.【${this.findPuzzle(id)?.title ?? id}】`).join('\n')}`
    }
    if (session.phase === 'playing') {
      if (session.surrendered[userId]) return `${nickname}已投降并看过汤底,本局不能再加入`
      const puzzle = this.findPuzzle(session.puzzleId)
      const next:TurtleSoupSession = {...session, players: [...session.players, {userId, nickname, joinedAt: nowMs}], participantHistory: [...(session.participantHistory ?? session.players), {userId, nickname, joinedAt: nowMs}], lastActivityAt: nowMs}
      const accepted = await this.store.transaction(state => {
        const stats = puzzlePlayStats(state.plays.filter(play => play.playId !== session.playId), state.puzzles)
        if (puzzle && stats.get(puzzleFamilyId(puzzle))?.users.has(userId)) return false
        const play = state.plays.find(item => item.playId === session.playId)
        if (play) { play.players = [...new Set([...play.players, userId])]; play.participantHistory = next.participantHistory ?? [...next.players] }
        state.sessions[session.groupId] = next
        return true
      })
      if (!accepted) return `${nickname}已看过这道汤或其旧版本,本局不能加入`
      Object.assign(session, next)
      return `${nickname}中途加入!\n${this.buildCatchUp(session)}`
    }
    session.players.push({userId, nickname, joinedAt: nowMs})
    session.participantHistory = [...session.players]
    session.lastActivityAt = nowMs
    await this.persist(session)
    return `${nickname}加入!当前${session.players.length}人(最少${this.config().minPlayers}人)`
  }

  // 报名期:发起人/管理可立即取消本局;问答期与评分窗等价于 结束(揭晓/归档)。
  private async cancelGameLocked(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session) return "本群没有进行中的海龟汤"
    if (session.phase === 'joining' || session.phase === 'choosing') {
      if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) return "只有发起人或群管理可以取消报名"
      await this.drop(session.groupId)
      return `报名已取消,本局作废。想玩再 ${SOUP_COMMAND} 开局`
    }
    return await this.endGameLocked(e)
  }

  private async startGameLocked(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session || session.phase !== 'joining') return `本群没有报名中的海龟汤(发送 ${SOUP_COMMAND} 开局 发起)`
    if (!canManualStart(session, this.config().minPlayers)) return `人数还不够(最少${this.config().minPlayers}人),继续 ${SOUP_COMMAND} 加入`
    if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) return "只有发起人或群管理可以提前开局"
    return await this.launchPlay(session)
  }

  // 开局上菜:多于一道可选时进入三选一窗口,只有一道直接开局,没有则提示补库
  private async launchPlay(session:TurtleSoupSession):Promise<string> {
    const puzzles = this.store.readPuzzles().puzzles
    const shuffled = selectPuzzleMenu(puzzles, this.store.readPlays().plays, session.groupId, session.players.map(player => player.userId))
    if (!shuffled.length) {
      await this.drop(session.groupId)
      return "题库里已经没有本群及当前玩家都没看过的汤了,请管理员用 .游戏 海龟汤 生成 补充并审核题库后再开局"
    }
    if (shuffled.length === 1) return await this.beginPlay(session, shuffled[0]!.id)
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
  private async choosePuzzleLocked(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session || session.phase !== 'choosing' || !session.choosing) return "现在不在选汤环节(先用 .游戏 海龟汤 开始 进入选汤)"
    if (!isParticipant(session, this.getUserId(e))) return "先 .游戏 海龟汤 加入 才能选汤"
    const pick = String(e?.msg || '').match(/^[.。]游戏\s+海龟汤\s*选\s*(随机|1|2|3|一|二|三)\s*$/)?.[1]
    if (!pick) return `用法:${SOUP_COMMAND} 选 1~${session.choosing.candidates.length} 或 ${SOUP_COMMAND} 选 随机`
    const index = pick === '随机' ? Math.floor(Math.random() * session.choosing.candidates.length)
      : (({'1': 0, '一': 0, '2': 1, '二': 1, '3': 2, '三': 2} as Record<string, number>)[pick] ?? 0)
    const puzzleId = session.choosing.candidates[index]
    if (!puzzleId) return `本次只有${session.choosing.candidates.length}道候选,请按菜单序号选择`
    const puzzle = this.findPuzzle(puzzleId)
    if (!puzzle) return "候选记录异常,请重试或等待超时随机开局"
    const title = puzzle.title
    const result = await this.beginPlay(session, puzzleId)
    return `就吃【${title}】!\n${result}`
  }

  private async beginPlay(session:TurtleSoupSession, chosenPuzzleId?:string):Promise<string> {
    if (session.players.length < Math.max(1, this.config().minPlayers)) {
      session.phase = 'joining'
      delete session.choosing
      session.joinDeadlineAt = this.now() + this.config().joinWindowMinutes * 60_000
      await this.persist(session)
      return `人数不足,已回到报名阶段,至少${this.config().minPlayers}人才能开始`
    }
    const puzzles = this.store.readPuzzles().puzzles
    const plays = this.store.readPlays().plays
    const puzzleId = chosenPuzzleId ?? selectPuzzleId(puzzles, plays, session.groupId, Math.random, session.players.map(player => player.userId))
    if (!puzzleId) {
      await this.drop(session.groupId)
      return "题库里已经没有未曝光的新汤了,请管理员用 .游戏 海龟汤 生成 补充题库后再开局"
    }
    const puzzle = this.findPuzzle(puzzleId)
    if (!puzzle) {
      await this.drop(session.groupId)
      return "题库记录异常,本局取消"
    }
    if (!soupCandidatesFor(puzzles, puzzlePlayStats(plays, puzzles), session.groupId, session.players.map(player => player.userId)).strict.some(item => item.id === puzzleId)) return await this.launchPlay(session)
    const nowMs = this.now()
    const next:TurtleSoupSession = {...session, phase: 'playing', puzzleId, startedAt: nowMs, lastActivityAt: nowMs, playId: this.makePlayId(), revision: (session.revision ?? 0) + 1, participantHistory: [...session.players]}
    delete next.choosing
    const accepted = await this.store.transaction(state => {
      if (!soupCandidatesFor(state.puzzles, puzzlePlayStats(state.plays, state.puzzles), session.groupId, session.players.map(player => player.userId)).strict.some(item => item.id === puzzleId)) return false
      state.sessions[session.groupId] = next
      state.plays.push({
        playId: next.playId!, puzzleId, familyId: puzzleFamilyId(puzzle), puzzleTitle: puzzle.title, groupId: session.groupId,
        startedAt: nowMs, solved: false, players: session.players.map(player => player.userId), participantHistory: [...session.players], qaCount: 0, ratings: []
      })
      return true
    })
    if (!accepted) return await this.launchPlay(session)
    Object.assign(session, next)
    delete session.choosing
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
      `现在开始自由提问,我只回答:是 / 不是 / 是也不是 / 与此无关 / 无法确定`,
      `(括号)里的内容算场外,我不会回应`,
      `${SOUP_COMMAND} 猜 <答案> —— 猜汤底,猜中即胜`,
      `${SOUP_COMMAND} 提示 —— 卡住了要提示(每局${this.config().maxHints}条)`,
      `${SOUP_COMMAND} 投降 —— 汤底私发给你并退场,别剧透`,
      `围观想上车:随时 ${SOUP_COMMAND} 加入`,
      ...(every > 0 ? [`每${every}次提问我会发一张进度卡(汤面+问答汇总)`] : []),
      `${idle}没有有效游戏操作本局自动揭晓`
    ].join("\n")
  }

  async guessSoup(e:TurtleSoupEvent):Promise<string> {
    const groupId = this.getGroupId(e), userId = this.getUserId(e), nickname = this.getNickname(e)
    const prepared = await this.inGroup(groupId, async () => {
      const session = this.sessions.get(groupId)
      if (!session || session.phase !== 'playing') return "现在没有进行中的海龟汤"
      if (!isParticipant(session, userId)) return `先 ${SOUP_COMMAND} 加入 才能猜汤底`
      const puzzle = this.findPuzzle(session.puzzleId)
      if (!puzzle) return "题库记录异常,请联系管理员"
      const guess = String(e?.msg || '').replace(/^[.。]游戏\s+海龟汤\s*(?:猜汤底|猜|答案)\s*/, '').trim()
      if (!guess || guess.length > 3000) return `用法:${SOUP_COMMAND} 猜 <3000字以内的答案>`
      const requestKey = `${session.sessionId}:${userId}`
      if (this.pendingGuesses.has(requestKey)) return "你的上一条猜测正在判定,请稍候"
      const nowMs = this.now()
      const cooldown = guessCooldownRemainingMs(session, userId, nowMs, this.config().guessCooldownSeconds * 1000)
      if (cooldown > 0) return `猜测冷却中,还剩${formatCountdown(cooldown)}`
      session.lastGuessAt[userId] = nowMs
      session.lastActivityAt = nowMs
      await this.persist(session)
      this.pendingGuesses.add(requestKey)
      return {session, puzzle, guess, nowMs, revision: session.revision ?? 0, requestKey, score: literalSoupSimilarity(guess, puzzle.solution)}
    })
    if (typeof prepared === 'string') return prepared
    const {session, puzzle, guess, nowMs, revision, requestKey, score} = prepared
    try {
      const verdict = await this.hostCall(signal => this.ports.host.judgeGuess({guess, solution: puzzle.solution, keyPoints: puzzle.keyPoints, signal,
        keyPointIds: puzzle.keyPointIds ?? puzzle.keyPoints.map((_, index) => `kp${index + 1}`),
        requiredKeyPointIds: puzzle.requiredKeyPointIds?.length ? puzzle.requiredKeyPointIds : puzzle.keyPointIds ?? puzzle.keyPoints.map((_, index) => `kp${index + 1}`), literalScore: score}), session.sessionId)
      return await this.inGroup(groupId, async () => {
        if (!this.requestIsCurrent(session, revision, userId)) return "这条猜测所属的对局已变更,判定已作废"
        if (verdict.status === 'unavailable') {
          delete session.lastGuessAt[userId]
          await this.persist(session)
          return "主持人暂时无法可靠判定,本次不计失败和冷却,请重试"
        }
        const entry:TurtleSoupGuessEntry = {userId, guess, literalScore: score, final: verdict.correct ? 'hit' : 'miss', at: nowMs}
        if (verdict.correct) return await this.finishGame(session, 'solved', userId, entry)
        session.guessLog.push(entry)
        await this.persist(session)
        if (verdict.closeness >= 100) return `主持人:${nickname}覆盖了必需要点,但完整推理仍有矛盾,请再检查一下`
        return `主持人:${nickname}没猜中——关键事实覆盖约${verdict.closeness}%`
      })
    } catch (error) {
      this.ports.logger?.warn?.(`[海龟汤] 判题失败: ${error instanceof Error ? error.message : String(error)}`)
      return await this.inGroup(groupId, async () => {
        if (!this.requestIsCurrent(session, revision, userId)) return "这条猜测所属的对局已变更,判定已作废"
        delete session.lastGuessAt[userId]
        await this.persist(session)
        return "主持人判题暂时失败,本次不计失败和冷却,请重试"
      })
    } finally { this.pendingGuesses.delete(requestKey) }
  }

  private async useHintLocked(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session || session.phase !== 'playing') return "现在没有进行中的海龟汤"
    if (!isParticipant(session, this.getUserId(e))) return `先 ${SOUP_COMMAND} 加入 才能用提示`
    const puzzle = this.findPuzzle(session.puzzleId)
    if (!puzzle) return "题库记录异常,请联系管理员"
    const nowMs = this.now()
    const remain = (session.lastHintAt ?? 0) + (this.config().hintCooldownSeconds ?? 15) * 1000 - nowMs
    if (session.usedHints < this.config().maxHints && remain > 0) return `先一起讨论上一条提示,${formatCountdown(remain)}后可取下一条`
    const hint = takeHint(session, puzzle.hints, this.config().maxHints)
    if (hint === null) return session.usedHints >= this.config().maxHints ? "本局提示已用完" : "这道题没有更多提示了"
    session.lastActivityAt = nowMs
    session.lastHintAt = nowMs
    await this.persist(session)
    return `提示(${session.usedHints}/${this.config().maxHints}):${hint}`
  }

  showStatus(e:TurtleSoupEvent):string {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session) return `本群没有进行中的海龟汤,发送 ${SOUP_COMMAND} 开局 发起`
    return buildStatusText(session, this.config(), this.now())
  }

  private async endGameLocked(e:TurtleSoupEvent):Promise<string> {
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
      return await this.archiveRevealed(session, '本局已归档,评分窗口保留至原截止时间,')
    }
    if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) return "只有发起人或群管理可以结束本局"
    return await this.finishGame(session, 'manual')
  }

  // 换汤:当局直接废弃,原班人马立刻新开一局(换汤不换人)
  private async switchPuzzleLocked(e:TurtleSoupEvent):Promise<string> {
    const session = this.sessions.get(this.getGroupId(e))
    if (!session) return "本群没有进行中的海龟汤"
    if (session.phase !== 'playing' && session.phase !== 'choosing') return "只有问答中/选汤中才能换汤"
    if (this.getUserId(e) !== session.initiatorId && !this.isAdmin(e)) return "只有发起人或群管理可以换汤"
    if (session.players.length < Math.max(1, this.config().minPlayers)) return `人数不足(最少${this.config().minPlayers}人),换汤后无法开局,可用 ${SOUP_COMMAND} 结束 收局`
    const oldTitle = this.findPuzzle(session.puzzleId)?.title || '上一题'
    // 本局按"换汤"废弃归档,旧题计入游玩史(新局不会再随机到它)
    const play = await this.store.transaction(state => {
      const current = state.plays.find(item => item.playId === session.playId)
      if (current) {
        current.endedAt = this.now()
        current.endReason = 'switched'
        current.ratingDeadlineAt = this.now() + this.config().ratingWindowMinutes * 60_000
        current.switchReason = String(e.msg ?? '').replace(/^[.。]游戏\s+海龟汤\s*换汤\s*/, '').trim().slice(0, 500) || '未填写原因'
        current.players = [...new Set([...(session.participantHistory ?? session.players).map(player => player.userId), ...Object.keys(session.surrendered || {})])]
        current.qaCount = session.qaLog.length
        current.qaLog = session.qaLog.slice(-200)
        current.guessLog = session.guessLog.slice(-100)
        current.participantHistory = session.participantHistory ?? [...session.players]
        current.usedHints = session.usedHints
      }
      delete state.sessions[session.groupId]
      return current ?? null
    })
    session.revision = (session.revision ?? 0) + 1
    this.invalidateRequests(session)
    this.sessions.delete(session.groupId)
    // 原班人马直接进入新局:重建会话并立即上菜
    const nowMs = this.now()
    const next:TurtleSoupSession = {
      groupId: session.groupId, phase: 'joining', puzzleId: '', initiatorId: session.initiatorId,
      players: session.players, createdAt: nowMs,
      joinDeadlineAt: nowMs + this.config().joinWindowMinutes * 60_000,
      lastActivityAt: nowMs, qaLog: [], guessLog: [], usedHints: 0, lastGuessAt: {}, surrendered: {}, sessionId: randomUUID(), revision: 0, participantHistory: [...session.players]
    }
    await this.persist(next)
    const menu = await this.launchPlay(next)
    return `已放弃【${oldTitle}】,换汤不换人,原班${next.players.length}人继续!${play ? `\n旧汤可评:${SOUP_COMMAND} 评分 ${play.playId} 1-5 [评论]` : ''}\n${menu}`
  }

  // 排行榜:汤永久记录,按评分展示 x人评分x星
  rankings():string {
    const rated = this.store.readPuzzles().puzzles
      .filter(puzzle => puzzle.ratingCount > 0)
      .map(puzzle => ({title: puzzle.title, count: puzzle.ratingCount, score: puzzle.ratingSum / puzzle.ratingCount, status: puzzle.status}))
      .sort((left, right) => right.score - left.score || right.count - left.count)
    if (!rated.length) return "还没有汤被评过分。揭晓后发 .游戏 海龟汤 评分 1-5 就能攒榜"
    const lines = ["🏆 海龟汤榜单(永久记录):"]
    rated.slice(0, 10).forEach((item, index) => {
      lines.push(`${index + 1}.【${item.title}】${item.count}人评分${item.score.toFixed(1)}星${item.score >= 4.5 && item.count >= 3 ? " ⭐精选" : ""}${item.status === 'retired' ? '(已出池)' : ""}`)
    })
    if (rated.length > 10) lines.push(`…共${rated.length}道有评分记录`)
    return lines.join("\n")
  }

  // 个人投降:汤底私发给投降者,其退出本局;最后一名玩家投降则公开收局。
  async surrender(e:TurtleSoupEvent):Promise<string> {
    const groupId = this.getGroupId(e), userId = this.getUserId(e)
    const prepared = await this.inGroup(groupId, async () => {
      const session = this.sessions.get(groupId)
      if (!session) return "本群没有进行中的海龟汤"
      if (session.phase === 'joining' || session.phase === 'choosing') {
        if (!isParticipant(session, userId)) return "你还没有加入报名"
        session.players = session.players.filter(player => player.userId !== userId)
        session.participantHistory = [...session.players]
        if (!session.players.length) { await this.drop(groupId); return "所有玩家已退出,本局取消" }
        if (session.initiatorId === userId) session.initiatorId = session.players[0]!.userId
        await this.persist(session)
        return `${this.getNickname(e)}已退出报名,当前${session.players.length}人`
      }
      if (session.phase !== 'playing') return "本局已揭晓,汤底见群内揭晓消息,无需再投降"
      const puzzle = this.findPuzzle(session.puzzleId)
      if (!puzzle) return "题库记录异常,请联系管理员"
      const outcome = surrenderPlayer(session, userId, this.now())
      if (outcome === 'not_participant') return "你不在本局中(可能已投降过)"
      const record = session.surrendered[userId]
      if (!record) return "你不在本局中"
      // 收局与私聊交付分离:零人时直接公开揭晓,即使私聊不可用也不会遗留空局。
      if (!session.players.length) return await this.finishGame(session, 'all_surrendered')
      await this.persist(session)
      if (record.delivered) return `你已投降并退场,汤底已私发。剩余${session.players.length}人继续`
      return {session, record, revision: session.revision ?? 0, privateText: [`【${puzzle.title}】汤底(仅发给你,请勿在群里剧透)`, puzzle.solution,
        puzzle.keyPoints.length ? `关键点:${puzzle.keyPoints.join(';')}` : '', '本局仍在继续,祝其他人好运。'].filter(Boolean).join('\n')}
    })
    if (typeof prepared === 'string') return prepared
    const {session, record, revision, privateText} = prepared
    let delivered = false
    try {
      if (!this.ports.sendPrivate) throw new Error('私聊通道未配置')
      await this.ports.sendPrivate(userId, privateText, groupId)
      delivered = true
    } catch (error) {
      this.ports.logger?.warn?.(`[海龟汤] 汤底私发失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    return await this.inGroup(groupId, async () => {
      if (!this.requestIsCurrent(session, revision)) return delivered ? '汤底已私发;原对局已结束或换汤' : '原对局已结束或换汤,私发未成功;已揭晓的汤底可查看群记录'
      record.delivered = delivered
      await this.persist(session)
      return delivered
        ? `${this.getNickname(e)}已投降并退场,汤底已私发。剩余${session.players.length}人继续`
        : `投降已记录,但汤底私发失败。可加机器人为好友后再发一次 ${SOUP_COMMAND} 投降 重发汤底`
    })
  }

  async rateGame(e:TurtleSoupEvent):Promise<string> {
    const match = String(e?.msg || '').match(/^[.。]游戏\s+海龟汤\s*评分\s+(?:(上一局|pl_[\w-]+)\s+)?([1-5])(?:\s+([\s\S]*?))?\s*$/)
    if (!match) return `用法:${SOUP_COMMAND} 评分 [局号|上一局] 1-5 [一句话评论]`
    const userId = this.getUserId(e), nowMs = this.now()
    const plays = this.store.readPlays().plays.filter(play => play.groupId === this.getGroupId(e) && play.endedAt !== undefined)
    const explicit = match[1] && match[1] !== '上一局' ? match[1] : null
    const play = explicit ? plays.find(item => item.playId === explicit) : plays.filter(item => item.players.includes(userId)).reverse().sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.startedAt - a.startedAt)[0]
    if (!play) return "没有待评分的海龟汤(揭晓或换汤后才能评分,仅参与者可评)"
    const categories:Record<string,TurtleSoupFeedbackCategory> = {'逻辑': 'logic', '线索': 'clues', '提示': 'hints', '主持': 'host', '难度': 'difficulty', '题材': 'taste', '技术': 'technical', '其他': 'other'}
    const feedback = String(match[3] ?? '').trim().slice(0, 1000)
    const categorized = feedback.match(/^(逻辑|线索|提示|主持|难度|题材|技术|其他)(?:\s+|$)([\s\S]*)/)
    const category = categorized ? categories[categorized[1]!] ?? 'other' : 'other'
    const comment = categorized ? categorized[2] ?? '' : feedback
    try {
      const applied = await this.store.recordRating({playId: play.playId, userId, score: Number(match[2]), ...(comment ? {comment} : {}), category, atMs: nowMs,
        ratingDeadlineAt: play.ratingDeadlineAt ?? (play.endedAt ?? nowMs) + this.config().ratingWindowMinutes * 60_000})
      return `已记录评分:${Number(match[2])}星【${applied.puzzle.title}】${applied.retired ? '\n(这道汤暂缓投放,待管理员复核;评分仍可在窗口内修改)' : ''}`
    } catch (error) { return error instanceof Error ? error.message : "评分失败" }
  }

  inventory(e:TurtleSoupEvent):string {
    if (!this.isAdmin(e)) return "仅管理员可查看库存"
    const {puzzles} = this.store.readPuzzles()
    const plays = this.store.readPlays().plays
    const stats = puzzlePlayStats(plays, puzzles)
    const playable = puzzles.filter(canServePuzzle)
    const fresh = new Set(playable.filter(puzzle => !stats.has(puzzleFamilyId(puzzle))).map(puzzleFamilyId)).size
    const available = soupCandidatesFor(puzzles, stats, this.getGroupId(e), this.sessions.get(this.getGroupId(e))?.players.map(player => player.userId) ?? []).strict.length
    const retired = puzzles.filter(puzzle => puzzle.status === 'retired').length
    const pending = puzzles.filter(puzzle => puzzle.status === 'pending').length
    return `题库:共${puzzles.length}个版本(鲜汤${fresh}/目标${this.config().freshPoolTarget},本群当前可选${available},待审/复核${pending},已曝光${stats.size}个故事,已停用${retired})${pending ? `\n有${pending}道待审:.游戏 海龟汤 待审 查看;请先完成控制台审核` : ''}${fresh < this.config().freshPoolTarget ? '\n可投放鲜汤不足;待审不等于可用库存,请检查生成和审核状态' : ''}`
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
    if (action === 'approve' && !hasCurrentPassingAudits(puzzle)) return `【${puzzle.title}】当前版本尚未通过完整审核,请先在控制台重新审核并查看问题`
    try {
      await this.store.transaction(state => {
        const current = state.puzzles.find(item => item.id === puzzle.id)
        if (!current) throw new Error('题目不存在')
        if (current.status !== 'pending') throw new Error('题目状态已变化,请刷新待审列表')
        if (action === 'approve' && !hasCurrentPassingAudits(current)) throw new Error('当前版本尚未通过完整审核')
        if (action === 'approve' && state.puzzles.some(item => item.id !== current.id && item.status === 'active' && puzzleFamilyId(item) === puzzleFamilyId(current) && (item.version || 1) > (current.version || 1))) throw new Error('同一道题已有更新版本投放,请先处理新版后再恢复旧版')
        const status = action === 'approve' ? 'active' : 'retired'
        current.statusHistory = [...(current.statusHistory ?? []), {from: current.status, to: status, reason: action === 'approve' ? '管理员复核通过' : '管理员淘汰', actor: this.getUserId(e), at: this.now(), contentHash: puzzleContentHash(current)}]
        current.status = status
        if (action === 'approve') for (const previous of state.puzzles) {
          if (previous.id === current.id || previous.status !== 'active' || puzzleFamilyId(previous) !== puzzleFamilyId(current)) continue
          previous.statusHistory = [...(previous.statusHistory ?? []), {from: 'active', to: 'retired', reason: `由新版本${current.id}替代`, actor: this.getUserId(e), at: this.now(), contentHash: puzzleContentHash(previous)}]
          previous.status = 'retired'
        }
      })
    } catch (error) { return error instanceof Error ? error.message : '审核失败,请刷新后重试' }
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
    const groupId = this.getGroupId(e), userId = this.getUserId(e)
    const prepared = await this.inGroup(groupId, async () => {
      const session = this.sessions.get(groupId)
      if (!session || session.phase !== 'playing' || !isParticipant(session, userId)) return null
      const raw = String(e?.msg || '').replace(/\[CQ:[^\]]*\]/g, '')
      if (isAsideOnlyText(raw)) return null
      const question = stripAsideSegments(raw)
      if (!question || question.length > 300 || question.includes('.游戏') || question.includes('。游戏') || !looksLikeSoupQuestion(question) || isRepeatedQuestion(session, userId, question)) return null
      const puzzle = this.findPuzzle(session.puzzleId)
      if (!puzzle) return null
      const requestKey = `${session.sessionId}:${userId}:${normalizeSoupText(question)}`
      if (this.pendingQuestions.has(requestKey)) return null
      if ([...this.pendingQuestions].filter(key => key.startsWith(`${session.sessionId}:`)).length >= 3) return {reply: '主持人正在回答前面的提问,请稍候再问'}
      this.pendingQuestions.add(requestKey)
      session.lastActivityAt = this.now()
      try { await this.persist(session) } catch (error) { this.pendingQuestions.delete(requestKey); throw error }
      return {session, puzzle, question, requestKey, revision: session.revision ?? 0, nickname: this.getNickname(e), history: session.qaLog.slice(-40).map(entry => ({question: entry.question, answer: entry.answer}))}
    })
    if (!prepared) return null
    if ('reply' in prepared && typeof prepared.reply === 'string') return {reply: prepared.reply}
    if (!('session' in prepared) || !prepared.session) return null
    const {session, puzzle, question, requestKey, revision, nickname, history} = prepared
    try {
      const answer = await this.hostCall(signal => this.ports.host.answerQuestion({question, surface: puzzle.surface, solution: puzzle.solution, keyPoints: puzzle.keyPoints, facts: puzzle.facts ?? [], history, asker: nickname, signal}), session.sessionId)
      return await this.inGroup(groupId, async () => {
        if (!this.requestIsCurrent(session, revision, userId)) return null
        const safeAnswer = looksLikeSolutionLeak(answer, puzzle.solution) ? '无法确定' : answer
        session.qaLog.push({userId, nickname, question, answer: safeAnswer, at: this.now()})
        session.lastActivityAt = this.now()
        await this.persist(session)
        const every = this.config().recapEveryQuestions
        const recap = every > 0 && session.qaLog.length % every === 0 ? buildRecapText(session, puzzle) : undefined
        return recap === undefined ? {reply: safeAnswer} : {reply: safeAnswer, recap}
      })
    } catch (error) {
      this.ports.logger?.warn?.(`[海龟汤] 主持问答失败: ${error instanceof Error ? error.message : String(error)}`)
      return this.requestIsCurrent(session, revision, userId) ? {reply: '主持人暂时无法作答,这条问题未记入问答,请稍后重试'} : null
    } finally { this.pendingQuestions.delete(requestKey) }
  }

  // 先可靠收局并揭晓;赛后评选独立更新指定 play,不阻塞下一局。
  private async finishGame(session:TurtleSoupSession, endReason:'solved'|'manual'|'idle_timeout'|'all_surrendered', winnerId?:string, hit?:TurtleSoupGuessEntry):Promise<string> {
    if (this.sessions.get(session.groupId) !== session || session.phase !== 'playing') return "本局已结束"
    const puzzle = this.findPuzzle(session.puzzleId)
    if (!puzzle) { await this.drop(session.groupId); return "题库记录异常,本局作废" }
    const nowMs = this.now()
    const next:TurtleSoupSession = {...session, phase: 'reveal', revision: (session.revision ?? 0) + 1,
      reveal: {at: nowMs, ratingDeadlineAt: nowMs + this.config().ratingWindowMinutes * 60_000}, guessLog: hit ? [...session.guessLog, hit] : [...session.guessLog]}
    const playId = session.playId
    await this.store.transaction(state => {
      const play = state.plays.find(item => item.playId === playId)
      if (play) {
        play.endedAt = nowMs
        play.endReason = endReason
        play.ratingDeadlineAt = next.reveal!.ratingDeadlineAt
        play.solved = endReason === 'solved'
        if (winnerId) play.winnerId = winnerId
        play.players = [...new Set([...(session.participantHistory ?? session.players).map(player => player.userId), ...session.players.map(player => player.userId), ...Object.keys(session.surrendered || {})])]
        play.participantHistory = [...(session.participantHistory ?? session.players)]
        play.qaCount = session.qaLog.length
        play.qaLog = session.qaLog.slice(-200)
        play.guessLog = next.guessLog.slice(-100)
        play.usedHints = session.usedHints
      }
      state.sessions[session.groupId] = next
    })
    Object.assign(session, next)
    this.invalidateRequests(session)
    const brief = buildMvpBrief(session, winnerId, puzzle)
    if (playId && brief.players.length && (brief.totalQuestions || brief.totalGuesses)) {
      const task = this.hostCall(signal => this.ports.host.selectMvp({brief, signal})).then(async mvp => {
        if (!mvp || !brief.players.some(player => player.userId === mvp.userId)) return
        await this.store.transaction(state => {
          const play = state.plays.find(item => item.playId === playId && item.endedAt !== undefined)
          if (play) play.mvp = mvp
        })
        await this.broadcast(session.groupId, `🏅【${puzzle.title}】本局MVP:${nicknameOf(session, mvp.userId)}\n颁奖词:${mvp.reason.slice(0, 120)}`)
      }).catch(error => this.ports.logger?.warn?.(`[海龟汤] MVP评选失败: ${error instanceof Error ? error.message : String(error)}`))
      this.backgroundTasks.add(task)
      void task.finally(() => this.backgroundTasks.delete(task))
    }
    return buildRevealText(session, puzzle, endReason, null, this.config())
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
      for (const groupId of [...this.sessions.keys()]) {
        const message = await this.inGroup(groupId, async () => {
          const session = this.sessions.get(groupId)
          if (!session) return null
          if (session.phase === 'joining') {
            const outcome = joiningOutcome(session, nowMs, config.minPlayers)
            if (outcome === 'start') return await this.launchPlay(session)
            if (outcome === 'cancel') { await this.drop(groupId); return `报名窗口结束,人数不足,本局取消。想玩再 ${SOUP_COMMAND} 开局` }
          } else if (session.phase === 'choosing' && choosingTimedOut(session, nowMs)) {
            const candidates = session.choosing?.candidates ?? []
            const pickId = candidates[Math.floor(Math.random() * candidates.length)]
            return `(无人选汤,自动随机)\n${await this.beginPlay(session, pickId)}`
          } else if (session.phase === 'playing' && playingTimedOut(session, nowMs, config.idleTimeoutMinutes * 60_000)) {
            return await this.finishGame(session, 'idle_timeout')
          } else if (session.phase === 'reveal' && revealTimedOut(session, nowMs)) {
            return await this.archiveRevealed(session, '评分窗口结束,')
          }
          return null
        })
        if (message) await this.broadcast(groupId, message)
      }
    } finally { this.sweeping = false }
  }

  // 收掉评分窗口并归档本局:评分窗口超时(sweeper)与手动提前结束(endGame)共用
  private async archiveRevealed(session:TurtleSoupSession, opener:string):Promise<string> {
    await this.drop(session.groupId)
    const play = this.store.readPlays().plays.find(item => item.playId === session.playId)
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
  if (session.phase === 'choosing') return '选汤中'
  return '已揭晓待评分'
}
