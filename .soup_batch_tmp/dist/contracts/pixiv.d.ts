export interface PixivPage {
    page: number;
    image_url: string;
    width: number | null;
    height: number | null;
}
export interface PixivCard extends Record<string, unknown> {
    type?: string;
    platform?: string;
    artwork_id?: string;
    title?: string;
    description?: string;
    author?: string;
    author_id?: string;
    tags?: string[];
    page_count?: number;
    pages?: PixivPage[];
    cover_url?: string;
    width?: number | null;
    height?: number | null;
    x_restrict?: number;
    sanity_level?: number | null;
    published_at?: number | null;
    stats?: Record<string, unknown> | null;
    page_url?: string;
    short_url?: string;
    metadata_status?: string;
}
export interface PixivRequest {
    fetchImpl?: typeof fetch | null;
    proxyUrl?: string | undefined;
    cookieHeader?: string;
    raw?: boolean;
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
    cacheTtlMs?: number;
}
export interface PixivItem {
    id: string;
    title: string;
    userName: string;
    userId?: string;
    pageCount: number;
    xRestrict: number;
    thumbUrl?: string;
    bookmarkCount?: number;
    tags?: string[];
    thumbPath?: string;
}
export interface PixivSession {
    keyword: string;
    mode?: string;
    order: string;
    orderSource?: string;
    artist?: {
        userId: string;
        userName: string;
    } | null;
    total?: number;
    items: PixivItem[];
    savedAt?: number;
}
export interface PixivScope {
    group_id?: string | number | null;
    user_id?: string | number;
    self_id?: string | number;
}
export interface PixivRedis {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: {
        PX: number;
    }): Promise<unknown>;
    pExpire?(key: string, ms: number): Promise<unknown>;
    pexpire?(key: string, ms: number): Promise<unknown>;
}
export interface PixivRelayConfig extends PixivRequest {
    enabled?: boolean;
    allowRestricted?: boolean;
    maxPages?: number;
    maxImageBytes?: number;
    maxTotalBytes?: number;
    downloadTimeoutMs?: number;
}
export interface PixivLease {
    filePath: string;
    release?(): Promise<void>;
}
export interface PixivRelayOptions {
    segmentApi?: {
        image(path: string): unknown;
    } | undefined;
    artifactStore?: {
        acquire(key: string, producer: () => Promise<string>): Promise<PixivLease | null>;
    } | null;
    onTiming?: ((stage: string, ms: number) => void) | null;
    pixivRelay?: PixivRelayConfig;
}
export declare function pixivRecord(value: unknown): Record<string, unknown>;
export declare function pixivText(value: unknown): string;
