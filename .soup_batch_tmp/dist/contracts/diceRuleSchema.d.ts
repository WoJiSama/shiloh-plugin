export interface RuleField {
    type: string;
    label?: string;
    description?: string;
    default?: unknown;
    formula?: string;
    min?: number;
    max?: number;
    step?: number;
    enum?: unknown[];
    max_length?: number;
    secret?: boolean;
    persistent?: boolean;
}
export interface RuleAction {
    op: string;
    scope?: string;
    target?: string;
    field?: string;
    value?: unknown;
    min?: unknown;
    max?: unknown;
    when?: unknown;
    status?: string;
    duration?: unknown;
    stacks?: unknown;
    item?: string;
    quantity?: unknown;
    ability?: string;
    rank?: unknown;
}
export interface RuleArgument extends RuleField {
    id: string;
    required?: boolean;
    rest?: boolean;
    multiple?: boolean;
    allowed?: string[];
}
export interface RuleBranch {
    when?: unknown;
    result?: string;
    let?: Record<string, unknown>;
    actions?: RuleAction[];
    output?: string;
    tags?: string[];
}
export interface RuleCommand {
    id: string;
    aliases?: string[];
    label?: string;
    description?: string;
    permission?: string;
    visibility?: string;
    public_output?: string;
    arguments?: RuleArgument[];
    rolls?: Record<string, unknown>;
    draws?: Record<string, unknown>;
    let?: Record<string, unknown>;
    opposed?: {
        target: string;
        actor_value: unknown;
        target_value: unknown;
        mode?: string;
        tie?: string;
    };
    branches?: RuleBranch[];
    actions?: RuleAction[];
    template?: string;
    output?: string;
    error_output?: string;
}
export interface RuleStatus {
    label: string;
    description?: string;
    default_duration?: number;
    max_stacks?: number;
    tick?: string;
    on_apply?: RuleAction[];
    on_tick?: RuleAction[];
    on_expire?: RuleAction[];
}
export interface RuleItem {
    label: string;
    description?: string;
    stackable?: boolean;
    max_quantity?: number;
    slot?: string;
    consumable?: boolean;
    on_use?: RuleAction[];
    on_equip?: RuleAction[];
    on_unequip?: RuleAction[];
}
export interface RuleAbility {
    label: string;
    description?: string;
    kind?: string;
    max_rank?: number;
    cooldown?: number;
    resource_scope?: string;
    resource_field?: string;
    resource_cost?: number;
    on_use?: RuleAction[];
}
export interface RuleLimits {
    max_dice_count: number;
    max_rolls: number;
    max_expression_length: number;
    max_output_length: number;
    max_table_entries: number;
}
export interface RuleMigration {
    from: string;
    to?: string;
    rename_fields?: Record<string, string>;
    add_defaults?: Record<string, unknown>;
    rename_group_fields?: Record<string, string>;
    add_group_defaults?: Record<string, unknown>;
}
export interface DiceRulePack {
    version: 1;
    id: string;
    name: string;
    aliases?: string[];
    description?: string;
    compatibility: {
        min_runtime: string;
        package_version: string;
        migrations?: RuleMigration[];
    };
    identity?: {
        display_name?: string;
        fallback?: string;
        group_card?: string;
        sync_group_card?: boolean;
    };
    character: {
        fields: Record<string, RuleField>;
    };
    group: {
        fields: Record<string, RuleField>;
    };
    statuses: Record<string, RuleStatus>;
    items: Record<string, RuleItem>;
    abilities: Record<string, RuleAbility>;
    events: Record<string, RuleAction[]>;
    dice_sets: Record<string, {
        label?: string;
        faces: (number | string | {
            value: number;
            text?: string;
            weight?: number;
        })[];
    }>;
    tables: Record<string, {
        label?: string;
        entries: (string | {
            weight?: number;
            text?: string;
            value?: unknown;
            tags?: string[];
        })[];
    }>;
    commands: RuleCommand[];
    templates: Record<string, string>;
    limits: RuleLimits;
}
