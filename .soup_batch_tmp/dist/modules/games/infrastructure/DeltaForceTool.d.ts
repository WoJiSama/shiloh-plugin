import type { DeltaPorts } from "../../../contracts/deltaForceReport.js";
export declare function createDeltaForceTool(ports: DeltaPorts): {
    new (): {
        func(input?: unknown, event?: unknown): Promise<string>;
        name: string;
        parameters: import("../../toolSupport/infrastructure/AbstractTool.js").ToolParameters;
        description: string;
        skill: Record<string, unknown> | null;
        getSkill(): Record<string, unknown>;
        normalizeParameters(params: unknown, _context?: {
            event: unknown;
        }): Record<string, unknown>;
        validateParameters(params: Record<string, unknown>): string | true;
        getToolInfo(): {
            name: string;
            description: string;
            parameters: import("../../toolSupport/infrastructure/AbstractTool.js").ToolParameters;
        };
        execute(params: unknown, event: unknown): Promise<unknown>;
    };
};
