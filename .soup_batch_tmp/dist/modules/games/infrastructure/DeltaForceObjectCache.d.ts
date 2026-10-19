import type { DeltaForceObject, DeltaForceLogger, DeltaForceObjectClient } from '../../../contracts/deltaForce.js';
interface CacheOptions {
    cachePath?: string;
    ttlMs?: number;
    logger?: DeltaForceLogger | undefined;
}
export declare function normalizeDeltaForceObjects(body: unknown): DeltaForceObject[];
export declare class DeltaForceObjectCache {
    cachePath: string;
    ttlMs: number;
    logger: DeltaForceLogger | undefined;
    objects: Map<string, DeltaForceObject>;
    updatedAt: number;
    refreshing: Promise<{
        refreshed: boolean;
        size: number;
    }> | null;
    timer: ReturnType<typeof setInterval> | null;
    constructor({ cachePath, ttlMs, logger }?: CacheOptions);
    loadFromDisk(): void;
    saveToDisk(): void;
    replaceObjects(objects: unknown): void;
    isStale(): boolean;
    getName(objectID: unknown): string;
    get size(): number;
    getStatusText(): string;
    refresh(client: DeltaForceObjectClient, { force }?: {
        force?: boolean | undefined;
    }): Promise<{
        refreshed: boolean;
        size: number;
    }>;
    startAutoRefresh(client: DeltaForceObjectClient, refreshMinutes?: number): void;
}
export {};
