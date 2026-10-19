import type { ChatMessage } from '../../../../contracts/modelGateway.js';
import type { TurtleSoupPuzzle } from '../../../../contracts/turtleSoup.js';
export interface GenerationFeedbackItem {
    title: string;
    score: number;
    comments: string[];
}
export interface GenerationPromptOptions {
    contentPolicy: string;
    avoidTitles: string[];
    difficulty?: string;
    feedback?: {
        high: GenerationFeedbackItem[];
        low: GenerationFeedbackItem[];
    };
}
export declare function buildPuzzleGenerationMessages(options: GenerationPromptOptions): ChatMessage[];
export declare function buildPuzzleReviewMessages(puzzle: TurtleSoupPuzzle): ChatMessage[];
export declare function extractFirstJsonObject(text: unknown): Record<string, unknown> | null;
export interface ParsedReview {
    pass: boolean;
    reason: string;
}
export declare function parsePuzzleReview(text: unknown): ParsedReview | null;
export declare const HOST_ANSWER_ENUM: readonly ["是", "不是", "是也不是", "与此无关"];
export type HostAnswer = typeof HOST_ANSWER_ENUM[number];
export declare function buildHostAnswerMessages(input: {
    question: string;
    solution: string;
    keyPoints: string[];
    history: {
        question: string;
        answer: string;
    }[];
    asker: string;
}): ChatMessage[];
export declare function parseHostAnswer(text: unknown): HostAnswer;
export interface GuessJudgeInput {
    guess: string;
    solution: string;
    keyPoints: string[];
    literalScore: number;
}
export declare function buildGuessJudgeMessages(input: GuessJudgeInput): ChatMessage[];
export interface ParsedGuessJudge {
    correct: boolean;
    reason: string;
    closeness: number;
    covered: string[] | null;
}
export declare function parseGuessJudge(text: unknown, literalScore?: number): ParsedGuessJudge | null;
export declare function buildMvpMessages(input: {
    brief: {
        players: {
            userId: string;
            nickname: string;
            questions: number;
            yesAnswers: number;
            closestGuess: {
                guess: string;
                score: number;
            } | null;
        }[];
        winnerId: string | null;
        totalQuestions: number;
        totalGuesses: number;
    };
}): ChatMessage[];
export interface ParsedMvp {
    userId: string;
    reason: string;
}
export declare function parseMvp(text: unknown, validUserIds: string[]): ParsedMvp | null;
export declare function makePuzzleId(nowMs: number, random: number): string;
export declare function buildLogicAuditMessages(puzzle: TurtleSoupPuzzle): ChatMessage[];
export interface ParsedLogicAudit {
    pass: boolean;
    holes: string[];
    reason: string;
}
export declare function parseLogicAudit(text: unknown): ParsedLogicAudit | null;
export declare function parseGeneratedPuzzle(text: unknown, meta: {
    nowMs: number;
    random: number;
    model: string;
}): TurtleSoupPuzzle | null;
