const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value) => typeof value === 'string' && value.trim() ? value : undefined;
const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && !!item.trim()) : [];
const numberOr = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
export function decodeTurtleSoupPuzzle(value) {
    const raw = record(value);
    const id = text(raw.id), title = text(raw.title), surface = text(raw.surface), solution = text(raw.solution);
    if (!id || !title || !surface || !solution)
        throw new Error('海龟汤汤面记录无效:缺少id/标题/汤面/汤底');
    const puzzle = {
        id, title, surface, solution,
        keyPoints: strings(raw.keyPoints),
        hints: strings(raw.hints),
        difficulty: text(raw.difficulty) || 'normal',
        tags: strings(raw.tags),
        source: raw.source === 'manual' ? 'manual' : 'ai',
        createdAt: numberOr(raw.createdAt, 0),
        status: raw.status === 'retired' ? 'retired' : raw.status === 'pending' ? 'pending' : 'active',
        ...(Array.isArray(raw.audits) ? { audits: raw.audits.filter((item) => {
                const entry = item;
                return typeof entry?.domain === 'string' && ['structure', 'playability', 'logic'].includes(String(entry.domain)) && typeof entry?.pass === 'boolean';
            }).map(entry => ({ domain: entry.domain, pass: entry.pass === true, reason: String(entry.reason || ''), ...(Array.isArray(entry.holes) ? { holes: entry.holes.filter((hole) => typeof hole === 'string') } : {}), at: typeof entry.at === 'number' ? entry.at : 0, ...(typeof entry.model === 'string' ? { model: entry.model } : {}) })) } : {}),
        ratingSum: numberOr(raw.ratingSum, 0),
        ratingCount: numberOr(raw.ratingCount, 0)
    };
    if (typeof raw.model === 'string' && raw.model)
        puzzle.model = raw.model;
    return puzzle;
}
export function decodeTurtleSoupPuzzleFile(value) {
    const raw = record(value);
    if (!Array.isArray(raw.puzzles))
        throw new Error('海龟汤汤库文件格式无效');
    return { puzzles: raw.puzzles.map(decodeTurtleSoupPuzzle) };
}
export function decodeTurtleSoupRating(value) {
    const raw = record(value);
    const userId = text(raw.userId), score = raw.score;
    if (!userId || typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5)
        throw new Error('海龟汤评分记录无效');
    const rating = { userId, score, at: numberOr(raw.at, 0) };
    const comment = text(raw.comment);
    if (comment)
        rating.comment = comment;
    return rating;
}
export function decodeTurtleSoupPlay(value) {
    const raw = record(value);
    const playId = text(raw.playId), puzzleId = text(raw.puzzleId), groupId = text(raw.groupId);
    if (!playId || !puzzleId || !groupId)
        throw new Error('海龟汤游玩记录无效:缺少playId/puzzleId/groupId');
    const play = {
        playId, puzzleId,
        puzzleTitle: text(raw.puzzleTitle) || '',
        groupId,
        startedAt: numberOr(raw.startedAt, 0),
        solved: raw.solved === true,
        players: strings(raw.players),
        qaCount: numberOr(raw.qaCount, 0),
        ratings: Array.isArray(raw.ratings) ? raw.ratings.map(decodeTurtleSoupRating) : []
    };
    if (typeof raw.endedAt === 'number' && Number.isFinite(raw.endedAt))
        play.endedAt = raw.endedAt;
    if (raw.endReason === 'solved' || raw.endReason === 'manual' || raw.endReason === 'idle_timeout' || raw.endReason === 'join_timeout' || raw.endReason === 'all_surrendered' || raw.endReason === 'switched')
        play.endReason = raw.endReason;
    if (typeof raw.winnerId === 'string' && raw.winnerId)
        play.winnerId = raw.winnerId;
    const mvp = record(raw.mvp);
    const mvpUserId = text(mvp.userId);
    if (mvpUserId)
        play.mvp = { userId: mvpUserId, reason: String(mvp.reason || '') };
    return play;
}
export function decodeTurtleSoupPlayFile(value) {
    const raw = record(value);
    if (!Array.isArray(raw.plays))
        throw new Error('海龟汤游玩记录文件格式无效');
    return { plays: raw.plays.map(decodeTurtleSoupPlay) };
}
export function decodeTurtleSoupPlayer(value) {
    const raw = record(value);
    const userId = text(raw.userId);
    if (!userId)
        throw new Error('海龟汤玩家记录无效');
    return { userId, nickname: String(raw.nickname || userId), joinedAt: numberOr(raw.joinedAt, 0) };
}
export function decodeTurtleSoupQaEntry(value) {
    const raw = record(value);
    const userId = text(raw.userId), question = text(raw.question), answer = text(raw.answer);
    if (!userId || !question || !answer)
        throw new Error('海龟汤问答记录无效');
    const entry = { userId, question, answer, at: numberOr(raw.at, 0) };
    const nickname = text(raw.nickname);
    if (nickname)
        entry.nickname = nickname;
    return entry;
}
export function decodeTurtleSoupGuessEntry(value) {
    const raw = record(value);
    const userId = text(raw.userId), guess = text(raw.guess);
    if (!userId || !guess)
        throw new Error('海龟汤猜测记录无效');
    return { userId, guess, literalScore: numberOr(raw.literalScore, 0), final: raw.final === 'hit' ? 'hit' : 'miss', at: numberOr(raw.at, 0) };
}
export function decodeTurtleSoupSession(value) {
    const raw = record(value);
    const groupId = text(raw.groupId);
    if (!groupId)
        throw new Error('海龟汤会话记录无效:缺少groupId');
    const phase = raw.phase === 'choosing' || raw.phase === 'playing' || raw.phase === 'reveal' ? raw.phase : 'joining';
    const session = {
        groupId,
        phase,
        puzzleId: String(raw.puzzleId || ''),
        initiatorId: String(raw.initiatorId || ''),
        players: Array.isArray(raw.players) ? raw.players.map(decodeTurtleSoupPlayer) : [],
        createdAt: numberOr(raw.createdAt, 0),
        joinDeadlineAt: numberOr(raw.joinDeadlineAt, 0),
        lastActivityAt: numberOr(raw.lastActivityAt, 0),
        qaLog: Array.isArray(raw.qaLog) ? raw.qaLog.map(decodeTurtleSoupQaEntry) : [],
        guessLog: Array.isArray(raw.guessLog) ? raw.guessLog.map(decodeTurtleSoupGuessEntry) : [],
        usedHints: numberOr(raw.usedHints, 0),
        lastGuessAt: (() => { const result = {}; for (const [key, v] of Object.entries(record(raw.lastGuessAt)))
            if (typeof v === 'number' && Number.isFinite(v))
                result[key] = v; return result; })(),
        surrendered: (() => { const result = {}; for (const [key, v] of Object.entries(record(raw.surrendered))) {
            const item = record(v);
            if (typeof item.at === 'number' && Number.isFinite(item.at))
                result[key] = { at: item.at, delivered: item.delivered === true };
        } return result; })()
    };
    if (typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt))
        session.startedAt = raw.startedAt;
    const choosing = record(raw.choosing);
    if (Array.isArray(choosing.candidates) && typeof choosing.deadlineAt === 'number' && Number.isFinite(choosing.deadlineAt))
        session.choosing = { candidates: choosing.candidates.filter((item) => typeof item === 'string'), deadlineAt: choosing.deadlineAt };
    const reveal = record(raw.reveal);
    if (typeof reveal.at === 'number' && Number.isFinite(reveal.at) && typeof reveal.ratingDeadlineAt === 'number' && Number.isFinite(reveal.ratingDeadlineAt))
        session.reveal = { at: reveal.at, ratingDeadlineAt: reveal.ratingDeadlineAt };
    return session;
}
export function decodeTurtleSoupSessionFile(value) {
    const raw = record(value);
    if (!raw.sessions || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions))
        throw new Error('海龟汤会话文件格式无效');
    const sessions = {};
    for (const [groupId, item] of Object.entries(record(raw.sessions)))
        sessions[groupId] = decodeTurtleSoupSession(item);
    return { sessions };
}
export function emptyTurtleSoupPuzzleFile() { return { puzzles: [] }; }
export function emptyTurtleSoupPlayFile() { return { plays: [] }; }
export function emptyTurtleSoupSessionFile() { return { sessions: {} }; }
//# sourceMappingURL=turtleSoupSchema.js.map