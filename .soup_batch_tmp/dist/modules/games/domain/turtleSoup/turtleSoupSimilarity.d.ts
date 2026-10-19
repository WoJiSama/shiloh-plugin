export declare function normalizeSoupText(text: unknown): string;
export declare function levenshteinRatio(left: string, right: string): number;
export declare function bigramDice(left: string, right: string): number;
export declare function literalSoupSimilarity(guess: unknown, solution: unknown): number;
export type SoupGuessVerdict = 'hit' | 'gray' | 'miss';
export interface SoupGuessClassification {
    score: number;
    verdict: SoupGuessVerdict;
}
export declare function classifySoupGuess(guess: unknown, solution: unknown, thresholds: {
    hitThreshold: number;
    missThreshold: number;
}): SoupGuessClassification;
export declare function keyPointCoverage(keyPoints: string[], guess: unknown): {
    matched: string[];
    missing: string[];
};
export declare function looksLikeSolutionLeak(replyText: unknown, solution: unknown, threshold?: number): boolean;
