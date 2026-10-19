import type { UmaTrainingType } from '../../../../contracts/uma.js';
declare const DEFAULT_CONFIG: {
    enabled: boolean;
    minPlayers: number;
    maxPlayers: number;
    lobbySeconds: number;
    raceStageSeconds: number;
    cooldownSeconds: number;
    winPoints: number;
    secondPoints: number;
    thirdPoints: number;
    participationPoints: number;
    rankLimit: number;
    baseDir: string;
};
declare const RACE_SIZE = 8;
declare const RACE_STAGES: {
    key: string;
    label: string;
    prompt: string;
    event: string;
}[];
declare const RACE_ACTIONS: Record<string, {
    label: string;
    aliases: string[];
    description: string;
    defaultFor?: string[];
}>;
declare const PROFICIENCY_MAX = 1000;
declare const PROFICIENCY_SINGLE_ACTION_CAP = 10;
declare const PROFICIENCY_TOTAL_RACE_CAP = 16;
declare const PROFICIENCY_REPEAT_GAINS: number[];
declare const PROFICIENCY_CHECK_GAINS: {
    critical: number;
    hard: number;
    success: number;
    fail: number;
    fumble: number;
};
declare const PROFICIENCY_LEVELS: {
    min: number;
    label: string;
    bonus: number;
}[];
declare const ACTION_CHECKS: Record<string, {
    primary: string;
    secondary: string;
    state: string;
    stateWeight: number;
    scene: Record<string, number>;
    track: Record<string, number>;
    successText: string;
    failText: string;
}>;
declare const CHECK_GRADE_EFFECTS: {
    critical: {
        label: string;
        multiplier: number;
        staminaCost: number;
        rhythmPenalty: number;
        stateBonus: number;
    };
    hard: {
        label: string;
        multiplier: number;
        staminaCost: number;
        rhythmPenalty: number;
        stateBonus: number;
    };
    success: {
        label: string;
        multiplier: number;
        staminaCost: number;
        rhythmPenalty: number;
        stateBonus: number;
    };
    fail: {
        label: string;
        multiplier: number;
        staminaCost: number;
        rhythmPenalty: number;
        stateBonus: number;
    };
    fumble: {
        label: string;
        multiplier: number;
        staminaCost: number;
        rhythmPenalty: number;
        stateBonus: number;
    };
};
declare const STRATEGY_DEFAULT_ACTIONS: Record<string, string>;
declare const NPC_NAMES: string[];
declare const NPC_UMA_PREFIXES: string[];
declare const NPC_UMA_SUFFIXES: string[];
declare const ATTRIBUTE_DEFS: {
    key: string;
    label: string;
}[];
declare const ATTRIBUTE_TOTAL = 40;
declare const ATTRIBUTE_MAX = 50;
declare const ATTRIBUTE_MIN = 1;
declare const RACE_BALANCE_THRESHOLD = 15;
declare const RACE_BALANCE_RETAIN_RATE = 0.35;
declare const RACE_BALANCE_MIN_SELF_RATE = 0.7;
declare const TRACK_NUMERIC_PROFILES: {
    rain_mud: {
        distance: number;
        segments: number[];
        friction: number;
        slope: number[];
        corner: number[];
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
    long_straight: {
        distance: number;
        segments: number[];
        friction: number;
        slope: number[];
        corner: number[];
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
    many_corners: {
        distance: number;
        segments: number[];
        friction: number;
        slope: number[];
        corner: number[];
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
    short_sprint: {
        distance: number;
        segments: number[];
        friction: number;
        slope: number[];
        corner: number[];
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
    endurance: {
        distance: number;
        segments: number[];
        friction: number;
        slope: number[];
        corner: number[];
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
    uphill_finish: {
        distance: number;
        segments: number[];
        friction: number;
        slope: number[];
        corner: number[];
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
    downhill_corner: {
        distance: number;
        segments: number[];
        friction: number;
        slope: number[];
        corner: number[];
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
    sand_track: {
        distance: number;
        segments: number[];
        friction: number;
        slope: number[];
        corner: number[];
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
    night_race: {
        distance: number;
        segments: number[];
        friction: number;
        slope: number[];
        corner: number[];
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
};
declare const TWIST_NUMERIC_MODIFIERS: {
    慢节奏: {
        speedCarry: number;
        staminaCostRate: number;
        finalSpeedCarry: number;
    };
    突然提速: {
        speedCarry: number;
        staminaCostRate: number;
        rhythmDifficulty: number;
    };
    位置混战: {
        routeDifficulty: number;
        rhythmDifficulty: number;
        corner: number;
    };
    外道顺风: {
        finalSpeedCarry: number;
        routeDifficulty: number;
    };
    节奏很乱: {
        rhythmDifficulty: number;
        routeDifficulty: number;
    };
    终点前逆风: {
        finalSpeedCarry: number;
        staminaCostRate: number;
    };
};
declare const SCENE_NUMERIC_MODIFIERS: {
    大雨突袭: {
        friction: number;
        staminaCostRate: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
    };
    观众欢呼: {
        finalSpeedCarry: number;
        variance: number;
    };
    起跑失误: {
        startSpeedCarry: number;
        routeDifficulty: number;
    };
    最后弯道堵车: {
        finalRouteDifficulty: number;
        corner: number;
    };
};
declare const CONDITION_NUMERIC_MODIFIERS: {
    维护良好: {
        friction: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
    };
    干燥高速: {
        friction: number;
        staminaCostRate: number;
        speedCarry: number;
    };
    松软吃力: {
        friction: number;
        staminaCostRate: number;
        speedCarry: number;
    };
    湿滑难控: {
        friction: number;
        rhythmDifficulty: number;
        routeDifficulty: number;
    };
    硬地弹脚: {
        friction: number;
        speedCarry: number;
        rhythmDifficulty: number;
        variance: number;
    };
    能见度差: {
        rhythmDifficulty: number;
        routeDifficulty: number;
        speedCarry: number;
    };
};
declare const ATTRIBUTE_ALIASES: Record<string, string[]>;
declare const AFFIX_QUALITIES: Record<string, {
    label: string;
    weight: number;
    effect: number;
}>;
declare const AFFIX_REROLL_COSTS: Record<string, number>;
declare const AFFIX_DIRECTION_LABELS: Record<string, string>;
declare const ACTION_AFFIX_DIRECTIONS: Record<string, string[]>;
declare const AFFIX_POOL: {
    id: string;
    label: string;
    quality: string;
    tags: string[];
    mechanic: string;
}[];
declare const TRAINING_TYPES: Record<string, UmaTrainingType>;
declare const PERSONALITY_ATTRIBUTE_RULES: {
    pattern: RegExp;
    add: Record<string, number>;
}[];
declare const PERSONALITY_TRAITS: ({
    key: string;
    label: string;
    pattern: RegExp;
    fit: {
        steady: number;
        conserve: number;
        burst: number;
        inside?: never;
        normal?: never;
    };
    tagFit: {
        adverse: number;
        wet: number;
        night: number;
        chaotic: number;
        sprint: number;
        pace_fast: number;
        straight?: never;
        uphill?: never;
        long?: never;
        pace_slow?: never;
        corner?: never;
        downhill?: never;
        crowded?: never;
        cheering?: never;
        sand?: never;
        headwind?: never;
        technical?: never;
        tailwind?: never;
        mud?: never;
    };
    description: string;
    riskAdjust?: never;
    varianceBonus?: never;
    luckBonus?: never;
} | {
    key: string;
    label: string;
    pattern: RegExp;
    fit: {
        burst: number;
        inside: number;
        conserve: number;
        steady?: never;
        normal?: never;
    };
    tagFit: {
        straight: number;
        uphill: number;
        sprint: number;
        long: number;
        adverse: number;
        wet: number;
        pace_slow: number;
        night?: never;
        chaotic?: never;
        pace_fast?: never;
        corner?: never;
        downhill?: never;
        crowded?: never;
        cheering?: never;
        sand?: never;
        headwind?: never;
        technical?: never;
        tailwind?: never;
        mud?: never;
    };
    riskAdjust: number;
    description: string;
    varianceBonus?: never;
    luckBonus?: never;
} | {
    key: string;
    label: string;
    pattern: RegExp;
    fit: {
        steady: number;
        normal: number;
        inside: number;
        conserve?: never;
        burst?: never;
    };
    tagFit: {
        corner: number;
        downhill: number;
        night: number;
        crowded: number;
        chaotic: number;
        sprint: number;
        cheering: number;
        adverse?: never;
        wet?: never;
        pace_fast?: never;
        straight?: never;
        uphill?: never;
        long?: never;
        pace_slow?: never;
        sand?: never;
        headwind?: never;
        technical?: never;
        tailwind?: never;
        mud?: never;
    };
    description: string;
    riskAdjust?: never;
    varianceBonus?: never;
    luckBonus?: never;
} | {
    key: string;
    label: string;
    pattern: RegExp;
    fit: {
        conserve: number;
        steady: number;
        burst: number;
        inside?: never;
        normal?: never;
    };
    tagFit: {
        long: number;
        uphill: number;
        sand: number;
        adverse: number;
        headwind: number;
        sprint: number;
        pace_fast: number;
        wet?: never;
        night?: never;
        chaotic?: never;
        straight?: never;
        pace_slow?: never;
        corner?: never;
        downhill?: never;
        crowded?: never;
        cheering?: never;
        technical?: never;
        tailwind?: never;
        mud?: never;
    };
    description: string;
    riskAdjust?: never;
    varianceBonus?: never;
    luckBonus?: never;
} | {
    key: string;
    label: string;
    pattern: RegExp;
    fit: {
        normal: number;
        burst: number;
        inside: number;
        steady?: never;
        conserve?: never;
    };
    tagFit: {
        sprint: number;
        cheering: number;
        chaotic: number;
        pace_fast: number;
        technical: number;
        crowded: number;
        headwind: number;
        adverse?: never;
        wet?: never;
        night?: never;
        straight?: never;
        uphill?: never;
        long?: never;
        pace_slow?: never;
        corner?: never;
        downhill?: never;
        sand?: never;
        tailwind?: never;
        mud?: never;
    };
    varianceBonus: number;
    luckBonus: number;
    description: string;
    riskAdjust?: never;
} | {
    key: string;
    label: string;
    pattern: RegExp;
    fit: {
        normal: number;
        steady: number;
        inside: number;
        conserve?: never;
        burst?: never;
    };
    tagFit: {
        night: number;
        straight: number;
        tailwind: number;
        pace_slow: number;
        mud: number;
        sand: number;
        chaotic: number;
        adverse?: never;
        wet?: never;
        sprint?: never;
        pace_fast?: never;
        uphill?: never;
        long?: never;
        corner?: never;
        downhill?: never;
        crowded?: never;
        cheering?: never;
        headwind?: never;
        technical?: never;
    };
    description: string;
    riskAdjust?: never;
    varianceBonus?: never;
    luckBonus?: never;
})[];
declare const STRATEGIES: {
    normal: {
        label: string;
        aliases: string[];
        description: string;
        event: string;
        weights: {
            speed: number;
            stamina: number;
            focus: number;
            luck: number;
        };
        variance: number;
        risk: number;
    };
    steady: {
        label: string;
        aliases: string[];
        description: string;
        event: string;
        weights: {
            speed: number;
            stamina: number;
            focus: number;
            luck: number;
        };
        variance: number;
        risk: number;
    };
    burst: {
        label: string;
        aliases: string[];
        description: string;
        event: string;
        weights: {
            speed: number;
            stamina: number;
            focus: number;
            luck: number;
        };
        variance: number;
        risk: number;
    };
    conserve: {
        label: string;
        aliases: string[];
        description: string;
        event: string;
        weights: {
            speed: number;
            stamina: number;
            focus: number;
            luck: number;
        };
        variance: number;
        risk: number;
    };
    inside: {
        label: string;
        aliases: string[];
        description: string;
        event: string;
        weights: {
            speed: number;
            stamina: number;
            focus: number;
            luck: number;
        };
        variance: number;
        risk: number;
    };
};
declare const TRACKS: ({
    id: string;
    name: string;
    description: string;
    tags: string[];
    fit: {
        steady: number;
        conserve: number;
        burst: number;
        inside: number;
        normal?: never;
    };
    weights: {
        speed: number;
        stamina: number;
        focus: number;
        luck: number;
    };
    events: string[];
} | {
    id: string;
    name: string;
    description: string;
    tags: string[];
    fit: {
        steady: number;
        inside: number;
        normal: number;
        burst: number;
        conserve?: never;
    };
    weights: {
        speed: number;
        stamina: number;
        focus: number;
        luck: number;
    };
    events: string[];
})[];
declare const RACE_TWISTS: {
    name: string;
    description: string;
    tags: string[];
    fit: {
        conserve: number;
        steady: number;
        burst: number;
        inside: number;
        normal: number;
    };
    event: string;
}[];
declare const RACE_SCENES: {
    name: string;
    description: string;
    tags: string[];
    fit: {
        steady: number;
        conserve: number;
        normal: number;
        burst: number;
        inside: number;
    };
    event: string;
}[];
declare const RACE_CONDITIONS: {
    name: string;
    description: string;
    tags: string[];
    broadcast: string;
}[];
declare const CONDITION_EVENTS: {
    min: number;
    text: string;
}[];
export { DEFAULT_CONFIG, RACE_SIZE, RACE_STAGES, RACE_ACTIONS, PROFICIENCY_MAX, PROFICIENCY_SINGLE_ACTION_CAP, PROFICIENCY_TOTAL_RACE_CAP, PROFICIENCY_REPEAT_GAINS, PROFICIENCY_CHECK_GAINS, PROFICIENCY_LEVELS, ACTION_CHECKS, CHECK_GRADE_EFFECTS, STRATEGY_DEFAULT_ACTIONS, NPC_NAMES, NPC_UMA_PREFIXES, NPC_UMA_SUFFIXES, ATTRIBUTE_DEFS, ATTRIBUTE_TOTAL, ATTRIBUTE_MAX, ATTRIBUTE_MIN, RACE_BALANCE_THRESHOLD, RACE_BALANCE_RETAIN_RATE, RACE_BALANCE_MIN_SELF_RATE, TRACK_NUMERIC_PROFILES, TWIST_NUMERIC_MODIFIERS, SCENE_NUMERIC_MODIFIERS, CONDITION_NUMERIC_MODIFIERS, ATTRIBUTE_ALIASES, AFFIX_QUALITIES, AFFIX_REROLL_COSTS, AFFIX_DIRECTION_LABELS, ACTION_AFFIX_DIRECTIONS, AFFIX_POOL, TRAINING_TYPES, PERSONALITY_ATTRIBUTE_RULES, PERSONALITY_TRAITS, STRATEGIES, TRACKS, RACE_TWISTS, RACE_SCENES, RACE_CONDITIONS, CONDITION_EVENTS };
