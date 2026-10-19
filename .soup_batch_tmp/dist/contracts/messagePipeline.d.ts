import type { EventEnvelope, EventJob, MessageSegment, ForwardContext, PipelineLogger } from './pipeline.js';
export type RuntimeEvent = Record<string, unknown>;
export interface PipelinePorts {
    enrichBilibili(message: MessageSegment[], text: string): Promise<MessageSegment[]>;
    enrichDouyin(message: MessageSegment[], text: string): Promise<MessageSegment[]>;
    enrichYoutube(message: MessageSegment[], text: string): Promise<MessageSegment[]>;
    enrichPixiv(message: MessageSegment[], text: string): Promise<MessageSegment[]>;
    extractBilibiliShareFromSegment(segment: MessageSegment, text: string): MessageSegment | null;
    extractBilibiliShareFromText(text: string): MessageSegment | null;
    extractDouyinShareFromText(text: string): MessageSegment | null;
    extractYoutubeShareFromText(text: string): MessageSegment | null;
    extractPixivShareFromText(text: string): MessageSegment | null;
    isResponsibleBot(input: {
        groupId: string;
        selfId: string;
        atBotQqs: string[];
        knownBots: string[];
    }): Promise<boolean>;
    isFederationSibling(me: string, who: string): Promise<boolean>;
    markBotOnline(id: string): unknown;
    onlineBotList(): Promise<string[]>;
    createEventEnvelope(event: unknown, postType?: string): EventEnvelope;
}
export interface PipelineOptions {
    store: {
        create(kind: string, id: string, value: object): Promise<boolean>;
        get<T extends object>(kind: string, id: string, validate?: (value: unknown) => value is T): Promise<T | null>;
        save<T extends object>(kind: string, id: string, value: T): Promise<T>;
        list<T extends object>(kind: string, validate?: (value: unknown) => value is T): Promise<T[]>;
        extendLock(kind: string, id: string, token: string, leaseMs: number): Promise<boolean>;
        acquireLock(kind: string, id: string, leaseMs: number): Promise<string>;
        releaseLock(kind: string, id: string, token: string): Promise<unknown>;
    };
    recentManager: {
        recordMessage(event: RuntimeEvent, options: Record<string, unknown>): Promise<unknown>;
    };
    archiveManager: {
        shouldRecord(event: RuntimeEvent): boolean;
        shouldRecordNotice(event: RuntimeEvent): boolean;
        recordMessage(event: RuntimeEvent, options: Record<string, unknown>): Promise<unknown>;
        recordNotice(event: RuntimeEvent, options: Record<string, unknown>): Promise<unknown>;
    };
    mediaOutbox: {
        enqueue(input: {
            envelope: EventEnvelope;
            media: MessageSegment;
        }): Promise<unknown>;
        recover(): Promise<unknown>;
        stop(): void;
    };
    emojiCollector?: {
        maybeAutoCollect(event: RuntimeEvent): Promise<unknown>;
    };
    logger?: PipelineLogger;
    queue?: {
        run<T>(key: unknown, work: () => T | Promise<T>): Promise<T>;
        size: number;
    };
    maxAttempts?: number;
    retryBaseMs?: number;
    leaseMs?: number;
    concurrency?: number;
    emojiConcurrency?: number;
    enrichBilibili?: PipelinePorts['enrichBilibili'];
    enrichDouyin?: PipelinePorts['enrichDouyin'];
    enrichYoutube?: PipelinePorts['enrichYoutube'];
    enrichPixiv?: PipelinePorts['enrichPixiv'];
    resolveForwardContext?: ((envelope: EventEnvelope) => Promise<ForwardContext | null>) | null;
    stats?: {
        recordReceive(envelope: EventEnvelope): void;
    } | null;
}
export interface PipelineEmitter {
    on(name: string, listener: (event: unknown) => void): unknown;
    off?(name: string, listener: (event: unknown) => void): unknown;
}
export type { EventJob };
