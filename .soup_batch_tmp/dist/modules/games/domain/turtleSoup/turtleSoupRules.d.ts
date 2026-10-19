import type { TurtleSoupPlay, TurtleSoupPuzzle, TurtleSoupSession, TurtleSoupConfig, TurtleSoupPlayer, MvpBrief } from '../../../../contracts/turtleSoup.js';
export declare function joiningOutcome(session: TurtleSoupSession, nowMs: number, minPlayers: number): 'wait' | 'start' | 'cancel';
export declare function canManualStart(session: TurtleSoupSession, minPlayers: number): boolean;
export declare function playingTimedOut(session: TurtleSoupSession, nowMs: number, idleTimeoutMs: number): boolean;
export declare function choosingTimedOut(session: TurtleSoupSession, nowMs: number): boolean;
export declare function revealTimedOut(session: TurtleSoupSession, nowMs: number): boolean;
export type JoinResult = {
    status: 'joined';
    player: TurtleSoupPlayer;
} | {
    status: 'already' | 'phase_rejected' | 'not_started';
};
export declare function joinSession(session: TurtleSoupSession, input: {
    userId: string;
    nickname: string;
    nowMs: number;
}): JoinResult;
export declare function isParticipant(session: TurtleSoupSession, userId: string): boolean;
export type SurrenderOutcome = 'not_playing' | 'not_participant' | 'left_lobby' | 'already_surrendered' | 'surrendered' | 'last_player';
export declare function surrenderPlayer(session: TurtleSoupSession, userId: string, nowMs: number): SurrenderOutcome;
export declare function guessCooldownRemainingMs(session: TurtleSoupSession, userId: string, nowMs: number, cooldownMs: number): number;
export declare function takeHint(session: TurtleSoupSession, hints: string[], maxHints: number): string | null;
export interface PuzzlePlayStats {
    total: number;
    groups: Set<string>;
    users: Set<string>;
}
export declare function puzzlePlayStats(plays: TurtleSoupPlay[]): Map<string, PuzzlePlayStats>;
export declare function auditPuzzleStructure(puzzle: TurtleSoupPuzzle): string[];
export declare function pendingPuzzleIds(puzzles: TurtleSoupPuzzle[]): string[];
export declare function freshPuzzleIds(puzzles: TurtleSoupPuzzle[], stats: Map<string, PuzzlePlayStats>): string[];
export declare function soupCandidatesFor(puzzles: TurtleSoupPuzzle[], stats: Map<string, PuzzlePlayStats>, groupId: string, participantIds: string[]): {
    strict: TurtleSoupPuzzle[];
    groupOnly: TurtleSoupPuzzle[];
};
export declare function selectPuzzleId(puzzles: TurtleSoupPuzzle[], plays: TurtleSoupPlay[], groupId: string, random?: () => number, participantIds?: string[]): string | null;
export declare function ratingAverage(puzzle: TurtleSoupPuzzle): number | null;
export declare function shouldRetirePuzzle(puzzle: TurtleSoupPuzzle, options?: {
    minRatingAvg: number;
    minRatingCount: number;
}): boolean;
export declare function upsertRating(play: TurtleSoupPlay, puzzle: TurtleSoupPuzzle, input: {
    userId: string;
    score: number;
    comment?: string;
    atMs: number;
}): {
    play: TurtleSoupPlay;
    puzzle: TurtleSoupPuzzle;
    changed: boolean;
};
export type { MvpBrief, MvpPlayerBrief } from '../../../../contracts/turtleSoup.js';
export declare function buildMvpBrief(session: TurtleSoupSession, winnerUserId?: string): MvpBrief;
export declare const SOUP_COMMAND = ".\u6E38\u620F \u6D77\u9F9F\u6C64";
export declare function looksLikeSoupQuestion(text: unknown): boolean;
export declare function isRepeatedQuestion(session: TurtleSoupSession, userId: string, question: string): boolean;
export declare function stripAsideSegments(text: unknown): string;
export declare function isAsideOnlyText(text: unknown): boolean;
export declare function idleTimeoutMs(config: TurtleSoupConfig): number;
export declare function joinWindowMs(config: TurtleSoupConfig): number;
export declare function ratingWindowMs(config: TurtleSoupConfig): number;
export declare function guessCooldownMs(config: TurtleSoupConfig): number;
export declare function chooseWindowMs(config: TurtleSoupConfig): number;
export declare function classifyThresholds(config: TurtleSoupConfig): {
    hitThreshold: number;
    missThreshold: number;
};
export declare function formatDuration(ms: number): string;
export declare function formatCountdown(remainMs: number): string;
export declare function nicknameOf(session: TurtleSoupSession, userId?: string): string;
export declare function buildStatusText(session: TurtleSoupSession, config: TurtleSoupConfig, nowMs: number): string;
export declare function buildCatchUpText(session: TurtleSoupSession, puzzle: {
    title: string;
    surface: string;
} | null, config: TurtleSoupConfig): string;
export declare function buildRevealText(session: TurtleSoupSession, puzzle: TurtleSoupPuzzle, endReason: 'solved' | 'manual' | 'idle_timeout' | 'all_surrendered', mvp: {
    userId: string;
    reason: string;
} | null, config: TurtleSoupConfig): string;
export declare const RECAP_BUCKETS: {
    key: string;
    label: string;
}[];
export declare function buildRecapText(session: TurtleSoupSession, puzzle: TurtleSoupPuzzle | null): string;
