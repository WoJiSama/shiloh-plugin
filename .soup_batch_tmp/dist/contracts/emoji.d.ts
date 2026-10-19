export interface EmojiItem {
    hash: string;
    file: string;
    tags: string[];
    useCases: string[];
    description: string;
    embedding: number[] | null;
    usedCount: number;
    lastUsedAt: string | null;
    registeredAt: string;
    source?: string;
    isBanned: boolean;
    noFileFlag?: boolean;
}
export interface EmojiCriteria {
    query: string;
    tags: string[];
    useCases: string[];
}
export interface EmojiCandidate {
    item: EmojiItem;
    score: number;
}
export interface EmojiSelection {
    item: EmojiItem | null;
    strategy: string;
    score?: number;
    criteria?: EmojiCriteria;
    familiarity?: number;
    firstUse?: boolean;
}
export interface EmojiAddOptions {
    source?: string;
    autoTag?: boolean;
    autoEmbed?: boolean;
}
export type EmojiAddResult = {
    added: true;
    item: EmojiItem;
} | {
    added: false;
    reason: string;
    item?: EmojiItem;
    size?: number;
    width?: number;
    height?: number;
    ratio?: string;
    error?: string;
    filterReason?: string;
    confidence?: number;
    hitTags?: string[];
};
export interface EmojiLogger {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
}
export interface EmojiPorts {
    logger?: EmojiLogger | undefined;
    fetch?: typeof fetch;
}
export interface EmojiMaintenance {
    skipped?: boolean;
    markedMissing?: number;
    unmarkedRestored?: number;
    orphanRegistered?: number;
    cleanedUntagged?: number;
    prunedStale?: number;
    prunedHashes?: string[];
    total?: number;
}
export interface EmojiEvent {
    msg: string;
    reply(message: unknown): Promise<unknown>;
}
export interface EmojiPluginBase {
}
export type EmojiPluginConstructor = new (options: Record<string, unknown>) => EmojiPluginBase;
export type EmojiHashResolution = {
    ok: false;
    error: string;
} | {
    ok: true;
    results: ({
        hash: string;
        item: EmojiItem | null;
        error?: undefined;
    } | {
        hash: null;
        item: null;
        error: string;
    })[];
};
