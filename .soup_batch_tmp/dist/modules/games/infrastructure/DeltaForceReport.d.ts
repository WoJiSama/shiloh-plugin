import type { CardBaseConstructor } from "../../../contracts/mediaCards.js";
export declare function createDeltaForceReport(Base: CardBaseConstructor): {
    new (e: unknown): {
        getData(data: Record<string, unknown>, scale?: number): Promise<{
            sys: {
                scale: string;
            };
            saveId: string;
            imgType: string;
        }>;
        scale(pct?: number): string;
        userId?: unknown;
        model: string;
        screenData: Record<string, unknown>;
    };
};
