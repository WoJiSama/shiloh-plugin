export interface MediaLogger {
    warn?(message: string): void;
}
export interface MediaPage {
    page: number;
    cid: number;
    title?: string;
    duration?: number;
}
export interface MediaCard {
    type?: string;
    platform?: string;
    video_id?: string;
    short_url?: string;
    page_url?: string;
    video_url?: string;
    metadata_status?: string;
    metadata_failure_reason?: string;
    title?: string;
    description?: string;
    channel?: string;
    channel_id?: string;
    duration?: number;
    cover_url?: string;
    published_at?: number | null;
    upload_date?: string;
    age_limit?: number | null;
    availability?: string;
    is_live?: boolean;
    was_live?: boolean;
    stats?: Record<string, number> | null;
    bvid?: string;
    ep_id?: string;
    cid?: number;
    aid?: number;
    owner?: string;
    owner_mid?: string;
    page_count?: number;
    pages?: MediaPage[];
    card_title?: string;
    shared_by?: string;
    shared_by_qq?: string;
    stat?: Record<string, number> | null;
    text?: string;
    data?: unknown;
}
export interface MediaFetchResponse {
    ok: boolean;
    status: number;
    url: string;
    json(): Promise<unknown>;
}
export type MediaFetch = (url: string, init?: {
    headers?: Record<string, string>;
    redirect?: 'follow';
    signal?: AbortSignal;
}) => Promise<MediaFetchResponse>;
export interface YoutubeOptions {
    cookieHeader?: string;
    poToken?: string;
    binary?: string;
    timeoutMs?: number;
    proxyUrl?: string;
    cacheTtlMs?: number;
    maxBytes?: number;
    maxSeconds?: number;
    runCommand?: (args: string[], options: {
        binary: string;
        timeoutMs: number;
    }) => Promise<string | {
        stdout: string;
    }>;
}
export interface BilibiliOptions {
    fetchImpl?: MediaFetch;
    timeoutMs?: number;
    maxSeconds?: number;
    quality?: number;
    authCookie?: string;
}
export interface BilibiliResource {
    bvid: string;
    cid: number;
    page: number;
    quality: number;
    title: string;
    duration: number;
    size: number;
    is_preview: boolean;
    url: string;
    backup_urls: string[];
}
export interface PlaybackResult {
    resources: BilibiliResource[];
    failureReason: string;
    previewNotice: string;
    qualityOptions?: {
        quality: number;
        label: string;
    }[];
}
export interface ArtifactLease {
    filePath: string;
    release?(): Promise<void>;
}
export interface MediaArtifactPort {
    acquire(key: string, producer: () => Promise<string | null>): Promise<ArtifactLease | null>;
}
export interface MediaSegment {
    type?: string;
    [key: string]: unknown;
}
export interface MediaSegmentApi {
    image?(file: string): MediaSegment;
    video?(file: string): MediaSegment;
}
export interface MediaRelayOptions {
    segmentApi?: MediaSegmentApi | undefined;
    logger?: MediaLogger | undefined;
    artifactStore?: MediaArtifactPort | null;
    onTiming?: ((step: string, duration: number) => void) | null;
}
export interface BilibiliRelayOptions extends MediaRelayOptions {
    quality?: number;
    authCookie?: string;
    autoAuthRetryCookie?: string;
}
export interface YoutubeRelayOptions extends MediaRelayOptions {
    youtubeRelay?: YoutubeOptions;
}
export interface RelayResult {
    segments: (string | MediaSegment)[];
    tempFiles: string[];
    artifactLeases: ArtifactLease[];
    qualityOptions?: {
        quality: number;
        label: string;
    }[];
    actualQuality?: number;
    failureReason?: string;
    usedAuthorizedRetry?: boolean;
}
export interface BilibiliApiResponse {
    json(): Promise<unknown>;
    url: string;
    headers: {
        raw?(): Record<string, string[]>;
        getSetCookie?(): string[];
    };
}
export type BilibiliApiFetch = (url: string, options?: {
    headers?: Record<string, string>;
}) => Promise<BilibiliApiResponse>;
export interface BilibiliVideoDetails {
    bvid: string;
    aid: number;
    cid: number;
    owner: {
        mid: number;
        name: string;
    };
    pic: string;
    title: string;
    desc: string;
    stat: Record<string, number>;
    duration: number;
    pubdate: number;
    tname: string;
    view: number;
}
export type BilibiliParseResult = {
    url: string;
    success: true;
    text: string;
    videoUrl: string;
} | {
    url: string;
    success: false;
    error: string;
};
