// 海龟汤会话规则——状态机转移、超时判定、选汤策略、评分聚合与MVP素材,全部纯函数。
// 时间戳统一用 epoch 毫秒,由基建层注入,便于测试与重启恢复。
import type {TurtleSoupPlay, TurtleSoupPuzzle, TurtleSoupSession, TurtleSoupConfig, TurtleSoupPlayer, TurtleSoupRating, MvpBrief, MvpPlayerBrief} from '../../../../contracts/turtleSoup.js'
import { literalSoupSimilarity, normalizeSoupText } from './turtleSoupSimilarity.js'

export function joiningOutcome(session:TurtleSoupSession, nowMs:number, minPlayers:number):'wait'|'start'|'cancel' {
  if (session.phase !== 'joining') return 'wait'
  if (nowMs < session.joinDeadlineAt) return 'wait'
  return session.players.length >= Math.max(1, minPlayers) ? 'start' : 'cancel'
}

export function canManualStart(session:TurtleSoupSession, minPlayers:number):boolean {
  return session.phase === 'joining' && session.players.length >= Math.max(1, minPlayers)
}

export function playingTimedOut(session:TurtleSoupSession, nowMs:number, idleTimeoutMs:number):boolean {
  return session.phase === 'playing' && nowMs - session.lastActivityAt >= idleTimeoutMs
}

export function choosingTimedOut(session:TurtleSoupSession, nowMs:number):boolean {
  return session.phase === 'choosing' && !!session.choosing && nowMs >= session.choosing.deadlineAt
}

export function revealTimedOut(session:TurtleSoupSession, nowMs:number):boolean {
  return session.phase === 'reveal' && !!session.reveal && nowMs >= session.reveal.ratingDeadlineAt
}

export type JoinResult = {status:'joined';player:TurtleSoupPlayer}|{status:'already'|'phase_rejected'|'not_started'}
export function joinSession(session:TurtleSoupSession, input:{userId:string;nickname:string;nowMs:number}):JoinResult {
  if (session.phase !== 'joining' && session.phase !== 'playing') return {status: 'phase_rejected'}
  if (session.phase !== 'joining' && !session.startedAt) return {status: 'not_started'}
  if (session.players.some(player => player.userId === input.userId)) return {status: 'already'}
  const player = {userId: input.userId, nickname: input.nickname, joinedAt: input.nowMs}
  session.players.push(player)
  session.lastActivityAt = input.nowMs
  return {status: 'joined', player}
}

export function isParticipant(session:TurtleSoupSession, userId:string):boolean {
  return session.players.some(player => player.userId === userId)
}

// 个人投降:退出本局并标记;最后一名玩家投降时返回 last_player 由调用方收局。
export type SurrenderOutcome = 'not_playing'|'not_participant'|'left_lobby'|'already_surrendered'|'surrendered'|'last_player'
export function surrenderPlayer(session:TurtleSoupSession, userId:string, nowMs:number):SurrenderOutcome {
  if (session.phase !== 'playing') return 'not_playing'
  if (session.surrendered[userId]) return 'already_surrendered'
  if (!isParticipant(session, userId)) return 'not_participant'
  session.players = session.players.filter(player => player.userId !== userId)
  session.surrendered[userId] = {at: nowMs, delivered: false}
  session.lastActivityAt = nowMs
  return session.players.length === 0 ? 'last_player' : 'surrendered'
}

export function guessCooldownRemainingMs(session:TurtleSoupSession, userId:string, nowMs:number, cooldownMs:number):number {
  const last = session.lastGuessAt[userId]
  if (!last) return 0
  return Math.max(0, last + cooldownMs - nowMs)
}

export function takeHint(session:TurtleSoupSession, hints:string[], maxHints:number):string|null {
  if (session.phase !== 'playing') return null
  if (session.usedHints >= Math.max(0, maxHints)) return null
  const hint = hints[session.usedHints]
  if (hint === undefined) return null
  session.usedHints++
  return hint
}

export interface PuzzlePlayStats {total:number;groups:Set<string>;users:Set<string>}
export function puzzlePlayStats(plays:TurtleSoupPlay[]):Map<string, PuzzlePlayStats> {
  const stats = new Map<string, PuzzlePlayStats>()
  for (const play of plays) {
    const entry = stats.get(play.puzzleId) || {total: 0, groups: new Set<string>(), users: new Set<string>()}
    entry.total++
    entry.groups.add(play.groupId)
    for (const userId of play.players || []) entry.users.add(userId)
    stats.set(play.puzzleId, entry)
  }
  return stats
}

// 结构性审核(确定性,零成本):长度/条数/泄露等硬性问题;返回问题清单,空即通过
export function auditPuzzleStructure(puzzle:TurtleSoupPuzzle):string[] {
  const issues:string[] = []
  const surfaceLength = Array.from(puzzle.surface || '').length
  const solutionLength = Array.from(puzzle.solution || '').length
  if (surfaceLength < 60 || surfaceLength > 250) issues.push(`汤面长度${surfaceLength}字,需60-250`)
  if (solutionLength < 40) issues.push(`汤底过短(${solutionLength}字)`)
  if (puzzle.keyPoints.length < 3 || puzzle.keyPoints.length > 6) issues.push(`关键点${puzzle.keyPoints.length}个,需3-6`)
  if (puzzle.keyPoints.some(point => !String(point || '').trim())) issues.push('存在空关键点')
  if (puzzle.hints.length < 3) issues.push(`提示仅${puzzle.hints.length}条`)
  const normalizedSurface = normalizeSoupText(puzzle.surface)
  for (const point of puzzle.keyPoints) {
    const normalizedPoint = normalizeSoupText(point)
    // 关键点成句(≥6字)归一化后整段出现在汤面 = 泄底;短词靠相似度兜底
    if (normalizedPoint.length >= 6 && normalizedSurface.includes(normalizedPoint)) issues.push(`关键点近乎原文出现在汤面:${String(point).slice(0, 12)}`)
    else if (normalizedPoint.length < 6 && literalSoupSimilarity(puzzle.surface, point) >= 0.9) issues.push(`关键点近乎原文出现在汤面:${String(point).slice(0, 12)}`)
  }
  return issues
}

// 待审池:生成后先 pending,过审才 active 参与投放
export function pendingPuzzleIds(puzzles:TurtleSoupPuzzle[]):string[] {
  return puzzles.filter(puzzle => puzzle.status === 'pending').map(puzzle => puzzle.id)
}

export function freshPuzzleIds(puzzles:TurtleSoupPuzzle[], stats:Map<string, PuzzlePlayStats>):string[] {
  return puzzles.filter(puzzle => puzzle.status === 'active' && !stats.has(puzzle.id)).map(puzzle => puzzle.id)
}

// 选汤:优先"没有任何群玩过"的鲜汤;本群玩过的永不复用;鲜汤不足时退到全局游玩次数最少者。
// 按参与人排除：本局任何参与者玩过的汤(任意群)都不再投放,防止跨群串场剧透;
// 排完为空时退回仅按群排除,避免老玩家把小题库耗尽后开不了局
export function soupCandidatesFor(puzzles:TurtleSoupPuzzle[], stats:Map<string, PuzzlePlayStats>, groupId:string, participantIds:string[]) {
  const participants = new Set(participantIds)
  const notPlayedByAnyone = (puzzle:TurtleSoupPuzzle) => {
    const entry = stats.get(puzzle.id)
    if (!entry) return true
    for (const userId of participants) if (entry.users.has(userId)) return false
    return true
  }
  const active = puzzles.filter(puzzle => puzzle.status === 'active')
  const groupOnly = active.filter(puzzle => !stats.get(puzzle.id)?.groups.has(groupId))
  return {strict: groupOnly.filter(notPlayedByAnyone), groupOnly}
}

export function selectPuzzleId(puzzles:TurtleSoupPuzzle[], plays:TurtleSoupPlay[], groupId:string, random:() => number = Math.random, participantIds:string[] = []):string|null {
  const stats = puzzlePlayStats(plays)
  const candidates = soupCandidatesFor(puzzles, stats, groupId, participantIds).strict.length
    ? soupCandidatesFor(puzzles, stats, groupId, participantIds).strict
    : soupCandidatesFor(puzzles, stats, groupId, participantIds).groupOnly
  if (!candidates.length) return null
  const fresh = candidates.filter(puzzle => !stats.has(puzzle.id))
  const pool = fresh.length ? fresh : candidates.filter(puzzle => (stats.get(puzzle.id)?.total ?? 0) === Math.min(...candidates.map(item => stats.get(item.id)?.total ?? 0)))
  return pool[Math.floor(random() * pool.length)]?.id ?? null
}

export function ratingAverage(puzzle:TurtleSoupPuzzle):number|null {
  return puzzle.ratingCount > 0 ? puzzle.ratingSum / puzzle.ratingCount : null
}

export function shouldRetirePuzzle(puzzle:TurtleSoupPuzzle, options = {minRatingAvg: 3, minRatingCount: 3}):boolean {
  const average = ratingAverage(puzzle)
  if (average === null) return false
  return puzzle.ratingCount >= options.minRatingCount && average < options.minRatingAvg && puzzle.status === 'active'
}

// 单人一票、可覆盖:重评时同步修正汤的评分聚合。
export function upsertRating(play:TurtleSoupPlay, puzzle:TurtleSoupPuzzle, input:{userId:string;score:number;comment?:string;atMs:number}):{play:TurtleSoupPlay;puzzle:TurtleSoupPuzzle;changed:boolean} {
  if (!play.players.includes(input.userId)) throw new Error('仅本局参与者可评分')
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) throw new Error('评分必须是1-5的整数')
  if (!play.endedAt) throw new Error('本局尚未结束')
  const previous = play.ratings.find(rating => rating.userId === input.userId)
  const rating:TurtleSoupRating = {userId: input.userId, score: input.score, at: input.atMs}
  if (input.comment !== undefined && input.comment !== '') rating.comment = input.comment
  const nextPlay = {...play, ratings: previous ? play.ratings.map(item => item.userId === input.userId ? rating : item) : [...play.ratings, rating]}
  const nextPuzzle = {...puzzle, ratingSum: puzzle.ratingSum - (previous?.score ?? 0) + input.score, ratingCount: puzzle.ratingCount + (previous ? 0 : 1)}
  return {play: nextPlay, puzzle: nextPuzzle, changed: previous?.score !== input.score || previous?.comment !== rating.comment}
}

export type {MvpBrief, MvpPlayerBrief} from '../../../../contracts/turtleSoup.js'
// MVP素材:按玩家聚合提问数、"是"回答数与最接近的猜测,喂给主持模型评选"全场最佳贡献"。
export function buildMvpBrief(session:TurtleSoupSession, winnerUserId?:string):MvpBrief {
  const briefs = new Map<string, MvpPlayerBrief>()
  for (const player of session.players) briefs.set(player.userId, {userId: player.userId, nickname: player.nickname, questions: 0, yesAnswers: 0, closestGuess: null})
  for (const entry of session.qaLog) {
    const brief = briefs.get(entry.userId)
    if (!brief) continue
    brief.questions++
    if (entry.answer === '是') brief.yesAnswers++
  }
  for (const entry of session.guessLog) {
    const brief = briefs.get(entry.userId)
    if (!brief || entry.final !== 'miss') continue
    if (!brief.closestGuess || entry.literalScore > brief.closestGuess.score) brief.closestGuess = {guess: entry.guess, score: entry.literalScore}
  }
  return {
    players: [...briefs.values()],
    winnerId: winnerUserId ?? null,
    totalQuestions: session.qaLog.length,
    totalGuesses: session.guessLog.length
  }
}

// 统一命令入口:.游戏 海龟汤 <子命令>,新小游戏挂同一棵命令树。
export const SOUP_COMMAND = '.游戏 海龟汤'

// 疑问判定:问号/疑问词/假说标记/足够长的中文陈述才算向主持人提问;
// 纯语气词(wq/欧不/哈哈哈/233之类)不值得一次模型调用,主持人直接沉默。
const SOUP_QUESTION_MARK = /[?？]/
const SOUP_INTERROGATIVE = /(吗|呢|什么|啥|谁|哪|几|多少|怎么|怎样|如何|为什么|为何|是不是|有没有|会不会|能不能|可不可以|是否|难道|莫非)/
const SOUP_HYPOTHESIS = /(我猜|肯定|一定|应该|可能|感觉|觉得|估计|大概|貌似|似乎|好像|说不定|搞不好|答案)/
const SOUP_CJK = /[\u4e00-\u9fff]/
export function looksLikeSoupQuestion(text:unknown):boolean {
  const value = String(text ?? '').trim()
  if (!value) return false
  // 纯表情/符号不算提问("🤔"、"？？");带文字的表情消息照常放行
  if (!value.replace(/[\p{Extended_Pictographic}\p{S}\p{P}\s]/gu, '')) return false
  // 剥掉问号/标点/空白后内容太短(两个汉字及以下)的不算提问:"单?"、"?"、"雨夜?"之类
  const core = value.replace(/[?？。.!！~～\s]/g, '')
  if (Array.from(core).length <= 2) return false
  if (SOUP_QUESTION_MARK.test(value)) return true
  if (SOUP_INTERROGATIVE.test(value) || SOUP_HYPOTHESIS.test(value)) return true
  if (!SOUP_CJK.test(value)) return false
  return Array.from(value).length >= 8
}

// 重复提问:同一玩家本局内问过一模一样的问题(归一化后比较)则不再回答——
// 答案已在群里,复读既浪费模型调用也刷屏。
export function isRepeatedQuestion(session:TurtleSoupSession, userId:string, question:string):boolean {
  const normalized = normalizeSoupText(question)
  if (!normalized) return false
  return session.qaLog.some(entry => entry.userId === userId && normalizeSoupText(entry.question) === normalized)
}

// 场外发言:括号(中文/英文)内的内容不算向主持人提问。
export function stripAsideSegments(text:unknown):string {
  return String(text ?? "").replace(/（[^（）]*）/g, "").replace(/\([^()]*\)/g, "").replace(/\s+/g, " ").trim()
}

// 整条场外判定:括号剥空后为空,或剩余内容以 未闭合的单独( 或 逗号开头(动作旁白约定) ——
// 玩家常打 "(歪头沉思 忘了右括号,或用 ",歪头 起手做旁白,都按场外整条忽略。
export function isAsideOnlyText(text:unknown):boolean {
  const stripped = stripAsideSegments(text)
  if (!stripped) return true
  return /^[（(,，]/.test(stripped)
}

export function idleTimeoutMs(config:TurtleSoupConfig):number { return config.idleTimeoutMinutes * 60_000 }
export function joinWindowMs(config:TurtleSoupConfig):number { return config.joinWindowMinutes * 60_000 }
export function ratingWindowMs(config:TurtleSoupConfig):number { return config.ratingWindowMinutes * 60_000 }
export function guessCooldownMs(config:TurtleSoupConfig):number { return config.guessCooldownSeconds * 1000 }
export function chooseWindowMs(config:TurtleSoupConfig):number { return config.chooseWindowSeconds * 1000 }
export function classifyThresholds(config:TurtleSoupConfig):{hitThreshold:number;missThreshold:number} { return {hitThreshold: config.similarityHitThreshold, missThreshold: config.similarityMissThreshold} }

export function formatDuration(ms:number):string { return ms >= 60_000 ? `${Math.round(ms / 60_000)}分钟` : `${Math.max(1, Math.round(ms / 1000))}秒` }
export function formatCountdown(remainMs:number):string { return remainMs > 0 ? formatDuration(remainMs) : '马上' }

export function nicknameOf(session:TurtleSoupSession, userId?:string):string {
  if (!userId) return ''
  return session.players.find(player => player.userId === userId)?.nickname ?? userId
}

// —— 展示文案(纯函数,基建层只负责发送) ——

export function buildStatusText(session:TurtleSoupSession, config:TurtleSoupConfig, nowMs:number):string {
  const roster = session.players.length ? session.players.map(player => player.nickname).join('、') : '(还没人加入)'
  if (session.phase === 'joining') {
    return [`【海龟汤·报名中】`, `已报名(${session.players.length}/${config.minPlayers}):${roster}`, `报名截止还有:${formatCountdown(session.joinDeadlineAt - nowMs)}`, `发送 ${SOUP_COMMAND} 加入 上车`].join('\n')
  }
  if (session.phase === 'playing') {
    const surrenderedNote = Object.keys(session.surrendered).length ? `\n已投降:${Object.keys(session.surrendered).length}人(汤底已私发)` : ''
    return [
      `【海龟汤·问答中】`,
      `玩家(${session.players.length}人):${roster}${surrenderedNote}`,
      `已提问${session.qaLog.length}次,已猜测${session.guessLog.length}次,提示已用${session.usedHints}/${config.maxHints}`,
      `${nicknameOf(session, session.initiatorId)}或管理可 .海龟汤 结束 提前揭晓;长时间无人发言自动结束`
    ].join('\n')
  }
  return [
    `【海龟汤·已揭晓】`,
    `评分窗口:${formatCountdown((session.reveal?.ratingDeadlineAt ?? nowMs) - nowMs)}`,
    `参与者可 .海龟汤 评分 1-5 [评论]`
  ].join('\n')
}

export function buildCatchUpText(session:TurtleSoupSession, puzzle:{title:string;surface:string}|null, config:TurtleSoupConfig):string {
  if (!puzzle) return '(题目记录缺失)'
  const lines = [`【${puzzle.title}】`, puzzle.surface, '']
  if (session.qaLog.length) {
    lines.push('之前的问答:')
    for (const entry of session.qaLog.slice(-10)) lines.push(`Q:${entry.question.slice(0, 60)} → ${entry.answer}`)
  } else lines.push('还没有人提问,你可以是第一个')
  if (session.usedHints) lines.push(`(已用提示${session.usedHints}/${config.maxHints})`)
  return lines.join('\n')
}

export function buildRevealText(session:TurtleSoupSession, puzzle:TurtleSoupPuzzle, endReason:'solved'|'manual'|'idle_timeout'|'all_surrendered', mvp:{userId:string;reason:string}|null, config:TurtleSoupConfig):string {
  const hit = session.guessLog.find(entry => entry.final === 'hit')
  const opener = endReason === 'solved' && hit
    ? `🎉 恭喜 ${nicknameOf(session, hit.userId)} 猜中汤底!`
    : endReason === 'manual' ? '本局由发起人或管理结束。'
    : endReason === 'all_surrendered' ? '本局所有玩家均已投降,提前揭晓。'
    : '本局因长时间无人发言自动结束。'
  const lines = [opener, '', `—— 汤面 ——`, `【${puzzle.title}】(${puzzle.difficulty})`, puzzle.surface, '', '—— 汤底 ——', puzzle.solution]
  if (puzzle.keyPoints.length) lines.push('', `关键点:${puzzle.keyPoints.join(';')}`)
  if (mvp) lines.push('', `🏅 本局MVP:${nicknameOf(session, mvp.userId)}`, `颁奖词:${mvp.reason}`)
  else lines.push('', '本局未评选出MVP')
  lines.push('', `参与者可在${formatDuration(config.ratingWindowMinutes * 60_000)}内评分:${SOUP_COMMAND} 评分 1-5 [一句话评论]`)
  return lines.join('\n')
}

// 进度卡面:汤面 + 按四类回答分组的问题清单(带提问玩家),每N次提问随答发出。
export const RECAP_BUCKETS:{key:string;label:string}[] = [
  {key: '是', label: '【是的】'},
  {key: '不是', label: '【不是】'},
  {key: '是也不是', label: '【是也不是】'},
  {key: '与此无关', label: '【这不重要】'}
]

export function buildRecapText(session:TurtleSoupSession, puzzle:TurtleSoupPuzzle|null):string {
  const lines = ['—— 海龟汤进度卡 ——']
  if (puzzle) {
    lines.push(`【${puzzle.title}】(${puzzle.difficulty})`, puzzle.surface, '')
  }
  lines.push(`已提问 ${session.qaLog.length} 次,猜测 ${session.guessLog.length} 次,提示已用 ${session.usedHints}`)
  for (const bucket of RECAP_BUCKETS) {
    const entries = session.qaLog.filter(entry => entry.answer === bucket.key)
    lines.push('', `${bucket.label}(${entries.length})`)
    if (!entries.length) { lines.push('(暂无)'); continue }
    for (const entry of entries) lines.push(`${entry.nickname || entry.userId}:${entry.question}`)
  }
  lines.push('', '—— 备忘 ——', `想玩随时 ${SOUP_COMMAND} 加入,上车即补发汤面和已问答记录`, `(括号)里的内容算场外,我不会回应`, `${SOUP_COMMAND} 投降 —— 汤底私发给你并退场,别剧透`, `${SOUP_COMMAND} 结束 —— 发起人或群管理可提前揭晓`)
  return lines.join('\n')
}
