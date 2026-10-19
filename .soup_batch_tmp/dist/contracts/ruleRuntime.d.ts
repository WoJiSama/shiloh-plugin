import type { DiceRulePack, RuleCommand } from './diceRuleSchema.js';
import type { RuleActor, RuleStored, RuleGroupState, RuleSession, RuleStatusState } from './rulePack.js';
import type { DiceEvent, DiceState } from './dice.js';
import type { ExpressionOptions } from './diceExpression.js';
export type RulePack = DiceRulePack & {
    __functions?: ExpressionOptions['customFunctions'];
    __sealUnsupported?: string[];
    kind?: string;
};
export interface RuleVersion {
    id: string;
    version: number;
    packageVersion: string;
    createdAt: number;
    nameHint: string;
    kind: string;
    functionNames: string[];
    sourceFile: string;
    normalizedFile: string;
    hash: string;
    normalizedHash: string;
}
export interface RulePending {
    stageId: string;
    id: string;
    actorId: string;
    createdAt: number;
    nameHint: string;
    kind: string;
    functionNames: string[];
    sourceFile: string;
    normalizedFile: string;
    sourceHash: string;
    normalizedHash: string;
}
export interface RulePackage {
    id: string;
    name: string;
    versions: RuleVersion[];
    archived?: boolean;
    archivedAt?: string;
    restoredAt?: string;
}
export interface RuleIndex {
    version: number;
    packages: Record<string, RulePackage>;
    groups: Record<string, {
        active: Record<string, number>;
    }>;
    pending: Record<string, RulePending>;
}
export interface RuleDraft {
    key: string;
    actor: RuleActor;
    container: {
        ruleData?: RuleStored | null | undefined;
    };
    original: RuleStored | null | undefined;
    stored: RuleStored;
    attr: Record<string, unknown>;
    inventory: Record<string, unknown>;
    abilities: Record<string, unknown>;
    commit(value: RuleStored): void;
    group?: boolean;
}
export interface RuleDescription {
    id: string;
    name: string;
    kind: string;
    attr: Record<string, unknown>;
    derived: Record<string, unknown>;
    statuses: Record<string, RuleStatusState>;
    inventory: Record<string, unknown>;
    abilities: Record<string, unknown>;
}
export interface RuleContext {
    arg: Record<string, unknown>;
    attr: Record<string, unknown>;
    derived: Record<string, unknown>;
    roll: Record<string, {
        expr: string;
        total: number;
        detail: string;
    }>;
    table: Record<string, unknown>;
    let: Record<string, unknown>;
    result: string;
    group: {
        id: string | number;
    };
    shared: Record<string, unknown>;
    session: RuleSession;
    inventory: Record<string, unknown>;
    abilities: Record<string, unknown>;
    target: RuleDescription | null;
    opposed: {
        actor: number;
        target: number;
        result: string;
        winner: string;
        margin: number;
    } | null;
    status?: RuleStatusState | null;
}
export interface RuleRuntime {
    state: DiceState;
    e: DiceEvent;
    pack: RulePack;
    command?: RuleCommand;
    ruleState: RuleGroupState;
    actorDraft: RuleDraft;
    entityDrafts: Map<string, RuleDraft>;
    groupStored: RuleStored;
    args: Record<string, unknown>;
    context: RuleContext;
    random: () => number;
    randomSeed?: string;
    defaultTarget: RuleDescription | null;
    auditActions: Record<string, unknown>[];
}
export interface RuleResult {
    text: string;
    privateMessages?: {
        deliveryId: string;
        userId: string;
        text: string;
    }[];
    auditId?: string;
    packId?: string;
    groupCardUpdates?: {
        userId: string;
        name: string;
    }[];
}
