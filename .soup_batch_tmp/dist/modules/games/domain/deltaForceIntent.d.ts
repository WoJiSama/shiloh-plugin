import type { DeltaForceIntent } from '../../../contracts/deltaForce.js';
export declare function resolveNaturalDeltaForceToolCall(text?: string, { botName }?: {
    botName?: string | undefined;
}): {
    toolName: string;
    params: DeltaForceIntent;
} | null;
