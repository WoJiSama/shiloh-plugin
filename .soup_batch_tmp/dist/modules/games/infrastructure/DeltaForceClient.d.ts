import type { DeltaForceConfig, DeltaForceOptions } from '../../../contracts/deltaForce.js';
export declare const DELTA_FORCE_PLACES: {
    type: string;
    name: string;
    aliases: string[];
}[];
export declare function normalizeDeltaForceConfig(config?: unknown): DeltaForceConfig;
export declare function buildDeltaForceUrl(apiBaseUrl: unknown, apiPath: unknown, query?: Record<string, unknown>): string;
export declare function normalizeDeltaForcePlace(input?: string): {
    type: string;
    name: string;
    aliases: string[];
} | null;
export declare function getDeltaForcePlaceHelp(): string;
export declare function normalizeRankLimit(value: unknown, fallback?: number): number;
export declare function normalizeHistoryDays(value: unknown, fallback?: number): number;
export declare function getDeltaForceHelp(): string;
export declare class DeltaForceClient {
    config: DeltaForceConfig;
    fetchImpl: typeof fetch;
    constructor(config?: unknown, { fetchImpl }?: {
        fetchImpl?: typeof fetch | undefined;
    });
    assertReady(): void;
    requestJson(apiPath: string, query?: Record<string, unknown>): Promise<unknown>;
    getDailyKeyword(): Promise<unknown>;
    getPlaceProfit(): Promise<unknown>;
    getPlaceProfitRank({ placeType, limit }?: DeltaForceOptions): Promise<unknown>;
    getObjectList({ page, limit }?: DeltaForceOptions): Promise<unknown>;
    getAllObjectList({ limit, maxPages }?: DeltaForceOptions): Promise<{
        code: unknown;
        message: unknown;
        data: {
            list: Record<string, unknown>[];
            total: number;
            limit: number;
            page: number;
        };
    }>;
    searchObjectValue({ keyword, limit }?: DeltaForceOptions): Promise<{
        data: {
            keyword: string;
            limit: number;
        };
    }>;
    getPriceHistory({ objectID, days, page, limit }?: DeltaForceOptions): Promise<{
        data: {
            objectID: string;
            days: number;
        };
    }>;
    getAllPriceHistory({ objectID, days, limit, maxPages }?: DeltaForceOptions): Promise<{
        code: unknown;
        message: unknown;
        data: {
            items: Record<string, unknown>[];
            objectID: string;
            days: number;
            pagination: {
                page: number;
                limit: number;
                total: number;
                fetched: number;
            };
        };
    }>;
    searchPriceHistory({ keyword, days, limit }?: DeltaForceOptions): Promise<{
        code: unknown;
        message: unknown;
        data: {
            keyword: string;
            days: number;
            limit: number;
            items: {
                latest: Record<string, unknown>;
                history: {
                    code: unknown;
                    message: unknown;
                    data: {
                        items: Record<string, unknown>[];
                        objectID: string;
                        days: number;
                        pagination: {
                            page: number;
                            limit: number;
                            total: number;
                            fetched: number;
                        };
                    };
                };
            }[];
            total: number;
        };
    }>;
    getSolutionList({ keyword, limit, page }?: DeltaForceOptions): Promise<{
        data: {
            keyword: string;
            limit: number;
        };
    }>;
}
export declare function extractErrorMessage(body: unknown): string;
export declare function unwrapApiData(body: unknown): unknown;
export declare function formatDailyKeywordResponse(body: unknown): string;
export declare function formatPlaceProfitResponse(body: unknown, { placeType, limit, objectNameResolver }?: DeltaForceOptions): string;
export declare function formatProfitRankResponse(body: unknown, { placeType, limit, objectNameResolver }?: DeltaForceOptions): string;
export declare function buildPlaceProfitReportData(body: unknown, { placeType, limit, objectNameResolver }?: DeltaForceOptions): {
    kind: string;
    title: string;
    subtitle: string;
    generatedAt: string;
    columns: string[];
    rows: {
        rank: string | number;
        placeName: string | number;
        level: string | number;
        name: string;
        hourProfit: string;
        totalProfit: string;
        materials: string;
    }[];
};
export declare function buildProfitRankReportData(body: unknown, { placeType, limit, objectNameResolver }?: DeltaForceOptions): {
    kind: string;
    title: string;
    subtitle: string;
    generatedAt: string;
    columns: string[];
    rows: {
        rank: string | number;
        placeName: string | number;
        level: string | number;
        name: string;
        hourProfit: string;
        totalProfit: string;
        materials: string;
    }[];
};
export declare function buildSolutionListReportData(body: unknown, { keyword, limit }?: DeltaForceOptions): {
    kind: string;
    title: string;
    subtitle: string;
    generatedAt: string;
    columns: string[];
    emptyText: string;
    rows: {
        rank: string | number;
        weapon: string;
        name: string;
        tag: string;
        price: string;
        costPrice: string;
        applyNum: string;
        likeNum: string;
        solutionCode: string;
        comment: string;
    }[];
};
export declare function buildObjectValueReportData(body: unknown, { keyword, limit }?: DeltaForceOptions): {
    kind: string;
    title: string;
    subtitle: string;
    generatedAt: string;
    columns: string[];
    emptyText: string;
    rows: {
        rank: string | number;
        name: string;
        condition: string;
        latestPrice: string;
        avgPrice: string;
        minPrice: string;
        maxPrice: string;
        change: string;
        count: string;
        updateTime: string;
    }[];
};
export declare function buildPriceHistoryReportData(body: unknown, { keyword, days, limit }?: DeltaForceOptions): {
    kind: string;
    title: string;
    subtitle: string;
    generatedAt: string;
    columns: string[];
    emptyText: string;
    rows: {
        objectID: string | number;
        name: string;
        condition: string;
        latestPrice: string;
        change: string;
        days: number;
        pointCount: number;
        sampleCount: number;
        chartSvg: string;
    }[];
};
export declare function formatObjectValueSearchResponse(body: unknown, { keyword, limit }?: DeltaForceOptions): string;
export declare function formatPriceHistoryResponse(body: unknown, { keyword, days, limit }?: DeltaForceOptions): string;
export declare function formatSolutionListResponse(body: unknown, { keyword, limit }?: DeltaForceOptions): string;
