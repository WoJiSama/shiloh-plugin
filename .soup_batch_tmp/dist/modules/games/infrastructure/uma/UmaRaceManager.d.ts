import { STRATEGIES } from './umaConstants.js';
import type { UmaEvent, UmaReport, UmaLogger, UmaConfig, UmaManagerPorts, UmaAffix, UmaTrait, UmaPet, UmaPlayerRecord, UmaPoints, UmaRunner, UmaRaceState, UmaRoom, UmaStage, UmaScene, UmaProfile, UmaCheck, UmaProficiencyEntry, UmaTrainingType, UmaRaceResult } from "../../../../contracts/uma.js";
export declare function createUmaRaceManager(ports: UmaManagerPorts): {
    UmaRaceManager: {
        new ({ cwd, logger }?: {
            cwd?: string;
            logger?: UmaLogger;
        }): {
            cwd: string;
            logger: UmaLogger | undefined;
            rooms: Map<string, UmaRoom>;
            lastRaceAt: Map<string, number>;
            writeChain: Promise<unknown>;
            getConfig(): UmaConfig;
            getDataDir(config?: UmaConfig): string;
            getPointsPath(config?: UmaConfig): string;
            readPoints(config?: UmaConfig): UmaPoints;
            writePoints(data: UmaPoints, config?: UmaConfig): Promise<void>;
            getUserId(e: UmaEvent): string;
            getPlayerRecord(userId: unknown, config?: UmaConfig): UmaPlayerRecord | null;
            getPlayerUma(userId: unknown, config?: UmaConfig): UmaPet | null;
            ensurePlayerUmaTrait(userId: unknown, config?: UmaConfig): Promise<{
                uma: UmaPet;
                trait: {
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
                } | {
                    key: string;
                    label: string;
                    fit: {
                        normal: number;
                        steady: number;
                        conserve: number;
                        burst: number;
                        inside: number;
                    };
                    tagFit: {
                        adverse: number;
                        technical: number;
                        sprint: number;
                        cheering: number;
                    };
                    description: string;
                };
            } | null>;
            isValidAttributes(attributes?: Record<string, number>): boolean;
            parseAdoptionInput(msg?: string): {
                name: string;
                personality: string;
            } | null;
            buildAttributeScores(personality?: string): {
                [k: string]: number;
            };
            generateAttributes(name?: string, personality?: string, total?: number): {
                [k: string]: number;
            };
            inferPersonalityTrait(name?: string, personality?: string): {
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
            } | {
                key: string;
                label: string;
                fit: {
                    normal: number;
                    steady: number;
                    conserve: number;
                    burst: number;
                    inside: number;
                };
                tagFit: {
                    adverse: number;
                    technical: number;
                    sprint: number;
                    cheering: number;
                };
                description: string;
            };
            normalizeUmaTrait(uma?: Partial<UmaPet>): {
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
            } | {
                key: string;
                label: string;
                fit: {
                    normal: number;
                    steady: number;
                    conserve: number;
                    burst: number;
                    inside: number;
                };
                tagFit: {
                    adverse: number;
                    technical: number;
                    sprint: number;
                    cheering: number;
                };
                description: string;
            };
            normalizeAttributeTargetTotal(total: number): number;
            normalizeAttributeTotal(attributes: Record<string, number>, targetTotal?: number): void;
            sumAttributes(attributes?: Record<string, number>): number;
            scaleAttributesToTotal(attributes?: Record<string, number>, targetTotal?: number): Record<string, number>;
            getRaceBalancedTotal(total: number, minTotal: number): number;
            prepareRacePlayers(players?: UmaRunner[]): {
                attributes: {
                    [x: string]: number;
                };
                personality?: string;
                joinedAt?: number;
                userId: string;
                nickname: string;
                umaName?: string;
                umaPersonality?: string;
                strategyKey: string;
                strategyLabel?: string;
                isNpc?: boolean;
                trait?: UmaTrait;
                traitKey?: string;
                traitLabel?: string;
                traitTagBonus?: number;
                umaAffix?: UmaAffix | null;
                affix?: UmaAffix | null;
                proficiency?: Record<string, number>;
                raceTags?: string[];
                race: UmaRaceState;
            }[];
            normalizeUmaAffix(value?: unknown): UmaAffix | null;
            getMaxedAttributeKeys(uma?: Partial<UmaPet>): string[];
            formatAffix(affix?: UmaAffix | null): string;
            getAffixRerollCost(config?: UmaConfig, affix?: UmaAffix | null): number;
            formatAffixRerollCostTable(config?: UmaConfig): string;
            pickWeighted<T>(items?: {
                value: T;
                weight: number;
            }[]): T | null;
            rollAffixForUma(uma?: Partial<UmaPet>): {
                id: string;
                label: string;
                quality: string;
                qualityLabel: string;
                tags: string[];
                mechanic: string;
                effect: number;
                rolledAt: string;
            };
            getAffixActionBonus(runner?: Partial<UmaRunner>, actionKey?: string): number;
            formatAffixDirections(tags?: string[]): string;
            formatAffixEffect(affix?: UmaAffix | null): string;
            describeAffixMechanic(mechanic?: string): string;
            affixMatchesAction(affix?: UmaAffix | null, actionKey?: string): boolean;
            isAffixMechanicUsed(runner?: Partial<UmaRunner>, key?: string): boolean;
            markAffixMechanicUsed(runner?: Partial<UmaRunner>, key?: string): void;
            gradeRaceRoll(roll: number, target: number, criticalLimit: number): "fail" | "success" | "critical" | "hard" | "fumble";
            isBetterGrade(a: string, b: string): boolean;
            showAffix(e: UmaEvent): string;
            rerollAffix(e: UmaEvent): Promise<string>;
            showAffixPool(): string;
            formatRaceRunnerName(runner?: Partial<UmaRunner>): string;
            formatAttributes(attributes?: Record<string, number>): string;
            formatTrainingAttributes(attributes?: Record<string, number>): string;
            formatTopProficiency(proficiency?: Record<string, number>): string;
            adoptUma(e: UmaEvent, { overwrite }?: {
                overwrite?: boolean | undefined;
            }): Promise<string>;
            showUma(e: UmaEvent): string;
            parseTrainingInput(msg?: string): {
                type: {
                    failTargetPenaltyChance?: number;
                    label: string;
                    aliases: string[];
                    cost: number;
                    baseRate: number;
                    decay: number;
                    minRate: number;
                    gain: number;
                    pity: number;
                    failPenaltyCount: number;
                    failPenaltyChance: number;
                    maxTargetValue?: number;
                    critGain?: number;
                    critRate?: number;
                    key: string;
                } | null;
                attribute: {
                    key: string;
                    label: string;
                } | null;
                raw: string;
            } | null;
            resolveTrainingType(text?: string): {
                failTargetPenaltyChance?: number;
                label: string;
                aliases: string[];
                cost: number;
                baseRate: number;
                decay: number;
                minRate: number;
                gain: number;
                pity: number;
                failPenaltyCount: number;
                failPenaltyChance: number;
                maxTargetValue?: number;
                critGain?: number;
                critRate?: number;
                key: string;
            } | null;
            resolveAttribute(text?: string): {
                key: string;
                label: string;
            } | null;
            getTrainingPity(record: UmaPlayerRecord | null, typeKey: string, attrKey: string): number;
            setTrainingPity(record: UmaPlayerRecord, typeKey: string, attrKey: string, value: number): void;
            getTrainingSuccessRate(type: UmaTrainingType, currentValue: unknown): number;
            trainUma(e: UmaEvent): Promise<string>;
            applyTrainingPenalty(attributes: Record<string, number>, targetKey: string, type: UmaTrainingType): string[];
            showTrainingStatus(e: UmaEvent): string;
            abandonUma(e: UmaEvent, { confirm }?: {
                confirm?: boolean | undefined;
            }): Promise<string>;
            removeUserFromActiveRoom(e: UmaEvent, userId: unknown): boolean;
            getRoom(groupId: string): UmaRoom | undefined;
            getDisplayName(e: UmaEvent): string;
            pickTrack(): {
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
            };
            pickTwist(): {
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
            };
            pickScene(): {
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
            };
            pickCondition(): {
                name: string;
                description: string;
                tags: string[];
                broadcast: string;
            };
            parseStrategy(input?: string): {
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
            formatStrategyTips(): string;
            formatTrack(track: UmaScene): string;
            formatRaceSceneName(room?: Partial<UmaRoom>): string;
            formatOpeningAnnouncer(room?: Partial<UmaRoom>): string;
            buildRaceProfile(track?: Partial<UmaScene>, twist?: Partial<UmaScene>, scene?: Partial<UmaScene>, condition?: Partial<UmaScene>): UmaProfile;
            getStageEnvironment(room: UmaRoom, stage: UmaStage): {
                profile: UmaProfile;
                index: number;
                segmentDistance: number;
                slope: number;
                corner: number;
                friction: number;
                staminaCostRate: number;
                rhythmDifficulty: number;
                routeDifficulty: number;
                speedCarry: number;
                variance: number;
            };
            startRace(e: UmaEvent): Promise<string>;
            joinRace(e: UmaEvent, strategyText?: string): Promise<string>;
            scheduleAutoStart(room: UmaRoom, config?: UmaConfig): void;
            clearAutoStart(room: UmaRoom): void;
            scheduleStageAdvance(room: UmaRoom, config?: UmaConfig): void;
            clearStageTimer(room: UmaRoom): void;
            autoStartRace(groupId: string): Promise<void>;
            getStrategyKey(strategy: (typeof STRATEGIES)[keyof typeof STRATEGIES]): string;
            cancelRace(e: UmaEvent): "这个小游戏要在群里玩。" | "现在没有赛马局。" | "只有开局的人或主人可以取消这一局。" | "这局赛马已经取消。";
            runRace(e: UmaEvent): Promise<string | any[]>;
            raceDecision(e: UmaEvent): Promise<string>;
            areAllHumanPlayersDecided(room: UmaRoom, stageDecisions: Map<string, string>): boolean;
            parseRaceAction(msg?: string): {
                label: string;
                aliases: string[];
                description: string;
                defaultFor?: string[];
                key: string;
            } | null;
            formatRaceActionTips(): string;
            formatRaceDecisionCopyText(): string;
            initializeStageRunners(players: UmaRunner[], track: UmaScene, twist: UmaScene, scene: UmaScene, condition?: Partial<UmaScene>): {
                attributes: Record<string, number>;
                strategyKey: string;
                strategyLabel: string;
                traitKey: string;
                traitLabel: string;
                traitTagBonus: number;
                proficiency: Record<string, number>;
                raceTags: string[];
                race: {
                    speed: number;
                    staminaAttr: number;
                    power: number;
                    focus: number;
                    wisdom: number;
                    luck: number;
                    position: number;
                    distance: number;
                    velocity: number;
                    maxVelocity: number;
                    staminaMax: number;
                    stamina: number;
                    rhythmMax: number;
                    rhythm: number;
                    burstMax: number;
                    burstReserve: number;
                    route: number;
                    luckState: number;
                    notes: string[];
                };
                personality?: string;
                joinedAt?: number;
                userId: string;
                nickname: string;
                umaName?: string;
                umaPersonality?: string;
                isNpc?: boolean;
                trait?: UmaTrait;
                umaAffix?: UmaAffix | null;
                affix?: UmaAffix | null;
            }[];
            advanceRaceStage(groupId: string): Promise<void>;
            resolveRaceStage(room: UmaRoom, stage: UmaStage): string[];
            applyRaceAction(runner: UmaRunner, action: {
                key: string;
                label?: string;
            }, stage: UmaStage, beforeRank: number, room: UmaRoom): {
                line: string;
            };
            formatActionNumericDelta(delta?: Record<string, number>): string;
            scalePositiveRaceDelta(value: number, rate?: number): number;
            getStageVelocityDecay(race?: Partial<UmaRaceState>, actionKey?: string, env?: Partial<ReturnType<(room: UmaRoom, stage: UmaStage) => {
                profile: UmaProfile;
                index: number;
                segmentDistance: number;
                slope: number;
                corner: number;
                friction: number;
                staminaCostRate: number;
                rhythmDifficulty: number;
                routeDifficulty: number;
                speedCarry: number;
                variance: number;
            }>>, check?: Partial<UmaCheck>): number;
            rollGambleActionEffect(check?: Partial<UmaCheck>, ceilingBonus?: number, effect?: {
                label: string;
                multiplier: number;
                staminaCost: number;
                rhythmPenalty: number;
                stateBonus: number;
            }, failGuard?: number): {
                distance: number;
                velocity: number;
                stamina: number;
                rhythm: number;
                route: number;
                text: string;
            };
            getFollowChaseEffect(runner?: Partial<UmaRunner>, beforeRank?: number, room?: Partial<UmaRoom>, check?: Partial<UmaCheck>, effect?: {
                label: string;
                multiplier: number;
                staminaCost: number;
                rhythmPenalty: number;
                stateBonus: number;
            }): {
                distance: number;
                velocity: number;
                text: string;
            };
            getCatchupActionBonus(runner?: Partial<UmaRunner>, actionKey?: string, beforeRank?: number, room?: Partial<UmaRoom>, check?: Partial<UmaCheck>): {
                distance: number;
                velocity: number;
                text: string;
            };
            getRaceGapContext(runner?: Partial<UmaRunner>, room?: Partial<UmaRoom>): {
                previousGap: number;
                leaderGap: number;
                rank: number;
            };
            adjustRaceCost(value: number, rate?: number, guardAttribute?: number): number;
            rollRaceActionCheck(runner: UmaRunner, actionKey: string, stage: UmaStage, room: UmaRoom): {
                roll: number;
                rawRoll: number;
                target: number;
                grade: string;
                label: string;
                affixNotes: string[];
                success: boolean;
                text: string;
            };
            getActionCheckSupportBonus(runner: UmaRunner, actionKey: string): number;
            getActionAttributePush(runner: UmaRunner, actionKey: string): number;
            getSignatureAttributePush(runner: UmaRunner, actionKey: string): number;
            getStageActionRate(actionKey: string, stageKey: string, trackId: string): number;
            getDefaultStageAction(runner: UmaRunner): string;
            getAttributeSpecialty(attributes?: Record<string, number>): {
                key: string;
                value: number;
                gap: number;
                isClear: boolean;
            };
            getSpecialtyAction(runner?: Partial<UmaRunner>, stage?: Partial<UmaStage>): string | null;
            getDefaultStageActionForStage(runner?: Partial<UmaRunner>, stage?: Partial<UmaStage>, beforeRank?: number | null, room?: UmaRoom | null): string;
            getDynamicStageAction(runner?: Partial<UmaRunner>, stage?: Partial<UmaStage>, beforeRank?: number | null, room?: UmaRoom | null): "follow" | "inside" | "burst" | "steady" | "speed_up" | "pace" | "slow_down" | "gamble" | null;
            pickNpcStageAction(runner: UmaRunner, beforeRank: number, stage: UmaStage, room?: UmaRoom | null): string;
            rankRunners(runners?: UmaRunner[]): UmaRunner[];
            formatRaceStage(room: UmaRoom, { opening, includeTips }?: {
                opening?: boolean | undefined;
                includeTips?: boolean | undefined;
            }): string;
            formatActiveRaceStatus(room: UmaRoom): string;
            formatStageRanking(runners?: UmaRunner[]): string[];
            describeRunnerState(runner: UmaRunner): string;
            renderRaceReportOrFallback(e: UmaEvent, report: UmaReport, fallbackText: string): Promise<{}>;
            appendMessageText(message: unknown, text: string): unknown;
            buildStageRaceReport(room: UmaRoom, previousStage: UmaStage, lines?: string[]): {
                type: string;
                title: string;
                subtitle: string;
                scene: string;
                generatedAt: string;
                prompt: string;
                ranking: {
                    rank: number;
                    name: string;
                    affix: UmaAffix | null;
                    isNpc: boolean;
                    gapToPrevious: number;
                    gapText: string;
                    meta: string;
                    strategy: string;
                    state: string;
                }[];
                highlights: string[];
            };
            buildOpeningRaceReport(room: UmaRoom): {
                type: string;
                title: string;
                subtitle: string;
                scene: string;
                generatedAt: string;
                prompt: string;
                ranking: {
                    rank: number;
                    name: string;
                    affix: UmaAffix | null;
                    isNpc: boolean;
                    gapToPrevious: number;
                    gapText: string;
                    meta: string;
                    strategy: string;
                    state: string;
                }[];
                highlights: string[];
            };
            buildFinalRaceReport(result: UmaRaceResult, awardLines?: string[]): {
                type: string;
                title: string;
                subtitle: string;
                scene: string;
                generatedAt: string;
                prompt: string;
                ranking: {
                    rank: number;
                    name: string;
                    affix: UmaAffix | null;
                    isNpc: boolean;
                    gapToPrevious: number;
                    gapText: string;
                    meta: string;
                    strategy: string;
                    state: string;
                }[];
                highlights: string[];
                awards: string[];
                proficiencyGains: UmaProficiencyEntry[];
            };
            buildRaceReportRanking(runners?: UmaRunner[]): {
                rank: number;
                name: string;
                affix: UmaAffix | null;
                isNpc: boolean;
                gapToPrevious: number;
                gapText: string;
                meta: string;
                strategy: string;
                state: string;
            }[];
            formatRaceGapText(gapToPrevious?: number, index?: number): string;
            formatReportTime(): string;
            finishStagedRace(room: UmaRoom): Promise<{}>;
            fillNpcPlayers(players: UmaRunner[], minPlayers: number): void;
            pickNpcName(usedNames: Set<string>): string;
            pickNpcUmaName(usedNames: Set<string>): string;
            getNpcBaseAttributeTotal(players?: UmaRunner[]): number;
            pickNpcAttributeTotal(baseTotal?: number): number;
            simulateRace(players: UmaRunner[], track?: {
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
            }, twist?: {
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
            }, scene?: {
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
            }, condition?: {
                name: string;
                description: string;
                tags: string[];
                broadcast: string;
            }): {
                ranking: UmaRunner[];
                highlights: string[];
                track: {
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
                };
                condition: {
                    name: string;
                    description: string;
                    tags: string[];
                    broadcast: string;
                };
                twist: {
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
                };
                scene: {
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
                };
            };
            countStrategies(players: UmaRunner[]): Map<string, number>;
            getRaceTrait(player?: Partial<UmaRunner> & {
                personality?: string;
            }): {
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
            } | {
                key: string;
                label: string;
                fit: {
                    normal: number;
                    steady: number;
                    conserve: number;
                    burst: number;
                    inside: number;
                };
                tagFit: {
                    adverse: number;
                    technical: number;
                    sprint: number;
                    cheering: number;
                };
                description: string;
            };
            normalizeProficiency(proficiency?: Record<string, number>): Record<string, number>;
            getProficiencyLevel(value?: number): {
                min: number;
                label: string;
                bonus: number;
            };
            getProficiencyProgress(value?: number): {
                value: number;
                level: string;
                levelIndex: number;
                nextLevel: string;
                target: number;
                need: number;
                percent: number;
            };
            getActionProficiencyBonus(runner?: Partial<UmaRunner>, actionKey?: string): number;
            recordActionProficiencyUse(runner?: {
                isNpc?: boolean;
                race?: {
                    actionUses?: {
                        actionKey: string;
                        grade: string;
                    }[];
                };
            }, actionKey?: string, check?: Partial<UmaCheck>): void;
            calculateProficiencyGains(runner?: {
                race?: {
                    actionUses?: {
                        actionKey: string;
                        grade: string;
                    }[];
                };
            }): {
                actionKey: string;
                gain: number;
            }[];
            getRaceTags(track?: Partial<UmaScene>, twist?: Partial<UmaScene>, scene?: Partial<UmaScene>, condition?: Partial<UmaScene>): Set<string>;
            getTraitTagBonus(trait?: Partial<UmaTrait>, raceTags?: Set<string>): number;
            getTraitBonus(trait: UmaTrait, strategyKey: string, raceTags?: Set<string>): number;
            formatTraitAffinity(runner?: Partial<UmaRunner>): "适性：契合" | "适性：吃力" | "适性：普通";
            rollAttributeValue(attribute: number, base?: number, scale?: number): number;
            getStrategyCrowdPenalty(strategyKey: string, strategyCounts: Map<string, number>, totalPlayers: number): number;
            buildRunnerEvent(name: string, strategy: {
                label: string;
                event: string;
            }, track: UmaScene, twist: UmaScene, scene: UmaScene, details?: Record<string, number | string>): string;
            formatConditionEvent(name: string, conditionBonus: number): string;
            buildRaceHighlights(runners: UmaRunner[], track: UmaScene, twist: UmaScene, scene: UmaScene): string[];
            getAwards(config: UmaConfig): number[];
            applyProficiencyGains(ranking?: UmaRunner[], config?: UmaConfig): Promise<{
                userId: string;
                nickname: string;
                umaName: string;
                gains: {
                    actionKey: string;
                    label: string;
                    gain: number;
                    before: number;
                    after: number;
                    progress: {
                        value: number;
                        level: string;
                        levelIndex: number;
                        nextLevel: string;
                        target: number;
                        need: number;
                        percent: number;
                    };
                }[];
            }[]>;
            formatProficiencyGainLines(entries?: UmaProficiencyEntry[]): string;
            applyAwards(ranking: UmaRunner[], awards: number[], config: UmaConfig): Promise<string[]>;
            formatRaceResult(result: UmaRaceResult, awardLines: string[]): string;
            buildRaceReviewLines(ranking?: UmaRunner[]): string[];
            formatRunnerName(runner: UmaRunner): string;
            showScore(e: UmaEvent): string;
            parseScoreAdjustInput(msg?: string): {
                userId: string;
                amount: number;
            } | null;
            adjustScore(e: UmaEvent): Promise<string>;
            showRank(limit: unknown): string;
            showHelp(): string;
        };
    };
};
