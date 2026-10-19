import type { DeltaReport } from '../../../contracts/deltaForceReport.js';
import type { CardRenderer } from '../../../contracts/mediaCards.js';
export declare function buildDeltaForceReportView(report: DeltaReport): {
    kindClass: string;
    title: string;
    subtitle: string;
    generatedAt: string;
    columnsHtml: string;
    rowsHtml: string;
    emptyText: string;
};
export declare function createDeltaForceReportRenderer(puppeteer: CardRenderer, DeltaForceReport: new (e: unknown) => {
    getData(data: Record<string, unknown>, scale: number): Promise<Record<string, unknown>>;
}): {
    renderDeltaForceReport: (e: unknown, report: DeltaReport) => Promise<unknown>;
};
