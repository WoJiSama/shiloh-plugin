import type { InteractionKind } from './turnInteraction.js';
import type { SemanticDecision } from './toolExecution.js';
export type ToolChoice = string | {
    type?: string;
    function?: {
        name?: string;
    };
};
export interface ForcedToolCall {
    id?: string;
    type?: string;
    function?: {
        name?: string;
        arguments?: string;
    };
}
export interface TurnPlan {
    id: string;
    intent: string;
    execution: {
        mode: string;
        modelProfile: string;
        toolChoice: ToolChoice;
    };
    capabilities: {
        required: string[];
        optional: string[];
        available: string[];
    };
    toolDecision?: SemanticDecision;
    context: {
        historyMode: string;
        selectedHistoryCount: number;
    };
    presentation: {
        kind: string;
    };
    observability: {
        routeReason: string;
    };
    outcomes?: {
        toolName: string;
        success: boolean;
    }[];
}
export interface TurnPlanInput {
    responseKind?: string;
    intentText?: string;
    interactionKind?: InteractionKind | undefined;
    availableCapabilities?: unknown[];
    requiredCapabilities?: unknown[];
    toolDecision?: SemanticDecision | null | undefined;
    toolChoice?: ToolChoice;
    toolScopeLocked?: boolean;
    forcedToolCall?: ForcedToolCall | null;
    explicitEmojiRequest?: boolean;
    keepAutoToolsOnChatTurn?: boolean;
    historyMode?: string;
    selectedHistoryCount?: number;
}
