export interface DeltaForceConfig {
    enabled: boolean;
    apiBaseUrl: string;
    apiKey: string;
    timeoutMs: number;
    objectCacheEnabled: boolean;
    objectCacheRefreshMinutes: number;
}
export interface DeltaForceOptions {
    placeType?: string;
    keyword?: string;
    objectID?: string | number;
    limit?: number;
    page?: number;
    days?: number;
    maxPages?: number;
    objectNameResolver?: DeltaForceNameResolver | null;
    includeRank?: boolean;
    includePlace?: boolean;
}
export type DeltaForceNameResolver = ((id: unknown) => string) | {
    getName(id: unknown): string;
} | Map<string | number, string> | Record<string, string>;
export interface DeltaForceObject {
    objectID: string;
    objectName: string;
    raw: unknown;
}
export interface DeltaForceLogger {
    warn?(message: string): void;
    mark?(message: string): void;
}
export interface DeltaForceObjectClient {
    getAllObjectList?(): Promise<unknown>;
    getObjectList(): Promise<unknown>;
}
export interface DeltaForceIntent {
    operation: string;
    prompt: string;
    keyword?: string;
    place?: string;
    limit?: number;
    days?: number;
}
export interface DeltaForcePricePoint {
    date: string;
    label: string;
    price: number;
    min: number;
    max: number;
    count: number;
}
