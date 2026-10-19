import type { DeltaEvent, DeltaPorts } from "../../../contracts/deltaForceReport.js";
type PluginBase = new (options: {
    name: string;
    dsc: string;
    event: string;
    priority: number;
    rule: {
        reg: string;
        fnc: string;
    }[];
}) => object;
export declare function createDeltaForcePlugin(plugin: PluginBase, ports: DeltaPorts): {
    new (): {
        bootstrapObjectCache(): void;
        showHelp(e: DeltaEvent): Promise<boolean>;
        dailyKeyword(e: DeltaEvent): Promise<boolean>;
        objectValueSearch(e: DeltaEvent): Promise<boolean>;
        priceHistory(e: DeltaEvent): Promise<boolean>;
        solutionList(e: DeltaEvent): Promise<boolean>;
        placeProfit(e: DeltaEvent): Promise<boolean>;
        profitRank(e: DeltaEvent): Promise<boolean>;
    };
};
export {};
