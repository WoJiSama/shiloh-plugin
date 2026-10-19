const DEFAULT_CONFIG = {
    enabled: true,
    minPlayers: 8,
    maxPlayers: 8,
    lobbySeconds: 300,
    raceStageSeconds: 45,
    cooldownSeconds: 30,
    winPoints: 6,
    secondPoints: 4,
    thirdPoints: 2,
    participationPoints: 1,
    rankLimit: 10,
    baseDir: "data/uma_race"
};
const RACE_SIZE = 8;
const RACE_STAGES = [
    {
        key: "start",
        label: "起步阶段",
        prompt: "刚出闸，抢速度和找位置都很关键。",
        event: "闸门一开，前排很快挤成一线，后面的人也在找空档。"
    },
    {
        key: "mid",
        label: "半程阶段",
        prompt: "节奏已经拉开，有人开始喘，也有人还在等机会。",
        event: "半程过后，队伍节奏明显分层，内外线都在重新洗牌。"
    },
    {
        key: "finish",
        label: "冲刺阶段",
        prompt: "最后直线到了，保住节奏还是全力冲刺都要现在决定。",
        event: "终点线已经能看见，前排开始顶速度，后排只能找最后的机会。"
    }
];
const RACE_ACTIONS = {
    speed_up: {
        label: "提速",
        aliases: ["提速", "加速", "冲", "快跑", "拉速度"],
        description: "吃速度，位置提升明显，但会消耗耐力并让节奏更紧。",
        defaultFor: ["burst"]
    },
    slow_down: {
        label: "减速",
        aliases: ["减速", "放慢", "慢一点", "缓一缓", "回复"],
        description: "位置会让一点，但能把呼吸和节奏收回来。"
    },
    steady: {
        label: "稳住",
        aliases: ["稳住", "稳一点", "稳定", "别急", "保持"],
        description: "吃稳定，波动最小，适合复杂路况。"
    },
    inside: {
        label: "抢位",
        aliases: ["抢位", "抢内道", "内道", "卡位", "贴内"],
        description: "吃判断，成功会省距离，失败会被堵。"
    },
    burst: {
        label: "爆发",
        aliases: ["爆发", "冲刺", "全力", "拼一把", "开大"],
        description: "吃爆发，冲刺收益很高，但会大量消耗余力。"
    },
    gamble: {
        label: "赌一把",
        aliases: ["赌一把", "赌", "搏一把", "莽", "看运气"],
        description: "吃运气，上下限都很大，可能突然翻盘也可能乱节奏。"
    },
    follow: {
        label: "跟跑",
        aliases: ["跟跑", "跟住", "咬住", "跟前面"],
        description: "吃判断和稳定，适合贴住前排，超车能力一般。"
    },
    pace: {
        label: "压节奏",
        aliases: ["压节奏", "留体力", "省体力", "控节奏", "攒体力"],
        description: "吃耐力和稳定，短期不抢，后段更舒服。",
        defaultFor: ["conserve"]
    }
};
const PROFICIENCY_MAX = 1000;
const PROFICIENCY_SINGLE_ACTION_CAP = 10;
const PROFICIENCY_TOTAL_RACE_CAP = 16;
const PROFICIENCY_REPEAT_GAINS = [2, 3, 4];
const PROFICIENCY_CHECK_GAINS = {
    critical: 2,
    hard: 1,
    success: 0,
    fail: 0,
    fumble: 1
};
const PROFICIENCY_LEVELS = [
    { min: 800, label: "专长", bonus: 4 },
    { min: 500, label: "精通", bonus: 3 },
    { min: 250, label: "熟练", bonus: 2 },
    { min: 100, label: "入门", bonus: 1 },
    { min: 0, label: "生疏", bonus: 0 }
];
const ACTION_CHECKS = {
    speed_up: {
        primary: "speed",
        secondary: "staminaAttr",
        state: "stamina",
        stateWeight: 0.08,
        scene: { start: 8, mid: 0, finish: 4 },
        track: { short_sprint: 8, long_straight: 5, downhill_corner: 4, rain_mud: -5, endurance: -4 },
        successText: "脚步明显往前压",
        failText: "速度没完全带起来"
    },
    slow_down: {
        primary: "staminaAttr",
        secondary: "focus",
        state: "rhythm",
        stateWeight: 0.08,
        scene: { start: -6, mid: 7, finish: -10 },
        track: { endurance: 5, rain_mud: 4, uphill_finish: 3, short_sprint: -8 },
        successText: "把呼吸稳稳收回来",
        failText: "想收节奏但位置让得有点多"
    },
    steady: {
        primary: "focus",
        secondary: "wisdom",
        state: "rhythm",
        stateWeight: 0.1,
        scene: { start: 3, mid: 6, finish: 2 },
        track: { rain_mud: 8, many_corners: 7, downhill_corner: 6, night_race: 5 },
        successText: "动作不夸张但路线很干净",
        failText: "节奏压住了，但推进不够果断"
    },
    inside: {
        primary: "wisdom",
        secondary: "focus",
        state: "route",
        stateWeight: 0.08,
        scene: { start: 7, mid: 5, finish: 2 },
        track: { many_corners: 8, downhill_corner: 6, short_sprint: 4, rain_mud: -4, sand_track: -4 },
        successText: "找到空档抢到了舒服路线",
        failText: "前排太挤，被迫多等了一拍"
    },
    burst: {
        primary: "power",
        secondary: "speed",
        state: "burstReserve",
        stateWeight: 0.08,
        scene: { start: -4, mid: 0, finish: 10 },
        track: { long_straight: 8, short_sprint: 8, uphill_finish: 5, endurance: -6, rain_mud: -5 },
        successText: "冲刺动作一下子顶了出来",
        failText: "余力烧得很快，身位没顶出去"
    },
    gamble: {
        primary: "luck",
        secondary: "wisdom",
        state: "luckState",
        stateWeight: 0.11,
        scene: { start: 0, mid: 3, finish: 5 },
        track: { short_sprint: 3, night_race: 2 },
        successText: "刚好抓到一个很漂亮的机会",
        failText: "这次没接住节奏，脚步有点乱"
    },
    follow: {
        primary: "wisdom",
        secondary: "focus",
        state: "rhythm",
        stateWeight: 0.08,
        scene: { start: 0, mid: 8, finish: 2 },
        track: { many_corners: 5, night_race: 5, long_straight: 2 },
        successText: "咬住前排影子，节奏贴得很舒服",
        failText: "跟得有点犹豫，没贴到最好的位置"
    },
    pace: {
        primary: "staminaAttr",
        secondary: "focus",
        state: "stamina",
        stateWeight: 0.1,
        scene: { start: 2, mid: 8, finish: -8 },
        track: { endurance: 9, uphill_finish: 6, sand_track: 5, short_sprint: -8 },
        successText: "把一口气留了下来，后段更舒服",
        failText: "节奏压得太保守，位置没能守住"
    }
};
const CHECK_GRADE_EFFECTS = {
    critical: { label: "大成功", multiplier: 1.65, staminaCost: 0.7, rhythmPenalty: 0.65, stateBonus: 1.35 },
    hard: { label: "困难成功", multiplier: 1.28, staminaCost: 0.85, rhythmPenalty: 0.8, stateBonus: 1.15 },
    success: { label: "成功", multiplier: 1, staminaCost: 1, rhythmPenalty: 1, stateBonus: 1 },
    fail: { label: "失败", multiplier: 0.38, staminaCost: 1.12, rhythmPenalty: 1.2, stateBonus: 0.55 },
    fumble: { label: "大失败", multiplier: -0.45, staminaCost: 1.35, rhythmPenalty: 1.55, stateBonus: 0.25 }
};
const STRATEGY_DEFAULT_ACTIONS = {
    normal: "steady",
    steady: "steady",
    burst: "speed_up",
    conserve: "pace",
    inside: "inside"
};
const NPC_NAMES = [
    "晨间训练员",
    "栗色围巾",
    "弯道观察员",
    "终点裁判",
    "薄荷汽水",
    "夜樱看台",
    "红茶加冰",
    "星砂领航"
];
const NPC_UMA_PREFIXES = [
    "栗毛",
    "晨风",
    "青叶",
    "星砂",
    "白露",
    "红茶",
    "薄荷",
    "夜樱"
];
const NPC_UMA_SUFFIXES = [
    "流星",
    "疾驰",
    "弯道",
    "终线",
    "小步",
    "追光",
    "回响",
    "闪击"
];
const ATTRIBUTE_DEFS = [
    { key: "speed", label: "速度" },
    { key: "stamina", label: "耐力" },
    { key: "power", label: "爆发" },
    { key: "focus", label: "稳定" },
    { key: "wisdom", label: "判断" },
    { key: "luck", label: "运气" }
];
const ATTRIBUTE_TOTAL = 40;
const ATTRIBUTE_MAX = 50;
const ATTRIBUTE_MIN = 1;
const RACE_BALANCE_THRESHOLD = 15;
const RACE_BALANCE_RETAIN_RATE = 0.35;
const RACE_BALANCE_MIN_SELF_RATE = 0.7;
const TRACK_NUMERIC_PROFILES = {
    rain_mud: {
        distance: 1400,
        segments: [360, 560, 480],
        friction: 1.22,
        slope: [0.01, 0.02, 0.03],
        corner: [0.18, 0.28, 0.16],
        staminaCostRate: 1.14,
        rhythmDifficulty: 1.22,
        routeDifficulty: 10,
        speedCarry: 0.92
    },
    long_straight: {
        distance: 1600,
        segments: [420, 560, 620],
        friction: 0.96,
        slope: [0, 0, 0],
        corner: [0.04, 0.06, 0.02],
        staminaCostRate: 1,
        rhythmDifficulty: 0.9,
        routeDifficulty: -2,
        speedCarry: 1.08
    },
    many_corners: {
        distance: 1500,
        segments: [380, 540, 580],
        friction: 1.05,
        slope: [0, 0.02, 0.01],
        corner: [0.28, 0.42, 0.36],
        staminaCostRate: 1.04,
        rhythmDifficulty: 1.18,
        routeDifficulty: 9,
        speedCarry: 0.96
    },
    short_sprint: {
        distance: 1000,
        segments: [340, 330, 330],
        friction: 0.94,
        slope: [0, 0, 0],
        corner: [0.08, 0.1, 0.06],
        staminaCostRate: 0.88,
        rhythmDifficulty: 0.96,
        routeDifficulty: 0,
        speedCarry: 1.14
    },
    endurance: {
        distance: 2200,
        segments: [560, 840, 800],
        friction: 1.06,
        slope: [0.01, 0.02, 0.04],
        corner: [0.12, 0.16, 0.12],
        staminaCostRate: 1.2,
        rhythmDifficulty: 1,
        routeDifficulty: 1,
        speedCarry: 0.98
    },
    uphill_finish: {
        distance: 1600,
        segments: [420, 520, 660],
        friction: 1.08,
        slope: [0.01, 0.04, 0.18],
        corner: [0.1, 0.16, 0.08],
        staminaCostRate: 1.16,
        rhythmDifficulty: 1.05,
        routeDifficulty: 2,
        speedCarry: 0.98
    },
    downhill_corner: {
        distance: 1400,
        segments: [360, 520, 520],
        friction: 0.98,
        slope: [-0.04, -0.07, -0.02],
        corner: [0.2, 0.42, 0.28],
        staminaCostRate: 0.95,
        rhythmDifficulty: 1.2,
        routeDifficulty: 8,
        speedCarry: 1.04
    },
    sand_track: {
        distance: 1500,
        segments: [380, 560, 560],
        friction: 1.28,
        slope: [0.01, 0.02, 0.03],
        corner: [0.12, 0.18, 0.14],
        staminaCostRate: 1.22,
        rhythmDifficulty: 1.08,
        routeDifficulty: 6,
        speedCarry: 0.88
    },
    night_race: {
        distance: 1500,
        segments: [380, 560, 560],
        friction: 1,
        slope: [0, 0.01, 0.02],
        corner: [0.14, 0.22, 0.16],
        staminaCostRate: 1,
        rhythmDifficulty: 1.12,
        routeDifficulty: 7,
        speedCarry: 1
    }
};
const TWIST_NUMERIC_MODIFIERS = {
    "慢节奏": { speedCarry: -0.05, staminaCostRate: -0.06, finalSpeedCarry: 0.06 },
    "突然提速": { speedCarry: 0.08, staminaCostRate: 0.08, rhythmDifficulty: 0.08 },
    "位置混战": { routeDifficulty: 8, rhythmDifficulty: 0.1, corner: 0.04 },
    "外道顺风": { finalSpeedCarry: 0.1, routeDifficulty: -3 },
    "节奏很乱": { rhythmDifficulty: 0.14, routeDifficulty: 3 },
    "终点前逆风": { finalSpeedCarry: -0.12, staminaCostRate: 0.06 }
};
const SCENE_NUMERIC_MODIFIERS = {
    "大雨突袭": { friction: 0.1, staminaCostRate: 0.1, rhythmDifficulty: 0.15, routeDifficulty: 6 },
    "观众欢呼": { finalSpeedCarry: 0.08, variance: 6 },
    "起跑失误": { startSpeedCarry: -0.08, routeDifficulty: 5 },
    "最后弯道堵车": { finalRouteDifficulty: 8, corner: 0.05 }
};
const CONDITION_NUMERIC_MODIFIERS = {
    "维护良好": { friction: -0.03, rhythmDifficulty: -0.03, routeDifficulty: -2 },
    "干燥高速": { friction: -0.08, staminaCostRate: -0.05, speedCarry: 0.06 },
    "松软吃力": { friction: 0.12, staminaCostRate: 0.12, speedCarry: -0.05 },
    "湿滑难控": { friction: 0.08, rhythmDifficulty: 0.14, routeDifficulty: 6 },
    "硬地弹脚": { friction: -0.06, speedCarry: 0.08, rhythmDifficulty: 0.06, variance: 3 },
    "能见度差": { rhythmDifficulty: 0.12, routeDifficulty: 7, speedCarry: -0.03 }
};
const ATTRIBUTE_ALIASES = {
    speed: ["速度", "速"],
    stamina: ["耐力", "体力"],
    power: ["爆发", "力量", "冲刺"],
    focus: ["稳定", "稳"],
    wisdom: ["判断", "智力", "策略"],
    luck: ["运气", "幸运"]
};
const AFFIX_QUALITIES = {
    cursed: { label: "诅咒", weight: 1, effect: -5 },
    broken: { label: "破损", weight: 7, effect: -2 },
    common: { label: "普通", weight: 40, effect: 1 },
    good: { label: "优秀", weight: 28, effect: 2 },
    rare: { label: "稀有", weight: 16, effect: 3 },
    epic: { label: "史诗", weight: 7, effect: 4 },
    shiny: { label: "闪耀", weight: 1, effect: 5 }
};
const AFFIX_REROLL_COSTS = {
    cursed: 5,
    broken: 3,
    common: 1,
    good: 3,
    rare: 5,
    epic: 7,
    shiny: 10
};
const AFFIX_DIRECTION_LABELS = {
    speed: "速度",
    stamina: "耐力",
    power: "爆发",
    focus: "稳定",
    wisdom: "判断",
    luck: "运气",
    universal: "通用"
};
const ACTION_AFFIX_DIRECTIONS = {
    speed_up: ["speed"],
    slow_down: ["stamina", "focus"],
    steady: ["focus"],
    inside: ["wisdom"],
    burst: ["power", "speed"],
    gamble: ["luck"],
    follow: ["wisdom", "focus"],
    pace: ["stamina", "focus"]
};
function makeAffixEntries(quality, pairs) {
    return pairs.map(([label, tags, mechanic = ""], index) => ({
        id: `${quality}_${index + 1}`,
        label,
        quality,
        tags,
        mechanic
    }));
}
const AFFIX_POOL = [
    ...makeAffixEntries("broken", [
        ["慢半拍的", ["speed"]], ["虚胖的", ["stamina"]], ["空挥的", ["power"]], ["走神的", ["focus"]], ["迷路的", ["wisdom"]],
        ["倒霉的", ["luck"]], ["拖沓的", ["speed"]], ["漏气的", ["stamina"]], ["软脚的", ["power"]], ["晃神的", ["focus"]],
        ["看错线的", ["wisdom"]], ["手黑的", ["luck"]], ["半吊子的", ["universal"]], ["起步犯困的", ["speed", "focus"]],
        ["后劲发虚的", ["stamina", "power"]], ["内道迷糊的", ["wisdom"]], ["冲刺打滑的", ["power"]], ["节奏掉线的", ["focus"]],
        ["玄学失灵的", ["luck"]], ["今天不在状态的", ["universal"]]
    ]),
    ...makeAffixEntries("cursed", [
        ["被风嫌弃的", ["speed"]], ["肺活量告急的", ["stamina"]], ["爆发过期的", ["power"]], ["心态飘走的", ["focus"]], ["路线诅咒的", ["wisdom"]],
        ["非酋认证的", ["luck"], "downgrade_first_critical"], ["开闸梦游的", ["speed"]], ["上坡想回家的", ["stamina"]], ["终点脚软的", ["power"]], ["乱战发呆的", ["focus"]],
        ["弯道撞墙脑的", ["wisdom"]], ["骰神拉黑的", ["luck"]], ["被草地讨厌的", ["universal"]], ["越跑越困的", ["stamina", "focus"]],
        ["一冲就散的", ["speed", "power"]], ["内外都堵的", ["wisdom"]], ["末脚欠费的", ["power"]], ["节奏反着来的", ["focus"]],
        ["好运绝缘体", ["luck"], "downgrade_first_critical"], ["马场笑话", ["universal"], "bad_luck_echo"]
    ]),
    ...makeAffixEntries("common", [
        ["轻快的", ["speed"]], ["耐跑的", ["stamina"]], ["发力顺的", ["power"]], ["稳心的", ["focus"]], ["识路的", ["wisdom"]],
        ["有运的", ["luck"]], ["慢热的", ["stamina", "power"]], ["抢线的", ["wisdom"]], ["外道派", ["speed", "wisdom"]], ["内道派", ["wisdom", "focus"]],
        ["直线感好的", ["speed"]], ["雨天不慌的", ["focus", "stamina"]], ["上坡能顶的", ["stamina", "power"]], ["开局快的", ["speed"]],
        ["末段稳的", ["stamina", "focus"]], ["节奏好的", ["focus"]], ["敢拼的", ["power", "luck"]], ["贴跑的", ["wisdom", "focus"]],
        ["冷静的", ["focus", "wisdom"]], ["顺风的", ["luck", "speed"]]
    ]),
    ...makeAffixEntries("good", [
        ["迅捷的", ["speed"]], ["长息的", ["stamina"]], ["锋利的", ["power"]], ["沉稳的", ["focus"]], ["机敏的", ["wisdom"]],
        ["受眷的", ["luck"]], ["弯道巧手", ["wisdom", "focus"]], ["直线追风", ["speed"]], ["泥地稳步", ["stamina", "focus"]], ["上坡硬撑", ["stamina", "power"]],
        ["末脚清亮", ["power"]], ["开闸灵敏", ["speed", "focus"]], ["节奏掌控", ["focus"]], ["贴身跟跑", ["wisdom", "focus"]],
        ["外道借风", ["speed", "luck"]], ["内线穿梭", ["wisdom"]], ["乱战不慌", ["focus", "wisdom"]], ["后程蓄势", ["stamina", "power"]],
        ["短途压迫", ["speed", "power"]], ["好运连珠", ["luck"]]
    ]),
    ...makeAffixEntries("rare", [
        ["疾风步", ["speed"]], ["长距离心肺", ["stamina"]], ["破风末脚", ["power"]], ["静默节奏", ["focus"]], ["路线预读", ["wisdom"]],
        ["幸运星", ["luck"]], ["弯道猎手", ["wisdom", "focus"]], ["直线推进", ["speed"]], ["雨战专家", ["stamina", "focus"]], ["坡道强袭", ["stamina", "power"]],
        ["终点嗅觉", ["power", "luck"]], ["起步弹射", ["speed"]], ["乱流掌控", ["focus", "wisdom"]], ["贴影跟跑", ["wisdom", "focus"]],
        ["外道突围", ["speed", "luck"]], ["内道切入", ["wisdom"]], ["泥地适应", ["stamina"]], ["后程压迫", ["stamina", "power"]],
        ["短途尖刀", ["speed", "power"]], ["命运偏爱", ["luck"]]
    ]),
    ...makeAffixEntries("epic", [
        ["疾驰本能", ["speed"]], ["不沉之息", ["stamina"]], ["终末锋刃", ["power"]], ["绝对专注", ["focus"]], ["赛道解构", ["wisdom"]],
        ["天命偏转", ["luck"], "reroll_fumble"], ["弯道支配", ["wisdom", "focus"], "route_surge"], ["直线风压", ["speed"], "extra_push"], ["雨幕穿行", ["stamina", "focus"], "stamina_guard"], ["坡道逆袭", ["stamina", "power"], "extra_push"],
        ["终点猎杀", ["power", "luck"], "finish_burst"], ["开闸爆冲", ["speed", "power"], "extra_push"], ["乱战核心", ["focus", "wisdom"], "route_surge"], ["影子跑法", ["wisdom", "focus"], "route_surge"],
        ["外道风暴", ["speed", "luck"], "extra_push"], ["内线手术刀", ["wisdom"], "route_surge"], ["泥地王者", ["stamina"], "stamina_guard"], ["后程统治", ["stamina", "power"], "finish_burst"],
        ["短途压制", ["speed", "power"], "extra_push"], ["幸运暴击", ["luck"], "advantage_roll"]
    ]),
    ...makeAffixEntries("shiny", [
        ["流星步", ["speed"], "extra_push"], ["不灭长息", ["stamina"], "stamina_guard"], ["黄金末脚", ["power"], "finish_burst"], ["无尘心境", ["focus"], "soften_failure"], ["全局预读", ["wisdom"], "route_surge"],
        ["天眷之马", ["luck"], "advantage_roll"], ["弯月支配者", ["wisdom", "focus"], "route_surge"], ["白线尽头", ["speed"], "extra_push"], ["雨中花火", ["stamina", "focus"], "stamina_guard"], ["登坡王冠", ["stamina", "power"], "finish_burst"],
        ["终点裁决", ["power", "luck"], "finish_burst"], ["开局雷鸣", ["speed", "power"], "extra_push"], ["乱战皇帝", ["focus", "wisdom"], "route_surge"], ["影中追光", ["wisdom", "focus"], "route_surge"],
        ["外道彗星", ["speed", "luck"], "extra_push"], ["内线奇迹", ["wisdom"], "route_surge"], ["泥冠加冕", ["stamina"], "stamina_guard"], ["后程君主", ["stamina", "power"], "finish_burst"],
        ["短途王冠", ["speed", "power"], "extra_push"], ["命运改写", ["luck"], "reroll_fumble"]
    ])
];
const TRAINING_TYPES = {
    basic: {
        label: "基础训练",
        aliases: ["基础", "普通", "基础训练"],
        cost: 2,
        baseRate: 0.9,
        decay: 0.008,
        minRate: 0.55,
        gain: 1,
        maxTargetValue: 19,
        pity: 3,
        failPenaltyCount: 1,
        failPenaltyChance: 0.25
    },
    hard: {
        label: "强化训练",
        aliases: ["强化", "强训", "强化训练"],
        cost: 5,
        baseRate: 0.75,
        decay: 0.01,
        minRate: 0.35,
        gain: 3,
        pity: 4,
        failPenaltyCount: 1,
        failPenaltyChance: 0.6
    },
    gamble: {
        label: "赌狗训练",
        aliases: ["赌狗", "赌博", "赌", "搏一把", "赌狗训练"],
        cost: 8,
        baseRate: 0.5,
        decay: 0.0064,
        minRate: 0.18,
        gain: 5,
        critGain: 7,
        critRate: 0.2,
        pity: 5,
        failPenaltyCount: 3,
        failPenaltyChance: 1,
        failTargetPenaltyChance: 0.45
    }
};
const PERSONALITY_ATTRIBUTE_RULES = [
    { pattern: /温柔|体贴|照顾|可靠|沉稳|稳重|安静|冷静|害羞|内向/, add: { focus: 3, wisdom: 2, stamina: 1 } },
    { pattern: /活泼|元气|开朗|外向|吵闹|调皮|快乐|阳光/, add: { speed: 3, luck: 2, power: 1 } },
    { pattern: /不服输|热血|胜负欲|骄傲|倔强|拼命|冲动|莽|强势/, add: { power: 4, speed: 2 } },
    { pattern: /聪明|机灵|冷静|理性|策略|观察|判断|腹黑|狡猾/, add: { wisdom: 4, focus: 2 } },
    { pattern: /耐心|坚韧|努力|认真|持久|长跑|能忍|执着/, add: { stamina: 4, focus: 2 } },
    { pattern: /幸运|随缘|玄学|天选|欧皇|奇迹/, add: { luck: 5, speed: 1 } },
    { pattern: /自由|飘忽|神秘|浪漫|梦幻|天然|迷糊/, add: { luck: 3, wisdom: 2, speed: 1 } },
    { pattern: /优雅|高贵|大小姐|端庄|自信|从容/, add: { wisdom: 3, focus: 2, power: 1 } }
];
const PERSONALITY_TRAITS = [
    {
        key: "gentle",
        label: "温柔可靠",
        pattern: /温柔|体贴|照顾|可靠|沉稳|稳重|安静|害羞|内向/,
        fit: { steady: 5, conserve: 3, burst: -2 },
        tagFit: { adverse: 3, wet: 2, night: 2, chaotic: 1, sprint: -2, pace_fast: -1 },
        description: "复杂赛况下更稳，保守策略更容易发挥。"
    },
    {
        key: "competitive",
        label: "不服输",
        pattern: /不服输|热血|胜负欲|骄傲|倔强|拼命|冲动|莽|强势/,
        fit: { burst: 6, inside: 2, conserve: -3 },
        tagFit: { straight: 3, uphill: 3, sprint: 2, long: -2, adverse: -2, wet: -1, pace_slow: -1 },
        riskAdjust: 0.04,
        description: "冲刺和对抗更强，但激进策略更容易出风险。"
    },
    {
        key: "calm",
        label: "冷静策略",
        pattern: /聪明|机灵|冷静|理性|策略|观察|判断|腹黑|狡猾/,
        fit: { steady: 4, normal: 4, inside: 2 },
        tagFit: { corner: 3, downhill: 2, night: 2, crowded: 2, chaotic: 2, sprint: -1, cheering: -2 },
        description: "复杂路线和变化节奏里更容易做出正确判断。"
    },
    {
        key: "patient",
        label: "耐心坚韧",
        pattern: /耐心|坚韧|努力|认真|持久|长跑|能忍|执着/,
        fit: { conserve: 6, steady: 3, burst: -2 },
        tagFit: { long: 4, uphill: 3, sand: 3, adverse: 2, headwind: 2, sprint: -3, pace_fast: -2 },
        description: "长距离、重场地和后半段更有优势。"
    },
    {
        key: "lucky",
        label: "天然幸运",
        pattern: /幸运|随缘|玄学|天选|欧皇|奇迹|自由|飘忽|神秘|浪漫|梦幻|天然|迷糊/,
        fit: { normal: 3, burst: 2, inside: 1 },
        tagFit: { sprint: 2, cheering: 2, chaotic: 2, pace_fast: 1, technical: -2, crowded: -1, headwind: -1 },
        varianceBonus: 8,
        luckBonus: 8,
        description: "随机波动更大，运气好的时候能突然翻盘。"
    },
    {
        key: "elegant",
        label: "优雅从容",
        pattern: /优雅|高贵|大小姐|端庄|自信|从容/,
        fit: { normal: 4, steady: 3, inside: 2 },
        tagFit: { night: 3, straight: 2, tailwind: 2, pace_slow: 1, mud: -2, sand: -2, chaotic: -1 },
        description: "节奏稳定，越是需要姿态和判断的赛况越舒服。"
    }
];
const STRATEGIES = {
    normal: {
        label: "正常跑",
        aliases: ["默认", "均衡", "正常", "随便", "普通"],
        description: "没有短板，什么赛道都能跑",
        event: "{name} 选择正常跑，节奏很均衡，没有急着把体力交出去。",
        weights: { speed: 0.35, stamina: 0.28, focus: 0.22, luck: 0.15 },
        variance: 14,
        risk: 0.04
    },
    steady: {
        label: "稳一点",
        aliases: ["稳", "稳一点", "保守", "别浪", "稳住"],
        description: "失误少，雨天、泥地、弯道多时更舒服",
        event: "{name} 选择稳一点，前半程没有硬冲，复杂赛道反而处理得很干净。",
        weights: { speed: 0.24, stamina: 0.30, focus: 0.34, luck: 0.12 },
        variance: 8,
        risk: 0.01
    },
    burst: {
        label: "拼一把",
        aliases: ["拼", "拼一把", "冲", "赌", "莽", "全力"],
        description: "上限高，短距离和长直线更强，但可能失误",
        event: "{name} 选择拼一把，起步就把速度拉满，场面一下子紧张起来。",
        weights: { speed: 0.48, stamina: 0.18, focus: 0.14, luck: 0.20 },
        variance: 24,
        risk: 0.13
    },
    conserve: {
        label: "留体力",
        aliases: ["留体力", "后劲", "省体力", "耐力", "苟住"],
        description: "前半段不抢，长距离和最后直线更容易追回来",
        event: "{name} 选择留体力，前面看起来不急，最后直线才开始慢慢咬上来。",
        weights: { speed: 0.24, stamina: 0.42, focus: 0.20, luck: 0.14 },
        variance: 12,
        risk: 0.05
    },
    inside: {
        label: "抢内道",
        aliases: ["抢内道", "内道", "贴内", "卡位", "抢位"],
        description: "起跑和弯道有优势，人多时容易被堵",
        event: "{name} 选择抢内道，开局直接往里切，位置抢得很凶。",
        weights: { speed: 0.34, stamina: 0.22, focus: 0.30, luck: 0.14 },
        variance: 18,
        risk: 0.08
    }
};
const TRACKS = [
    {
        id: "rain_mud",
        name: "雨天泥地",
        description: "路面很滑，稳住比硬冲更重要。",
        tags: ["adverse", "wet", "mud", "corner"],
        fit: { steady: 14, conserve: 4, burst: -10, inside: -4 },
        weights: { speed: 0.26, stamina: 0.28, focus: 0.34, luck: 0.12 },
        events: [
            "{name} 过弯时压住了节奏，没有被湿滑路面带偏。",
            "{name} 起步很凶，但泥地反作用太大，节奏被迫慢了一拍。",
            "{name} 在雨里一路贴住前排，最后才开始往外拉。"
        ]
    },
    {
        id: "long_straight",
        name: "长直线",
        description: "终点前有很长一段冲刺区，爆发力会被放大。",
        tags: ["straight", "long", "finish"],
        fit: { burst: 12, conserve: 7, steady: -2, inside: 2 },
        weights: { speed: 0.42, stamina: 0.22, focus: 0.18, luck: 0.18 },
        events: [
            "{name} 进最后直线后突然提速，身位开始一点点追回来。",
            "{name} 前面忍了很久，直线区终于把速度放出来了。",
            "{name} 冲刺很早，但后半段还能不能撑住就有点悬了。"
        ]
    },
    {
        id: "many_corners",
        name: "弯道很多",
        description: "卡位和节奏很关键，乱冲很容易损失速度。",
        tags: ["corner", "crowded", "technical"],
        fit: { steady: 8, inside: 11, burst: -7, conserve: 2 },
        weights: { speed: 0.28, stamina: 0.23, focus: 0.36, luck: 0.13 },
        events: [
            "{name} 在连续弯道里卡住了好位置，没给后面太多空间。",
            "{name} 过弯时被挤了一下，只能先收住速度。",
            "{name} 沿着内侧一路省距离，位置看起来很漂亮。"
        ]
    },
    {
        id: "short_sprint",
        name: "短距离冲刺",
        description: "没有太多调整时间，开局和爆发最重要。",
        tags: ["sprint", "pace_fast", "start"],
        fit: { burst: 13, inside: 6, conserve: -8, steady: -3 },
        weights: { speed: 0.48, stamina: 0.16, focus: 0.18, luck: 0.18 },
        events: [
            "{name} 出闸就开始抢速度，短途局面一下子被拉开。",
            "{name} 想留体力，但这局距离太短，能追回来的时间不多。",
            "{name} 在前半段就完成卡位，后面的人只能硬追。"
        ]
    },
    {
        id: "endurance",
        name: "耐力赛",
        description: "距离很长，前面太急的人可能会在后段掉速。",
        tags: ["long", "stamina", "pace_slow"],
        fit: { conserve: 14, steady: 5, burst: -9, inside: -1 },
        weights: { speed: 0.24, stamina: 0.44, focus: 0.20, luck: 0.12 },
        events: [
            "{name} 前半段不急不躁，后半程体力优势开始显出来。",
            "{name} 一开始冲得很猛，但长距离让体力消耗变得明显。",
            "{name} 一直咬在中段，等别人掉速才慢慢往前挤。"
        ]
    },
    {
        id: "uphill_finish",
        name: "上坡终点",
        description: "最后一段是明显上坡，耐力和爆发缺一不可。",
        tags: ["uphill", "finish", "adverse", "stamina"],
        fit: { conserve: 8, burst: 6, steady: 3, inside: -3 },
        weights: { speed: 0.28, stamina: 0.36, focus: 0.18, luck: 0.18 },
        events: [
            "{name} 进上坡后还在顶着往前压，后劲开始变得关键。",
            "{name} 提前冲上坡，速度很漂亮，但体力消耗也很明显。",
            "{name} 在坡道前留了一口气，最后几步反而越跑越稳。"
        ]
    },
    {
        id: "downhill_corner",
        name: "下坡弯道",
        description: "下坡接连续弯，速度容易起来，失误也会被放大。",
        tags: ["downhill", "corner", "technical", "pace_fast"],
        fit: { steady: 8, inside: 7, normal: 2, burst: -5 },
        weights: { speed: 0.32, stamina: 0.18, focus: 0.38, luck: 0.12 },
        events: [
            "{name} 下坡进弯时收得很准，没有被速度拖出路线。",
            "{name} 借下坡把速度带起来，但弯道里每一步都很考验控制。",
            "{name} 贴着内侧过弯，距离省得漂亮，位置也抢住了。"
        ]
    },
    {
        id: "sand_track",
        name: "沙地赛道",
        description: "脚下阻力很重，力量和耐力会比纯速度更重要。",
        tags: ["adverse", "sand", "stamina"],
        fit: { conserve: 8, steady: 5, burst: -4, inside: -5 },
        weights: { speed: 0.22, stamina: 0.34, focus: 0.26, luck: 0.18 },
        events: [
            "{name} 在沙地里步幅很稳，没有被厚重阻力拖散节奏。",
            "{name} 起步很快，但沙地吃力，后面能不能撑住还不好说。",
            "{name} 沿着较硬的路线往前挤，速度没有掉得太难看。"
        ]
    },
    {
        id: "night_race",
        name: "夜间赛",
        description: "视野和判断更重要，临场稳定性会被放大。",
        tags: ["night", "technical", "adverse"],
        fit: { steady: 7, normal: 5, inside: 2, burst: -3 },
        weights: { speed: 0.30, stamina: 0.22, focus: 0.32, luck: 0.16 },
        events: [
            "{name} 在夜色里判断路线很冷静，没有被前排动作带乱。",
            "{name} 借着灯光找到空档，一点点把位置挤了出来。",
            "{name} 夜间节奏有点微妙，但脚步还算稳。"
        ]
    }
];
const RACE_TWISTS = [
    {
        name: "慢节奏",
        description: "前半程没人愿意带速度，后半段才突然开始提速。",
        tags: ["pace_slow", "stamina"],
        fit: { conserve: 6, steady: 4, burst: -3, inside: -2, normal: 1 },
        event: "{name} 被慢节奏拖住了一会儿，最后才找到加速窗口。"
    },
    {
        name: "突然提速",
        description: "中段有人强行拉速度，比赛节奏被提前点燃。",
        tags: ["pace_fast", "chaotic"],
        fit: { burst: 8, inside: 4, conserve: -6, steady: -1, normal: 1 },
        event: "{name} 正好接住了中段提速，位置一下子变得有威胁。"
    },
    {
        name: "位置混战",
        description: "前排互相卡位，抢线和避让都变得更重要。",
        tags: ["crowded", "technical", "chaotic"],
        fit: { inside: 7, steady: 5, burst: -4, conserve: -2, normal: 0 },
        event: "{name} 在混战里一直找缝，几次差点被挤出路线。"
    },
    {
        name: "外道顺风",
        description: "外侧风向很好，后排和外侧冲刺更容易打开空间。",
        tags: ["tailwind", "straight", "finish"],
        fit: { burst: 5, conserve: 5, inside: -6, steady: 0, normal: 2 },
        event: "{name} 从外侧借到顺风，最后一段速度明显起来了。"
    },
    {
        name: "节奏很乱",
        description: "全程几次变速，稳定和运气都会被放大。",
        tags: ["chaotic", "technical", "adverse"],
        fit: { steady: 5, normal: 4, burst: -2, conserve: -2, inside: -1 },
        event: "{name} 在乱节奏里没有慌，几次变速都跟得还算稳。"
    },
    {
        name: "终点前逆风",
        description: "最后直线逆风明显，太早冲刺的人容易被反噬。",
        tags: ["headwind", "finish", "adverse"],
        fit: { steady: 5, conserve: 4, burst: -8, inside: 1, normal: 2 },
        event: "{name} 顶着逆风往前压，冲刺没有想象中那么轻松。"
    }
];
const RACE_SCENES = [
    {
        name: "大雨突袭",
        description: "比赛中突然下起大雨，稳定处理和保守节奏更吃香。",
        tags: ["adverse", "wet", "chaotic"],
        fit: { steady: 8, conserve: 4, normal: 1, burst: -7, inside: -3 },
        event: "{name} 顶着突然变大的雨势稳住步伐，没有被路面变化带乱。"
    },
    {
        name: "观众欢呼",
        description: "看台声浪很大，爆发和运气的波动都会变强。",
        tags: ["cheering", "chaotic"],
        fit: { burst: 7, normal: 3, inside: 2, steady: -1, conserve: -2 },
        event: "{name} 被看台声浪带起了气势，冲刺动作突然变得更果断。"
    },
    {
        name: "起跑失误",
        description: "起跑区出现小混乱，太激进的策略更容易吃亏。",
        tags: ["start", "chaotic", "crowded"],
        fit: { steady: 7, normal: 4, conserve: 2, burst: -8, inside: -5 },
        event: "{name} 起跑阶段被小混乱影响了一下，但很快把节奏找了回来。"
    },
    {
        name: "最后弯道堵车",
        description: "终点前的弯道挤成一团，抢内道可能大赚也可能被堵死。",
        tags: ["corner", "crowded", "finish", "technical"],
        fit: { inside: 5, steady: 4, burst: -4, conserve: -1, normal: 1 },
        event: "{name} 在最后弯道里找缝钻出，差一点就被前排完全堵住。"
    }
];
const RACE_CONDITIONS = [
    {
        name: "维护良好",
        description: "赛道状态很稳，路线和节奏都比较容易处理。",
        tags: ["balanced", "technical"],
        broadcast: "赛道维护得很干净，今天不太会偏袒某一种跑法，谁的节奏更完整，谁就更有机会。"
    },
    {
        name: "干燥高速",
        description: "地面干爽，速度容易带起来。",
        tags: ["dry", "speed", "pace_fast"],
        broadcast: "场地很干，速度会起得很快，前面敢不敢抢，后面能不能撑住，都会被放大。"
    },
    {
        name: "松软吃力",
        description: "脚下发沉，体力消耗会更明显。",
        tags: ["soft", "stamina", "adverse"],
        broadcast: "脚下不太给回弹，前面冲太狠，后面可能要还债。"
    },
    {
        name: "湿滑难控",
        description: "落脚不稳，稳定和判断更重要。",
        tags: ["wet", "slippery", "technical", "adverse"],
        broadcast: "落脚会有点滑，硬冲不一定讨好，能把节奏压住的人会更舒服。"
    },
    {
        name: "硬地弹脚",
        description: "回弹很足，提速快，但失误也更疼。",
        tags: ["hard", "speed", "risk"],
        broadcast: "硬地很弹，速度会给得很痛快，但一步踩乱，代价也会来得很快。"
    },
    {
        name: "能见度差",
        description: "视野受限，路线判断压力更大。",
        tags: ["low_visibility", "technical", "pressure", "adverse"],
        broadcast: "视野不太好，路线不会轻易摊开，谁能先看见机会，谁就能先动。"
    }
];
const CONDITION_EVENTS = [
    { min: 8, text: "{name} 今天状态很好，脚步明显比平时轻。" },
    { min: 4, text: "{name} 热身感觉不错，中段还多留了一点余力。" },
    { min: -3, text: "{name} 状态普通，基本按自己的节奏在跑。" },
    { min: -7, text: "{name} 今天状态有点紧，前半段没完全放开。" },
    { min: -99, text: "{name} 起跑前就有点不在状态，只能边跑边找感觉。" }
];
export { DEFAULT_CONFIG, RACE_SIZE, RACE_STAGES, RACE_ACTIONS, PROFICIENCY_MAX, PROFICIENCY_SINGLE_ACTION_CAP, PROFICIENCY_TOTAL_RACE_CAP, PROFICIENCY_REPEAT_GAINS, PROFICIENCY_CHECK_GAINS, PROFICIENCY_LEVELS, ACTION_CHECKS, CHECK_GRADE_EFFECTS, STRATEGY_DEFAULT_ACTIONS, NPC_NAMES, NPC_UMA_PREFIXES, NPC_UMA_SUFFIXES, ATTRIBUTE_DEFS, ATTRIBUTE_TOTAL, ATTRIBUTE_MAX, ATTRIBUTE_MIN, RACE_BALANCE_THRESHOLD, RACE_BALANCE_RETAIN_RATE, RACE_BALANCE_MIN_SELF_RATE, TRACK_NUMERIC_PROFILES, TWIST_NUMERIC_MODIFIERS, SCENE_NUMERIC_MODIFIERS, CONDITION_NUMERIC_MODIFIERS, ATTRIBUTE_ALIASES, AFFIX_QUALITIES, AFFIX_REROLL_COSTS, AFFIX_DIRECTION_LABELS, ACTION_AFFIX_DIRECTIONS, AFFIX_POOL, TRAINING_TYPES, PERSONALITY_ATTRIBUTE_RULES, PERSONALITY_TRAITS, STRATEGIES, TRACKS, RACE_TWISTS, RACE_SCENES, RACE_CONDITIONS, CONDITION_EVENTS };
//# sourceMappingURL=umaConstants.js.map