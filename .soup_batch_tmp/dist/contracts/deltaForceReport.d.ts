export interface DeltaReportRow {
    placeName?: string | number;
    level?: string | number;
    name?: string;
    hourProfit?: string | number;
    totalProfit?: string | number;
    materials?: string;
    rank?: string | number;
    price?: string | number;
    costPrice?: string | number;
    applyNum?: string | number;
    likeNum?: string | number;
    comment?: string;
    tag?: string;
    solutionCode?: string;
    weapon?: string;
    minPrice?: string | number;
    maxPrice?: string | number;
    change?: string | number;
    count?: string | number;
    condition?: string;
    latestPrice?: string | number;
    avgPrice?: string | number;
    updateTime?: string;
    objectID?: string | number;
    days?: number;
    pointCount?: number;
    sampleCount?: number;
    chartSvg?: string;
}
export interface DeltaReport {
    kind: string;
    columns: string[];
    rows: DeltaReportRow[];
    title?: string;
    subtitle?: string;
    generatedAt?: string;
    emptyText?: string;
}
export interface DeltaEvent {
    original?: unknown;
    msg: string;
    reply(message: unknown): Promise<unknown>;
}
export interface DeltaPorts {
    renderReport(event: unknown, report: DeltaReport): Promise<unknown>;
    logger: {
        warn?(message: string): void;
    };
}
export declare function deltaRecord(value: unknown): Record<string, unknown>;
export declare function deltaEvent(value: unknown): DeltaEvent | null;
