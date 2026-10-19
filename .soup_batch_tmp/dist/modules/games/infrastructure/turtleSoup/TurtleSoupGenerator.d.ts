import type { TurtleSoupLogger, TurtleSoupPuzzle, TurtleSoupConfig } from '../../../../contracts/turtleSoup.js';
import type { ChatMessage } from '../../../../contracts/modelGateway.js';
import type { TurtleSoupStore } from './TurtleSoupStore.js';
export interface TurtleSoupModelCallOptions {
    model?: string | undefined;
    temperature?: number | undefined;
}
export type TurtleSoupModelCall = (messages: ChatMessage[], options?: TurtleSoupModelCallOptions) => Promise<string>;
export interface TurtleSoupGeneratorPorts {
    store: TurtleSoupStore;
    config: () => TurtleSoupConfig;
    callModel: TurtleSoupModelCall;
    logger?: TurtleSoupLogger;
    now?: () => number;
    random?: () => number;
}
export interface GenerateOutcome {
    added: number;
    failed: number;
    lastError: string | undefined;
}
export declare class TurtleSoupGenerator {
    private readonly ports;
    private generating;
    private sequence;
    constructor(ports: TurtleSoupGeneratorPorts);
    get busy(): boolean;
    freshCount(): number;
    readyFreshCount(): number;
    ensureFreshPool(): Promise<GenerateOutcome>;
    seed(count: number, difficulty?: 'easy' | 'normal' | 'hard'): Promise<GenerateOutcome>;
    buildGenerationFeedback(): {
        high: {
            title: string;
            score: number;
            comments: string[];
        }[];
        low: {
            title: string;
            score: number;
            comments: string[];
        }[];
    };
    generateOne(difficulty?: 'easy' | 'normal' | 'hard'): Promise<TurtleSoupPuzzle>;
    duplicatesExisting(candidate: TurtleSoupPuzzle, puzzles: TurtleSoupPuzzle[]): boolean;
    private now;
    private random;
}
