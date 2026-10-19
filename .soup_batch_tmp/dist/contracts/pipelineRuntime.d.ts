export interface RuntimePart {
    stop(): void;
}
export interface RuntimePipeline extends RuntimePart {
    start(bot: unknown): unknown;
}
interface FactoryContext {
    logger?: RuntimeLogger | undefined;
}
interface StoreFactoryOptions extends FactoryContext {
    redis: unknown;
    eventTtlSeconds: number;
    deliveryTtlSeconds: number;
}
interface ArtifactFactoryOptions extends FactoryContext {
    ttlMs: number;
    maxEntries: number;
    maxIdleBytes: number;
    maxEncodedBytes: number;
}
interface OutboxFactoryOptions extends FactoryContext {
    store: unknown;
    gateway: unknown;
    enabled: boolean;
    maxAttempts: number;
    retryBaseMs: number;
    leaseMs: number;
    concurrency: number;
    prepareConcurrency: number;
    autoBilibiliMemberAuth: boolean;
    getBilibiliAuthCookie(): unknown;
    artifactStore: unknown;
    youtubeRelay: unknown;
    pixivRelay: unknown;
    sharedMedia: {
        hostDir: string;
        containerDir: string;
    } | null;
}
interface PipelineFactoryOptions extends FactoryContext {
    store: unknown;
    recentManager: unknown;
    archiveManager: unknown;
    mediaOutbox: RuntimePart;
    emojiCollector: unknown;
    maxAttempts: number;
    retryBaseMs: number;
    leaseMs: number;
    concurrency: number;
    resolveForwardContext(envelope: unknown): Promise<unknown>;
    stats: unknown;
}
export interface RuntimeAssemblyPorts {
    getBot(): unknown;
    getRedis(): unknown;
    getLogger(): RuntimeLogger | undefined;
    getInstalled(): RuntimeBundle | null;
    setInstalled(value: RuntimeBundle): void;
    setPixivFetchProxy(url: string): void;
    getMissingRedisJobCapabilities(client: unknown): string[];
    createJobStore(options: StoreFactoryOptions): unknown;
    createStats(options: FactoryContext & {
        redis: unknown;
        settings: Record<string, unknown>;
    }): unknown;
    createGateway(options: FactoryContext & {
        botRoot(): unknown;
        stats: unknown;
    }): unknown;
    createArtifactStore(options: ArtifactFactoryOptions): unknown;
    createOutbox(options: OutboxFactoryOptions): RuntimePart;
    createRecent(options: {
        groupMaxMessages: unknown;
        messageMaxLength: unknown;
        cacheExpireMinutes: unknown;
        cacheExpireDays: unknown;
    }): unknown;
    createPipeline(options: PipelineFactoryOptions): RuntimePipeline;
    startAdminReport(options: FactoryContext & {
        store: unknown;
    }): () => void;
    archiveManager: unknown;
    getBilibiliAuthCookie(): unknown;
    resolveForwardContext(envelope: unknown, bot: unknown): Promise<unknown>;
}
export interface RuntimeLogger {
    warn?(message: string): void;
    error?(message: string): void;
    info?(message: string): void;
}
export interface RuntimeBundle {
    config: Record<string, unknown>;
    pipeline: RuntimePipeline | null;
    mediaOutbox: RuntimePart | null;
    store: unknown;
    gateway: unknown;
    stats?: unknown;
    artifactStore?: unknown;
    adminReportStop?: () => void;
    dispose?: () => void;
    unavailableReason?: string;
}
export interface RuntimeInput {
    bot?: unknown;
    redis?: unknown;
    logger?: RuntimeLogger | undefined;
    pluginSettings?: Record<string, unknown>;
    recentManager?: unknown;
    archiveManager?: unknown;
    emojiCollector?: unknown;
    gateway?: unknown;
    store?: unknown;
}
export {};
