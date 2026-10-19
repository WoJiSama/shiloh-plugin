import type { UmaReport } from '../../../../contracts/uma.js';
import type { CardRenderer } from '../../../../contracts/mediaCards.js';
export declare function buildUmaRaceReportView(report?: UmaReport): {
    typeClass: string;
    title: string;
    subtitle: string;
    scene: string;
    generatedAt: string;
    prompt: string;
    rankRowsHtml: string;
    highlightsHtml: string;
    awardsHtml: string;
    proficiencyHtml: string;
    hasAwardsClass: string;
    hasProficiencyClass: string;
};
export declare function createUmaRaceReportRenderer(puppeteer: CardRenderer, UmaRaceReport: new (e: unknown) => {
    getData(data: Record<string, unknown>, scale: number): Promise<Record<string, unknown>>;
}): (e: unknown, report: UmaReport) => Promise<unknown>;
