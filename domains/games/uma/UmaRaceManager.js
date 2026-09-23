import fs from "fs"
import path from "path"
import yaml from "js-yaml"
import { sendSmartReply } from "../../../utils/SmartReply.js"

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
}

const RACE_SIZE = 8

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
]

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
}

const PROFICIENCY_MAX = 1000
const PROFICIENCY_SINGLE_ACTION_CAP = 10
const PROFICIENCY_TOTAL_RACE_CAP = 16
const PROFICIENCY_REPEAT_GAINS = [2, 3, 4]
const PROFICIENCY_CHECK_GAINS = {
  critical: 2,
  hard: 1,
  success: 0,
  fail: 0,
  fumble: 1
}
const PROFICIENCY_LEVELS = [
  { min: 800, label: "专长", bonus: 4 },
  { min: 500, label: "精通", bonus: 3 },
  { min: 250, label: "熟练", bonus: 2 },
  { min: 100, label: "入门", bonus: 1 },
  { min: 0, label: "生疏", bonus: 0 }
]

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
}

const CHECK_GRADE_EFFECTS = {
  critical: { label: "大成功", multiplier: 1.65, staminaCost: 0.7, rhythmPenalty: 0.65, stateBonus: 1.35 },
  hard: { label: "困难成功", multiplier: 1.28, staminaCost: 0.85, rhythmPenalty: 0.8, stateBonus: 1.15 },
  success: { label: "成功", multiplier: 1, staminaCost: 1, rhythmPenalty: 1, stateBonus: 1 },
  fail: { label: "失败", multiplier: 0.38, staminaCost: 1.12, rhythmPenalty: 1.2, stateBonus: 0.55 },
  fumble: { label: "大失败", multiplier: -0.45, staminaCost: 1.35, rhythmPenalty: 1.55, stateBonus: 0.25 }
}

const STRATEGY_DEFAULT_ACTIONS = {
  normal: "steady",
  steady: "steady",
  burst: "speed_up",
  conserve: "pace",
  inside: "inside"
}

const NPC_NAMES = [
  "晨间训练员",
  "栗色围巾",
  "弯道观察员",
  "终点裁判",
  "薄荷汽水",
  "夜樱看台",
  "红茶加冰",
  "星砂领航"
]

const NPC_UMA_PREFIXES = [
  "栗毛",
  "晨风",
  "青叶",
  "星砂",
  "白露",
  "红茶",
  "薄荷",
  "夜樱"
]

const NPC_UMA_SUFFIXES = [
  "流星",
  "疾驰",
  "弯道",
  "终线",
  "小步",
  "追光",
  "回响",
  "闪击"
]

const ATTRIBUTE_DEFS = [
  { key: "speed", label: "速度" },
  { key: "stamina", label: "耐力" },
  { key: "power", label: "爆发" },
  { key: "focus", label: "稳定" },
  { key: "wisdom", label: "判断" },
  { key: "luck", label: "运气" }
]

const ATTRIBUTE_TOTAL = 40
const ATTRIBUTE_MAX = 50
const ATTRIBUTE_MIN = 1
const RACE_BALANCE_THRESHOLD = 15
const RACE_BALANCE_RETAIN_RATE = 0.35
const RACE_BALANCE_MIN_SELF_RATE = 0.7

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
}

const TWIST_NUMERIC_MODIFIERS = {
  "慢节奏": { speedCarry: -0.05, staminaCostRate: -0.06, finalSpeedCarry: 0.06 },
  "突然提速": { speedCarry: 0.08, staminaCostRate: 0.08, rhythmDifficulty: 0.08 },
  "位置混战": { routeDifficulty: 8, rhythmDifficulty: 0.1, corner: 0.04 },
  "外道顺风": { finalSpeedCarry: 0.1, routeDifficulty: -3 },
  "节奏很乱": { rhythmDifficulty: 0.14, routeDifficulty: 3 },
  "终点前逆风": { finalSpeedCarry: -0.12, staminaCostRate: 0.06 }
}

const SCENE_NUMERIC_MODIFIERS = {
  "大雨突袭": { friction: 0.1, staminaCostRate: 0.1, rhythmDifficulty: 0.15, routeDifficulty: 6 },
  "观众欢呼": { finalSpeedCarry: 0.08, variance: 6 },
  "起跑失误": { startSpeedCarry: -0.08, routeDifficulty: 5 },
  "最后弯道堵车": { finalRouteDifficulty: 8, corner: 0.05 }
}

const CONDITION_NUMERIC_MODIFIERS = {
  "维护良好": { friction: -0.03, rhythmDifficulty: -0.03, routeDifficulty: -2 },
  "干燥高速": { friction: -0.08, staminaCostRate: -0.05, speedCarry: 0.06 },
  "松软吃力": { friction: 0.12, staminaCostRate: 0.12, speedCarry: -0.05 },
  "湿滑难控": { friction: 0.08, rhythmDifficulty: 0.14, routeDifficulty: 6 },
  "硬地弹脚": { friction: -0.06, speedCarry: 0.08, rhythmDifficulty: 0.06, variance: 3 },
  "能见度差": { rhythmDifficulty: 0.12, routeDifficulty: 7, speedCarry: -0.03 }
}

const ATTRIBUTE_ALIASES = {
  speed: ["速度", "速"],
  stamina: ["耐力", "体力"],
  power: ["爆发", "力量", "冲刺"],
  focus: ["稳定", "稳"],
  wisdom: ["判断", "智力", "策略"],
  luck: ["运气", "幸运"]
}

const AFFIX_QUALITIES = {
  cursed: { label: "诅咒", weight: 1, effect: -5 },
  broken: { label: "破损", weight: 7, effect: -2 },
  common: { label: "普通", weight: 40, effect: 1 },
  good: { label: "优秀", weight: 28, effect: 2 },
  rare: { label: "稀有", weight: 16, effect: 3 },
  epic: { label: "史诗", weight: 7, effect: 4 },
  shiny: { label: "闪耀", weight: 1, effect: 5 }
}

const AFFIX_REROLL_COSTS = {
  cursed: 5,
  broken: 3,
  common: 1,
  good: 3,
  rare: 5,
  epic: 7,
  shiny: 10
}

const AFFIX_DIRECTION_LABELS = {
  speed: "速度",
  stamina: "耐力",
  power: "爆发",
  focus: "稳定",
  wisdom: "判断",
  luck: "运气",
  universal: "通用"
}

const ACTION_AFFIX_DIRECTIONS = {
  speed_up: ["speed"],
  slow_down: ["stamina", "focus"],
  steady: ["focus"],
  inside: ["wisdom"],
  burst: ["power", "speed"],
  gamble: ["luck"],
  follow: ["wisdom", "focus"],
  pace: ["stamina", "focus"]
}

function makeAffixEntries(quality, pairs) {
  return pairs.map(([label, tags, mechanic = null], index) => ({
    id: `${quality}_${index + 1}`,
    label,
    quality,
    tags,
    mechanic
  }))
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
]

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
}

const PERSONALITY_ATTRIBUTE_RULES = [
  { pattern: /温柔|体贴|照顾|可靠|沉稳|稳重|安静|冷静|害羞|内向/, add: { focus: 3, wisdom: 2, stamina: 1 } },
  { pattern: /活泼|元气|开朗|外向|吵闹|调皮|快乐|阳光/, add: { speed: 3, luck: 2, power: 1 } },
  { pattern: /不服输|热血|胜负欲|骄傲|倔强|拼命|冲动|莽|强势/, add: { power: 4, speed: 2 } },
  { pattern: /聪明|机灵|冷静|理性|策略|观察|判断|腹黑|狡猾/, add: { wisdom: 4, focus: 2 } },
  { pattern: /耐心|坚韧|努力|认真|持久|长跑|能忍|执着/, add: { stamina: 4, focus: 2 } },
  { pattern: /幸运|随缘|玄学|天选|欧皇|奇迹/, add: { luck: 5, speed: 1 } },
  { pattern: /自由|飘忽|神秘|浪漫|梦幻|天然|迷糊/, add: { luck: 3, wisdom: 2, speed: 1 } },
  { pattern: /优雅|高贵|大小姐|端庄|自信|从容/, add: { wisdom: 3, focus: 2, power: 1 } }
]

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
]

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
}

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
]

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
]

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
]

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
]

const CONDITION_EVENTS = [
  { min: 8, text: "{name} 今天状态很好，脚步明显比平时轻。" },
  { min: 4, text: "{name} 热身感觉不错，中段还多留了一点余力。" },
  { min: -3, text: "{name} 状态普通，基本按自己的节奏在跑。" },
  { min: -7, text: "{name} 今天状态有点紧，前半段没完全放开。" },
  { min: -99, text: "{name} 起跑前就有点不在状态，只能边跑边找感觉。" }
]

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safeNumber(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function escapeName(name) {
  return String(name || "群友").replace(/\s+/g, " ").trim().slice(0, 24) || "群友"
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)]
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min)
}

function randomInt(min, max) {
  return Math.floor(randomBetween(min, max + 1))
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0))
}

function formatDuration(seconds) {
  return `${Math.max(1, Math.round(seconds))} 秒`
}

function hashString(text = "") {
  let hash = 2166136261
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = Math.imul(state + 0x6D2B79F5, 0x85EBCA6B) >>> 0
    state ^= state >>> 13
    state = Math.imul(state, 0xC2B2AE35) >>> 0
    return ((state ^ (state >>> 16)) >>> 0) / 4294967296
  }
}

export class UmaRaceManager {
  constructor({ cwd = process.cwd(), logger = globalThis.logger } = {}) {
    this.cwd = cwd
    this.logger = logger
    this.rooms = new Map()
    this.lastRaceAt = new Map()
    this.writeChain = Promise.resolve()
  }

  getConfig() {
    const userPath = path.join(this.cwd, "plugins/shiloh-plugin/config/message.yaml")
    const defaultPath = path.join(this.cwd, "plugins/shiloh-plugin/config_default/message.yaml")
    const configPath = fs.existsSync(userPath) ? userPath : defaultPath
    let raw = {}
    try {
      raw = yaml.load(fs.readFileSync(configPath, "utf8"))?.pluginSettings?.umaRace || {}
    } catch (error) {
      this.logger?.warn?.(`[赛马娘小游戏] 读取配置失败: ${error.message}`)
    }
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      minPlayers: RACE_SIZE,
      maxPlayers: RACE_SIZE,
      lobbySeconds: safeNumber(raw.lobbySeconds, DEFAULT_CONFIG.lobbySeconds, 10, 300),
      raceStageSeconds: safeNumber(raw.raceStageSeconds, DEFAULT_CONFIG.raceStageSeconds, 10, 180),
      cooldownSeconds: safeNumber(raw.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds, 0, 3600),
      winPoints: safeNumber(raw.winPoints, DEFAULT_CONFIG.winPoints, 0, 100000),
      secondPoints: safeNumber(raw.secondPoints, DEFAULT_CONFIG.secondPoints, 0, 100000),
      thirdPoints: safeNumber(raw.thirdPoints, DEFAULT_CONFIG.thirdPoints, 0, 100000),
      participationPoints: safeNumber(raw.participationPoints, DEFAULT_CONFIG.participationPoints, 0, 100000),
      rankLimit: safeNumber(raw.rankLimit, DEFAULT_CONFIG.rankLimit, 3, 50)
    }
  }

  getDataDir(config = this.getConfig()) {
    return path.isAbsolute(config.baseDir)
      ? config.baseDir
      : path.join(this.cwd, "plugins/shiloh-plugin", config.baseDir)
  }

  getPointsPath(config = this.getConfig()) {
    return path.join(this.getDataDir(config), "points.json")
  }

  readPoints(config = this.getConfig()) {
    const file = this.getPointsPath(config)
    if (!fs.existsSync(file)) return { players: {} }
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"))
      return data && typeof data === "object" && data.players ? data : { players: {} }
    } catch (error) {
      this.logger?.warn?.(`[赛马娘小游戏] 读取积分失败: ${error.message}`)
      return { players: {} }
    }
  }

  async writePoints(data, config = this.getConfig()) {
    this.writeChain = this.writeChain.then(async () => {
      const file = this.getPointsPath(config)
      ensureDir(path.dirname(file))
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
      fs.renameSync(tmp, file)
    })
    return this.writeChain
  }

  getUserId(e) {
    return String(e?.user_id || e?.sender?.user_id || "")
  }

  getPlayerRecord(userId, config = this.getConfig()) {
    if (!userId) return null
    const data = this.readPoints(config)
    return data.players?.[String(userId)] || null
  }

  getPlayerUma(userId, config = this.getConfig()) {
    const record = this.getPlayerRecord(userId, config)
    return record?.uma && this.isValidAttributes(record.uma.attributes) ? record.uma : null
  }

  async ensurePlayerUmaTrait(userId, config = this.getConfig()) {
    if (!userId) return null
    const data = this.readPoints(config)
    const record = data.players?.[String(userId)]
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) return null
    const previousKey = uma.trait?.key
    const trait = this.normalizeUmaTrait(uma)
    if (uma.trait?.key !== previousKey) {
      record.updatedAt = nowIso()
      data.players[String(userId)] = record
      await this.writePoints(data, config)
    }
    return { uma, trait }
  }

  isValidAttributes(attributes = {}) {
    return ATTRIBUTE_DEFS.every(def => Number.isFinite(Number(attributes[def.key])))
  }

  parseAdoptionInput(msg = "") {
    const text = String(msg || "")
      .replace(/^[.。]赛马娘\s*(重新领养|领养|创建|注册)\s*/u, "")
      .trim()
    if (!text) return null
    const [name = "", ...rest] = text.split(/\s+/)
    const personality = rest.join(" ").trim()
    return {
      name: escapeName(name).slice(0, 12),
      personality: personality.slice(0, 120)
    }
  }

  buildAttributeScores(personality = "") {
    const scores = Object.fromEntries(ATTRIBUTE_DEFS.map(def => [def.key, 1]))
    for (const rule of PERSONALITY_ATTRIBUTE_RULES) {
      if (!rule.pattern.test(personality)) continue
      for (const [key, value] of Object.entries(rule.add || {})) {
        scores[key] = (scores[key] || 1) + value
      }
    }
    return scores
  }

  generateAttributes(name = "", personality = "", total = ATTRIBUTE_TOTAL) {
    const targetTotal = this.normalizeAttributeTargetTotal(total)
    const base = Object.fromEntries(ATTRIBUTE_DEFS.map(def => [def.key, 4]))
    const extraPoints = targetTotal - ATTRIBUTE_DEFS.length * 4
    let remaining = extraPoints
    const scores = this.buildAttributeScores(`${name} ${personality}`)
    const totalScore = ATTRIBUTE_DEFS.reduce((sum, def) => sum + (scores[def.key] || 1), 0)
    const fractional = []

    for (const def of ATTRIBUTE_DEFS) {
      const exact = extraPoints * (scores[def.key] || 1) / totalScore
      const add = Math.floor(exact)
      base[def.key] += add
      fractional.push({ key: def.key, rest: exact - add })
      remaining -= add
    }

    const random = seededRandom(hashString(`${name}|${personality}`))
    fractional.sort((a, b) => b.rest - a.rest || random() - 0.5)
    for (let index = 0; index < remaining; index++) {
      base[fractional[index % fractional.length].key] += 1
    }

    this.normalizeAttributeTotal(base, targetTotal)
    return base
  }

  inferPersonalityTrait(name = "", personality = "") {
    const text = `${name} ${personality}`
    return PERSONALITY_TRAITS.find(trait => trait.pattern.test(text)) || {
      key: "balanced",
      label: "均衡适应",
      fit: { normal: 3, steady: 1, conserve: 1, burst: 1, inside: 1 },
      tagFit: { adverse: 2, technical: 1, sprint: -1, cheering: -1 },
      description: "没有明显偏科，什么场景都能按自己的节奏跑。"
    }
  }

  normalizeUmaTrait(uma = {}) {
    const trait = this.inferPersonalityTrait(uma.name, uma.personality)
    if (!uma.trait || uma.trait.key !== trait.key) {
      uma.trait = {
        key: trait.key,
        label: trait.label,
        description: trait.description
      }
    }
    return trait
  }

  normalizeAttributeTargetTotal(total) {
    const minTotal = ATTRIBUTE_DEFS.length * 4
    const value = Math.round(Number(total) || ATTRIBUTE_TOTAL)
    return Math.max(minTotal, value)
  }

  normalizeAttributeTotal(attributes, targetTotal = ATTRIBUTE_TOTAL) {
    targetTotal = this.normalizeAttributeTargetTotal(targetTotal)
    let total = this.sumAttributes(attributes)
    const order = [...ATTRIBUTE_DEFS].sort((a, b) => Number(attributes[b.key]) - Number(attributes[a.key]))
    while (total > targetTotal) {
      const target = order.find(def => attributes[def.key] > 1)
      if (!target) break
      attributes[target.key] -= 1
      total--
    }
    let addIndex = 0
    while (total < targetTotal) {
      attributes[ATTRIBUTE_DEFS[addIndex % ATTRIBUTE_DEFS.length].key] += 1
      addIndex++
      total++
    }
  }

  sumAttributes(attributes = {}) {
    return ATTRIBUTE_DEFS.reduce((sum, def) => sum + (Number(attributes[def.key]) || 0), 0)
  }

  scaleAttributesToTotal(attributes = {}, targetTotal = ATTRIBUTE_TOTAL) {
    const sourceTotal = this.sumAttributes(attributes)
    const normalizedTarget = this.normalizeAttributeTargetTotal(targetTotal)
    if (!sourceTotal) return this.generateAttributes("", "均衡", normalizedTarget)

    const scaled = {}
    const fractional = []
    let assigned = 0
    for (const def of ATTRIBUTE_DEFS) {
      const raw = Math.max(ATTRIBUTE_MIN, Number(attributes[def.key]) || ATTRIBUTE_MIN)
      const exact = raw * normalizedTarget / sourceTotal
      const value = Math.max(ATTRIBUTE_MIN, Math.min(ATTRIBUTE_MAX, Math.floor(exact)))
      scaled[def.key] = value
      assigned += value
      fractional.push({ key: def.key, rest: exact - Math.floor(exact) })
    }

    fractional.sort((a, b) => b.rest - a.rest)
    let index = 0
    while (assigned < normalizedTarget) {
      const key = fractional[index % fractional.length].key
      if (scaled[key] < ATTRIBUTE_MAX) {
        scaled[key] += 1
        assigned += 1
      }
      index += 1
      if (index > ATTRIBUTE_MAX * ATTRIBUTE_DEFS.length * 2) break
    }

    index = fractional.length - 1
    while (assigned > normalizedTarget) {
      const key = fractional[index % fractional.length].key
      if (scaled[key] > ATTRIBUTE_MIN) {
        scaled[key] -= 1
        assigned -= 1
      }
      index = (index - 1 + fractional.length) % fractional.length
    }
    return scaled
  }

  getRaceBalancedTotal(total, minTotal) {
    const original = Number(total) || ATTRIBUTE_TOTAL
    const min = Number(minTotal) || original
    if (original <= min + RACE_BALANCE_THRESHOLD) return Math.round(original)
    const retainedAdvantage = min + (original - min) * RACE_BALANCE_RETAIN_RATE
    const selfFloor = original * RACE_BALANCE_MIN_SELF_RATE
    return Math.round(Math.max(retainedAdvantage, selfFloor))
  }

  prepareRacePlayers(players = []) {
    const humans = players.filter(player => !player.isNpc && this.isValidAttributes(player.attributes))
    if (humans.length < 2) {
      return players.map(player => ({ ...player, attributes: { ...(player.attributes || {}) } }))
    }

    const totals = humans
      .map(player => this.sumAttributes(player.attributes))
      .filter(total => Number.isFinite(total) && total > 0)
    if (!totals.length) return players.map(player => ({ ...player, attributes: { ...(player.attributes || {}) } }))

    const minTotal = Math.min(...totals)
    const maxTotal = Math.max(...totals)
    const enabled = maxTotal - minTotal > RACE_BALANCE_THRESHOLD

    return players.map(player => {
      const attributes = this.isValidAttributes(player.attributes)
        ? { ...player.attributes }
        : this.generateAttributes(player.umaName || player.nickname, "均衡")
      const originalTotal = this.sumAttributes(attributes)
      if (!enabled || player.isNpc) {
        return {
          ...player,
          attributes,
          originalAttributes: { ...attributes },
          raceBalance: { enabled: false, originalTotal, effectiveTotal: originalTotal, minTotal }
        }
      }

      const effectiveTotal = this.getRaceBalancedTotal(originalTotal, minTotal)
      const balancedAttributes = effectiveTotal < originalTotal
        ? this.scaleAttributesToTotal(attributes, effectiveTotal)
        : attributes
      return {
        ...player,
        attributes: balancedAttributes,
        originalAttributes: { ...attributes },
        raceBalance: {
          enabled: effectiveTotal < originalTotal,
          originalTotal,
          effectiveTotal: this.sumAttributes(balancedAttributes),
          minTotal
        }
      }
    })
  }

  normalizeUmaAffix(source = {}) {
    const raw = source?.affix || source?.titleAffix || source?.modifier || source?.title ||
      (source?.label || source?.quality || source?.rarity || source?.tier ? source : null)
    if (!raw) return null
    if (typeof raw === "string") {
      const label = raw.trim()
      return label ? { label, quality: "common" } : null
    }
    const label = String(raw.label || raw.name || raw.title || "").trim()
    if (!label) return null
    const qualityRaw = String(raw.quality || raw.rarity || raw.tier || "common").trim().toLowerCase()
    const qualityMap = {
      broken: "broken",
      破损: "broken",
      flawed: "broken",
      bad: "broken",
      cursed: "cursed",
      curse: "cursed",
      诅咒: "cursed",
      normal: "common",
      common: "common",
      普通: "common",
      good: "good",
      excellent: "good",
      优秀: "good",
      rare: "rare",
      稀有: "rare",
      epic: "epic",
      史诗: "epic",
      shine: "shiny",
      shiny: "shiny",
      闪耀: "shiny",
      legendary: "shiny",
      传说: "shiny"
    }
    return {
      id: raw.id || "",
      label,
      quality: qualityMap[qualityRaw] || "common",
      qualityLabel: raw.qualityLabel || AFFIX_QUALITIES[qualityMap[qualityRaw] || "common"]?.label || "",
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      mechanic: raw.mechanic || "",
      effect: Number.isFinite(Number(raw.effect)) ? Number(raw.effect) : AFFIX_QUALITIES[qualityMap[qualityRaw] || "common"]?.effect || 0,
      rolledAt: raw.rolledAt || ""
    }
  }

  getMaxedAttributeKeys(uma = {}) {
    const attributes = uma.attributes || {}
    return ATTRIBUTE_DEFS
      .filter(def => Number(attributes[def.key]) >= ATTRIBUTE_MAX)
      .map(def => def.key)
  }

  formatAffix(affix = null) {
    const normalized = this.normalizeUmaAffix(affix)
    if (!normalized) return "暂无"
    const quality = AFFIX_QUALITIES[normalized.quality] || AFFIX_QUALITIES.common
    return `${quality.label}·${normalized.label}`
  }

  getAffixRerollCost(config = this.getConfig(), affix = null) {
    const normalized = this.normalizeUmaAffix(affix)
    const qualityKey = normalized?.quality || "common"
    return Math.max(0, Number(AFFIX_REROLL_COSTS[qualityKey] ?? AFFIX_REROLL_COSTS.common) || 0)
  }

  formatAffixRerollCostTable(config = this.getConfig()) {
    return Object.keys(AFFIX_REROLL_COSTS)
      .map(key => `${AFFIX_QUALITIES[key]?.label || key}${this.getAffixRerollCost(config, { label: "示例", quality: key })}`)
      .join(" / ")
  }

  pickWeighted(items = []) {
    const total = items.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0)
    if (total <= 0) return items[0]?.value || null
    let roll = Math.random() * total
    for (const item of items) {
      roll -= Math.max(0, Number(item.weight) || 0)
      if (roll <= 0) return item.value
    }
    return items[items.length - 1]?.value || null
  }

  rollAffixForUma(uma = {}) {
    const maxed = new Set(this.getMaxedAttributeKeys(uma))
    const weighted = AFFIX_POOL.map(entry => {
      const quality = AFFIX_QUALITIES[entry.quality] || AFFIX_QUALITIES.common
      const tags = Array.isArray(entry.tags) ? entry.tags : []
      const matched = tags.filter(tag => maxed.has(tag)).length
      const directionWeight = matched > 0 ? 7 + matched * 2 : tags.includes("universal") ? 3 : 1
      return { value: entry, weight: quality.weight * directionWeight }
    })
    const picked = this.pickWeighted(weighted) || AFFIX_POOL[0]
    const quality = AFFIX_QUALITIES[picked.quality] || AFFIX_QUALITIES.common
    return {
      id: picked.id,
      label: picked.label,
      quality: picked.quality,
      qualityLabel: quality.label,
      tags: [...(picked.tags || [])],
      mechanic: picked.mechanic || "",
      effect: quality.effect,
      rolledAt: nowIso()
    }
  }

  getAffixActionBonus(runner = {}, actionKey = "") {
    const affix = this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner)
    if (!affix) return 0
    const quality = AFFIX_QUALITIES[affix.quality] || AFFIX_QUALITIES.common
    const tags = Array.isArray(affix.tags) ? affix.tags : []
    const directions = ACTION_AFFIX_DIRECTIONS[actionKey] || []
    if (tags.includes("universal")) return Math.trunc(quality.effect / 2)
    return tags.some(tag => directions.includes(tag)) ? quality.effect : 0
  }

  formatAffixDirections(tags = []) {
    const labels = (Array.isArray(tags) ? tags : [])
      .map(tag => AFFIX_DIRECTION_LABELS[tag] || tag)
      .filter(Boolean)
    return labels.length ? labels.join("/") : "通用"
  }

  formatAffixEffect(affix = null) {
    const normalized = this.normalizeUmaAffix(affix)
    if (!normalized) return "无效果"
    const quality = AFFIX_QUALITIES[normalized.quality] || AFFIX_QUALITIES.common
    const effect = Number.isFinite(Number(normalized.effect)) ? Number(normalized.effect) : Number(quality.effect) || 0
    const directions = this.formatAffixDirections(normalized.tags)
    const mechanicText = normalized.mechanic ? `机制：${this.describeAffixMechanic(normalized.mechanic)}` : "机制：无"
    const numericText = normalized.tags?.includes?.("universal")
      ? `相关行动判定 +${Math.trunc(effect / 2)}`
      : `相关行动判定 ${effect >= 0 ? "+" : ""}${effect}`
    return `${directions}；${numericText}；${mechanicText}`
  }

  describeAffixMechanic(mechanic = "") {
    return {
      advantage_roll: "相关行动每场一次额外掷一个 D100，取较好结果。",
      reroll_fumble: "每场第一次大失败会重掷一次。",
      extra_push: "相关行动成功时每场一次额外推进一小段。",
      stamina_guard: "相关行动每场一次降低体力消耗。",
      finish_burst: "冲刺阶段相关行动成功时额外推进，但会多耗一点余力。",
      route_surge: "相关行动每场一次提高路线状态并小幅推进。",
      soften_failure: "相关行动每场一次把失败惩罚放轻。",
      downgrade_first_critical: "负面机制：每场第一次大成功会被压成困难成功。",
      bad_luck_echo: "负面机制：每场第一次失败会额外损失一点节奏。"
    }[mechanic] || "无"
  }

  affixMatchesAction(affix = null, actionKey = "") {
    if (!affix) return false
    const tags = Array.isArray(affix.tags) ? affix.tags : []
    if (tags.includes("universal")) return true
    const directions = ACTION_AFFIX_DIRECTIONS[actionKey] || []
    return tags.some(tag => directions.includes(tag))
  }

  isAffixMechanicUsed(runner = {}, key = "") {
    return !!runner.race?.affixMechanicUsed?.[key]
  }

  markAffixMechanicUsed(runner = {}, key = "") {
    if (!runner.race) runner.race = {}
    if (!runner.race.affixMechanicUsed || typeof runner.race.affixMechanicUsed !== "object") {
      runner.race.affixMechanicUsed = {}
    }
    runner.race.affixMechanicUsed[key] = true
  }

  gradeRaceRoll(roll, target, criticalLimit) {
    if (roll >= 96) return "fumble"
    if (roll <= criticalLimit) return "critical"
    if (roll <= Math.floor(target / 2)) return "hard"
    if (roll <= target) return "success"
    return "fail"
  }

  isBetterGrade(a, b) {
    const order = { critical: 5, hard: 4, success: 3, fail: 2, fumble: 1 }
    return (order[a] || 0) > (order[b] || 0)
  }

  showAffix(e) {
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号。"
    const config = this.getConfig()
    const record = this.getPlayerRecord(userId, config)
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) return "你还没有领养赛马娘。先用：.赛马娘 领养 名字 性格描述"
    const maxed = this.getMaxedAttributeKeys(uma)
    const affix = this.normalizeUmaAffix(uma)
    const rerollCost = this.getAffixRerollCost(config, affix)
    return [
      `${uma.name} 的词条：${this.formatAffix(affix)}`,
      affix ? `效果：${this.formatAffixEffect(affix)}` : "当前还没有词条。",
      `满属性方向：${maxed.map(key => ATTRIBUTE_DEFS.find(def => def.key === key)?.label || key).join(" / ") || "暂无"}`,
      `本次重铸消耗：${rerollCost} 积分`,
      `费用表：${this.formatAffixRerollCostTable(config)}`,
      maxed.length ? "满属性方向会提高对应词条出现概率。" : "暂无满属性方向，本次重铸按基础词条池随机。",
      "重铸：.赛马娘 重铸（立即覆盖旧词条，不能反悔）"
    ].join("\n")
  }

  async rerollAffix(e) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号。"
    const data = this.readPoints(config)
    const record = data.players?.[userId]
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) return "你还没有领养赛马娘。先用：.赛马娘 领养 名字 性格描述"
    const oldAffix = this.normalizeUmaAffix(uma)
    const cost = this.getAffixRerollCost(config, oldAffix)
    const points = Number(record.points) || 0
    if (points < cost) return `重铸需要 ${cost} 积分，你现在只有 ${points}。`

    const newAffix = this.rollAffixForUma(uma)
    record.points = points - cost
    uma.affix = newAffix
    record.uma = uma
    record.updatedAt = nowIso()
    data.players[userId] = record
    await this.writePoints(data, config)
    return [
      `${uma.name} 完成重铸。`,
      `消耗：${cost} 积分`,
      `旧词条：${this.formatAffix(oldAffix)}（${this.formatAffixEffect(oldAffix)}）`,
      `新词条：${this.formatAffix(newAffix)}（${this.formatAffixEffect(newAffix)}）`,
      `积分：${points} -> ${record.points}`,
      "这次结果已经生效，不能反悔。"
    ].join("\n")
  }

  showAffixPool() {
    const byQuality = Object.keys(AFFIX_QUALITIES).map(qualityKey => {
      const quality = AFFIX_QUALITIES[qualityKey]
      const names = AFFIX_POOL
        .filter(item => item.quality === qualityKey)
        .map(item => item.label)
        .join("、")
      return `${quality.label}：${names}`
    })
    return [
      "赛马娘词条池：",
      "品级从低到高：诅咒 / 破损 / 普通 / 优秀 / 稀有 / 史诗 / 闪耀。",
      "诅咒和闪耀都是 1%；重铸会立即覆盖旧词条。",
      ...byQuality
    ].join("\n")
  }

  formatRaceRunnerName(runner = {}) {
    const name = runner.umaName || runner.nickname || "无名小马"
    const affix = this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner)
    const affixText = affix?.label ? `[${affix.label}]` : ""
    return `${affixText}${name}${runner.isNpc ? "（NPC）" : ""}`
  }

  formatAttributes(attributes = {}) {
    return ATTRIBUTE_DEFS
      .map(def => `${def.label}${Number(attributes[def.key]) || 0}`)
      .join(" / ")
  }

  formatTrainingAttributes(attributes = {}) {
    return ATTRIBUTE_DEFS
      .map(def => `${def.label}${Number(attributes[def.key]) || 0}/${ATTRIBUTE_MAX}`)
      .join(" / ")
  }

  formatTopProficiency(proficiency = {}) {
    const normalized = this.normalizeProficiency(proficiency)
    const ranked = Object.entries(normalized)
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, value]) => `${RACE_ACTIONS[key]?.label || key}${value}/${PROFICIENCY_MAX}(${this.getProficiencyLevel(value).label})`)
    return ranked.length ? ranked.join(" / ") : "暂无"
  }

  async adoptUma(e, { overwrite = false } = {}) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号，领养失败。"
    const parsed = this.parseAdoptionInput(e?.msg)
    if (!parsed?.name) {
      return "格式：.赛马娘 领养 名字 性格描述\n例如：.赛马娘 领养 小春 温柔但不服输，关键时刻会拼一把"
    }
    if (!parsed.personality) {
      return "还需要写一点期待的性格描述，例如：温柔但不服输。"
    }

    const data = this.readPoints(config)
    const record = data.players[userId] || {
      userId,
      nickname: this.getDisplayName(e),
      points: 0,
      wins: 0,
      races: 0,
      podiums: 0,
      updatedAt: nowIso()
    }
    if (record.uma && !overwrite) {
      return `你已经领养了「${record.uma.name}」。如果要重建，使用：.赛马娘 重新领养 名字 性格描述`
    }

    const uma = {
      name: parsed.name,
      personality: parsed.personality,
      attributes: this.generateAttributes(parsed.name, parsed.personality),
      proficiency: this.normalizeProficiency(),
      total: ATTRIBUTE_TOTAL,
      createdAt: nowIso()
    }
    this.normalizeUmaTrait(uma)
    record.nickname = this.getDisplayName(e)
    record.uma = uma
    record.updatedAt = nowIso()
    data.players[userId] = record
    await this.writePoints(data, config)

    return [
      `领养成功：${uma.name}`,
      `性格：${uma.personality}`,
      `特质：${uma.trait.label} - ${uma.trait.description}`,
      `六维：${this.formatAttributes(uma.attributes)}`,
      `初始总点数：${this.sumAttributes(uma.attributes)}`
    ].join("\n")
  }

  showUma(e) {
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号。"
    const record = this.getPlayerRecord(userId)
    const uma = record?.uma
    if (!uma) return "你还没有领养赛马娘。格式：.赛马娘 领养 名字 性格描述"
    const trait = this.normalizeUmaTrait(uma)
    const affix = this.normalizeUmaAffix(uma)
    return [
      `你的赛马娘：${uma.name}`,
      `词条：${this.formatAffix(affix)}`,
      `词条效果：${this.formatAffixEffect(affix)}`,
      `性格：${uma.personality || "未记录"}`,
      `特质：${trait.label} - ${trait.description}`,
      `六维：${this.formatAttributes(uma.attributes)}`,
      `熟练度：${this.formatTopProficiency(uma.proficiency)}`,
      `当前总点数：${this.sumAttributes(uma.attributes)}`,
      `积分：${Number(record.points) || 0}，胜场：${Number(record.wins) || 0}，参赛：${Number(record.races) || 0}`
    ].join("\n")
  }

  parseTrainingInput(msg = "") {
    const text = String(msg || "")
      .replace(/^[.。]赛马娘\s*训练\s*/u, "")
      .trim()
    if (!text) return null
    const parts = text.split(/\s+/).filter(Boolean)
    return {
      type: this.resolveTrainingType(parts[0] || text),
      attribute: this.resolveAttribute(parts.slice(1).join(" ") || parts[1] || text),
      raw: text
    }
  }

  resolveTrainingType(text = "") {
    const normalized = String(text || "").trim()
    for (const [key, type] of Object.entries(TRAINING_TYPES)) {
      if (type.aliases.some(alias => normalized.includes(alias))) return { key, ...type }
    }
    return null
  }

  resolveAttribute(text = "") {
    const normalized = String(text || "").trim()
    for (const def of ATTRIBUTE_DEFS) {
      const aliases = ATTRIBUTE_ALIASES[def.key] || [def.label]
      if (aliases.some(alias => normalized.includes(alias))) return def
    }
    return null
  }

  getTrainingPity(record, typeKey, attrKey) {
    return Number(record?.trainingPity?.[typeKey]?.[attrKey]) || 0
  }

  setTrainingPity(record, typeKey, attrKey, value) {
    if (!record.trainingPity || typeof record.trainingPity !== "object") record.trainingPity = {}
    if (!record.trainingPity[typeKey] || typeof record.trainingPity[typeKey] !== "object") record.trainingPity[typeKey] = {}
    record.trainingPity[typeKey][attrKey] = Math.max(0, Math.floor(Number(value) || 0))
  }

  getTrainingSuccessRate(type, currentValue) {
    const value = Math.max(ATTRIBUTE_MIN, Number(currentValue) || ATTRIBUTE_MIN)
    return Math.max(type.minRate, type.baseRate - value * type.decay)
  }

  async trainUma(e) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号，训练失败。"

    const parsed = this.parseTrainingInput(e?.msg)
    if (!parsed?.type || !parsed?.attribute) {
      return [
        "格式：.赛马娘 训练 基础 速度",
        "训练类型：基础 / 强化 / 赌狗",
        "属性：速度 / 耐力 / 爆发 / 稳定 / 判断 / 运气"
      ].join("\n")
    }

    const data = this.readPoints(config)
    const record = data.players?.[userId]
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) {
      return "你还没有领养赛马娘。先用：.赛马娘 领养 名字 性格描述"
    }

    const currentPoints = Number(record.points) || 0
    if (currentPoints < parsed.type.cost) {
      return [
        `${uma.name} 当前属性：`,
        this.formatTrainingAttributes(uma.attributes),
        `总点数：${this.sumAttributes(uma.attributes)}`,
        `当前积分：${currentPoints}`,
        "",
        `${parsed.type.label}需要 ${parsed.type.cost} 积分，积分不够。`
      ].join("\n")
    }

    const beforeAttributes = { ...uma.attributes }
    const currentValue = Number(uma.attributes[parsed.attribute.key]) || ATTRIBUTE_MIN
    if (currentValue >= ATTRIBUTE_MAX) {
      return [
        `${uma.name} 当前属性：`,
        this.formatTrainingAttributes(uma.attributes),
        `总点数：${this.sumAttributes(uma.attributes)}`,
        `当前积分：${currentPoints}`,
        "",
        `${parsed.attribute.label}已经到上限 ${ATTRIBUTE_MAX}，这次不用训练。`
      ].join("\n")
    }
    if (parsed.type.maxTargetValue && currentValue > parsed.type.maxTargetValue) {
      return [
        `${uma.name} 当前属性：`,
        this.formatTrainingAttributes(uma.attributes),
        `总点数：${this.sumAttributes(uma.attributes)}`,
        `当前积分：${currentPoints}`,
        "",
        `${parsed.attribute.label}已经达到 ${currentValue}，基础训练不能继续提升这个属性。`,
        "可以改用：.赛马娘 训练 强化 [属性] 或 .赛马娘 训练 赌狗 [属性]"
      ].join("\n")
    }

    const successRate = this.getTrainingSuccessRate(parsed.type, currentValue)
    const pityBefore = this.getTrainingPity(record, parsed.type.key, parsed.attribute.key)
    const forcedByPity = pityBefore >= parsed.type.pity
    const success = forcedByPity || Math.random() < successRate
    const resultLines = []
    let actualGain = 0
    let penaltyLines = []

    record.points = currentPoints - parsed.type.cost
    if (success) {
      const gain = parsed.type.critGain && !forcedByPity && Math.random() < parsed.type.critRate
        ? parsed.type.critGain
        : parsed.type.gain
      const before = Number(uma.attributes[parsed.attribute.key]) || ATTRIBUTE_MIN
      const after = Math.min(ATTRIBUTE_MAX, before + gain)
      actualGain = after - before
      uma.attributes[parsed.attribute.key] = after
      this.setTrainingPity(record, parsed.type.key, parsed.attribute.key, 0)
      resultLines.push("结果：成功")
      resultLines.push(actualGain > 0
        ? `${parsed.attribute.label} +${actualGain}`
        : `${parsed.attribute.label} 已到上限 ${ATTRIBUTE_MAX}`)
    } else {
      this.setTrainingPity(record, parsed.type.key, parsed.attribute.key, pityBefore + 1)
      penaltyLines = this.applyTrainingPenalty(uma.attributes, parsed.attribute.key, parsed.type)
      resultLines.push("结果：失败")
      resultLines.push(penaltyLines.length ? penaltyLines.join("，") : "没有额外掉属性")
    }

    uma.total = this.sumAttributes(uma.attributes)
    record.nickname = this.getDisplayName(e)
    record.updatedAt = nowIso()
    data.players[userId] = record
    await this.writePoints(data, config)

    return [
      `${uma.name} 当前属性：`,
      this.formatTrainingAttributes(beforeAttributes),
      `训练前总点数：${this.sumAttributes(beforeAttributes)}`,
      `当前积分：${currentPoints}`,
      "",
      `训练：${parsed.type.label} - ${parsed.attribute.label}`,
      `消耗：${parsed.type.cost} 积分`,
      "",
      ...resultLines,
      "",
      "训练后：",
      this.formatTrainingAttributes(uma.attributes),
      `训练后总点数：${this.sumAttributes(uma.attributes)}`,
      `剩余积分：${record.points}`
    ].join("\n")
  }

  applyTrainingPenalty(attributes, targetKey, type) {
    if (Math.random() >= type.failPenaltyChance) return []
    const keys = ATTRIBUTE_DEFS
      .map(def => def.key)
      .filter(key => key !== targetKey && (Number(attributes[key]) || ATTRIBUTE_MIN) > ATTRIBUTE_MIN)
    const lines = []
    const targetDef = ATTRIBUTE_DEFS.find(item => item.key === targetKey)
    if (type.failTargetPenaltyChance && Math.random() < type.failTargetPenaltyChance) {
      const before = Number(attributes[targetKey]) || ATTRIBUTE_MIN
      const after = Math.max(ATTRIBUTE_MIN, before - 1)
      attributes[targetKey] = after
      if (after < before) lines.push(`${targetDef?.label || targetKey} -1`)
    }
    for (let index = 0; index < type.failPenaltyCount && keys.length; index++) {
      const key = keys.splice(Math.floor(Math.random() * keys.length), 1)[0]
      const def = ATTRIBUTE_DEFS.find(item => item.key === key)
      const before = Number(attributes[key]) || ATTRIBUTE_MIN
      const after = Math.max(ATTRIBUTE_MIN, before - 1)
      attributes[key] = after
      if (after < before) lines.push(`${def?.label || key} -1`)
    }
    return lines
  }

  showTrainingStatus(e) {
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号。"
    const record = this.getPlayerRecord(userId)
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) {
      return "你还没有领养赛马娘。先用：.赛马娘 领养 名字 性格描述"
    }
    return [
      "赛马娘训练：",
      `${uma.name} 当前属性：`,
      this.formatTrainingAttributes(uma.attributes),
      `总点数：${this.sumAttributes(uma.attributes)}`,
      `当前积分：${Number(record.points) || 0}`,
      "",
      "训练方式：",
      ".赛马娘 训练 基础 [属性] - 消耗 2 积分，单项 20 后不可用",
      ".赛马娘 训练 强化 [属性] - 消耗 5 积分，提升更多但有风险",
      ".赛马娘 训练 赌狗 [属性] - 消耗 8 积分，波动最大",
      "",
      "属性：速度 / 耐力 / 爆发 / 稳定 / 判断 / 运气",
      "满值：每项 50"
    ].join("\n")
  }

  async abandonUma(e, { confirm = false } = {}) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号，弃养失败。"

    const data = this.readPoints(config)
    const record = data.players?.[userId]
    const uma = record?.uma
    if (!uma) return "你现在没有领养赛马娘。"
    if (!confirm) {
      return `确认要弃养「${uma.name}」吗？积分和历史战绩会保留，但这匹小马的六维档案会删除。\n确认请发：.赛马娘 弃养 确认`
    }

    delete record.uma
    record.nickname = this.getDisplayName(e)
    record.updatedAt = nowIso()
    data.players[userId] = record
    await this.writePoints(data, config)

    const removedFromRoom = this.removeUserFromActiveRoom(e, userId)
    return [
      `已弃养：${uma.name}`,
      "你的积分和历史战绩已保留。",
      removedFromRoom ? "你也已从当前赛马局报名列表中移除。" : ""
    ].filter(Boolean).join("\n")
  }

  removeUserFromActiveRoom(e, userId) {
    if (!e?.group_id || !userId) return false
    const room = this.getRoom(e.group_id)
    if (!room?.participants?.has(userId)) return false
    room.participants.delete(userId)
    return true
  }

  getRoom(groupId) {
    return this.rooms.get(String(groupId || ""))
  }

  getDisplayName(e) {
    return escapeName(e?.sender?.card || e?.sender?.nickname || e?.nickname || e?.user_id)
  }

  pickTrack() {
    return pick(TRACKS)
  }

  pickTwist() {
    return pick(RACE_TWISTS)
  }

  pickScene() {
    return pick(RACE_SCENES)
  }

  pickCondition() {
    return pick(RACE_CONDITIONS)
  }

  parseStrategy(input = "") {
    const text = String(input || "")
      .replace(/^[.。]赛马娘\s*(加入|参加|上马|报名)\s*/u, "")
      .trim()
    if (!text) return STRATEGIES.normal

    for (const strategy of Object.values(STRATEGIES)) {
      if (strategy.aliases.some(alias => text.includes(alias))) return strategy
    }
    return STRATEGIES.normal
  }

  formatStrategyTips() {
    return "策略：稳一点 / 拼一把 / 留体力 / 抢内道；不填就是正常跑"
  }

  formatTrack(track) {
    return `本局赛道：${track.name} - ${track.description}`
  }

  formatRaceSceneName(room = {}) {
    return [
      room.track?.name,
      room.condition?.name,
      room.twist?.name,
      room.scene?.name
    ].filter(Boolean).join(" + ")
  }

  formatOpeningAnnouncer(room = {}) {
    const track = room.track || {}
    const condition = room.condition || {}
    const twist = room.twist || {}
    const scene = room.scene || {}
    return [
      "各位训练员，看赛道！",
      "",
      `这局是「${track.name || "未知赛道"}」，${track.description || "胜负会在每一次选择里拉开。"}`,
      `今天场地「${condition.name || "维护良好"}」，${condition.broadcast || condition.description || "状态很稳，谁的节奏更完整，谁就更有机会。"}`,
      `临场变化是「${twist.name || "未知变化"}」，${twist.description || "比赛节奏可能随时改变。"}`,
      `赛况预警：「${scene.name || "未知事件"}」，${scene.description || "关键位置会很考验判断。"}`,
      "",
      "让我们拭目以待！"
    ].join("\n")
  }

  buildRaceProfile(track = {}, twist = {}, scene = {}, condition = {}) {
    const base = TRACK_NUMERIC_PROFILES[track.id] || TRACK_NUMERIC_PROFILES.short_sprint
    const conditionMod = CONDITION_NUMERIC_MODIFIERS[condition.name] || {}
    const twistMod = TWIST_NUMERIC_MODIFIERS[twist.name] || {}
    const sceneMod = SCENE_NUMERIC_MODIFIERS[scene.name] || {}
    const segments = [...base.segments]
    const slope = [...base.slope]
    const corner = base.corner.map(value =>
      clampNumber(value + Number(conditionMod.corner || 0) + Number(twistMod.corner || 0) + Number(sceneMod.corner || 0), 0, 0.8)
    )
    const profile = {
      distance: Number(base.distance) || segments.reduce((sum, value) => sum + value, 0),
      segments,
      friction: clampNumber(Number(base.friction) + Number(conditionMod.friction || 0) + Number(twistMod.friction || 0) + Number(sceneMod.friction || 0), 0.78, 1.5),
      slope,
      corner,
      staminaCostRate: clampNumber(Number(base.staminaCostRate) + Number(conditionMod.staminaCostRate || 0) + Number(twistMod.staminaCostRate || 0) + Number(sceneMod.staminaCostRate || 0), 0.72, 1.55),
      rhythmDifficulty: clampNumber(Number(base.rhythmDifficulty) + Number(conditionMod.rhythmDifficulty || 0) + Number(twistMod.rhythmDifficulty || 0) + Number(sceneMod.rhythmDifficulty || 0), 0.72, 1.6),
      routeDifficulty: clampNumber(Number(base.routeDifficulty) + Number(conditionMod.routeDifficulty || 0) + Number(twistMod.routeDifficulty || 0) + Number(sceneMod.routeDifficulty || 0), -8, 24),
      speedCarry: clampNumber(Number(base.speedCarry) + Number(conditionMod.speedCarry || 0) + Number(twistMod.speedCarry || 0) + Number(sceneMod.speedCarry || 0), 0.72, 1.32),
      startSpeedCarry: clampNumber(1 + Number(conditionMod.startSpeedCarry || 0) + Number(twistMod.startSpeedCarry || 0) + Number(sceneMod.startSpeedCarry || 0), 0.75, 1.2),
      finalSpeedCarry: clampNumber(1 + Number(conditionMod.finalSpeedCarry || 0) + Number(twistMod.finalSpeedCarry || 0) + Number(sceneMod.finalSpeedCarry || 0), 0.75, 1.25),
      finalRouteDifficulty: clampNumber(Number(conditionMod.finalRouteDifficulty || 0) + Number(twistMod.finalRouteDifficulty || 0) + Number(sceneMod.finalRouteDifficulty || 0), 0, 18),
      variance: clampNumber(Number(conditionMod.variance || 0) + Number(twistMod.variance || 0) + Number(sceneMod.variance || 0), 0, 12)
    }
    return profile
  }

  getStageEnvironment(room, stage) {
    const profile = room.raceProfile || this.buildRaceProfile(room.track, room.twist, room.scene, room.condition)
    const stageIndex = Math.max(0, RACE_STAGES.findIndex(item => item.key === stage.key))
    const isStart = stage.key === "start"
    const isFinish = stage.key === "finish"
    return {
      profile,
      index: stageIndex,
      segmentDistance: Number(profile.segments[stageIndex]) || profile.distance / RACE_STAGES.length,
      slope: Number(profile.slope[stageIndex]) || 0,
      corner: Number(profile.corner[stageIndex]) || 0,
      friction: Number(profile.friction) || 1,
      staminaCostRate: Number(profile.staminaCostRate) || 1,
      rhythmDifficulty: Number(profile.rhythmDifficulty) || 1,
      routeDifficulty: (Number(profile.routeDifficulty) || 0) + (isFinish ? Number(profile.finalRouteDifficulty) || 0 : 0),
      speedCarry: (Number(profile.speedCarry) || 1) *
        (isStart ? Number(profile.startSpeedCarry) || 1 : 1) *
        (isFinish ? Number(profile.finalSpeedCarry) || 1 : 1),
      variance: Number(profile.variance) || 0
    }
  }

  async startRace(e) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    if (!e?.group_id) return "这个小游戏要在群里玩。"
    if (!this.getPlayerUma(this.getUserId(e), config)) {
      return "你还没有领养自己的赛马娘。先用：.赛马娘 领养 名字 性格描述"
    }

    const groupId = String(e.group_id)
    const existing = this.getRoom(groupId)
    if (existing) {
      if (existing.phase === "race") {
        return this.formatActiveRaceStatus(existing)
      }
      return [
        `这一局已经开了，当前 ${existing.participants.size} 人。`,
        this.formatTrack(existing.track),
        "想参加发：.赛马娘 加入 [策略]",
        this.formatStrategyTips()
      ].join("\n")
    }

    const lastAt = this.lastRaceAt.get(groupId) || 0
    const remain = config.cooldownSeconds - Math.floor((Date.now() - lastAt) / 1000)
    if (remain > 0) return `刚跑完一局，先歇 ${formatDuration(remain)} 再开。`

    const room = {
      groupId,
      starterId: String(e.user_id || e.sender?.user_id || ""),
      createdAt: Date.now(),
      phase: "lobby",
      track: this.pickTrack(),
      participants: new Map(),
      event: e,
      timer: null
    }
    this.rooms.set(groupId, room)
    await this.joinRace(e)
    const starter = room.participants.get(this.getUserId(e))
    const starterLine = starter
      ? `已自动报名：${starter.nickname}「${starter.umaName}」`
      : "已自动报名开局者"

    return [
      "赛马娘小游戏开局啦。",
      this.formatTrack(room.track),
      starterLine,
      `报名：.赛马娘 加入 [策略]`,
      this.formatStrategyTips(),
      `开跑：.赛马娘 开跑`,
      `人数：${room.participants.size}/${RACE_SIZE}，开跑不够 ${RACE_SIZE} 人会补 NPC`
    ].join("\n")
  }

  async joinRace(e, strategyText = "") {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    if (!e?.group_id) return "这个小游戏要在群里玩。"

    const groupId = String(e.group_id)
    let room = this.getRoom(groupId)
    let createdByJoin = false
    const userId = String(e.user_id || e.sender?.user_id || "")
    if (!userId) return "没拿到你的 QQ 号，报名失败。"
    const owned = await this.ensurePlayerUmaTrait(userId, config)
    if (!owned?.uma) return "你还没有领养自己的赛马娘。先用：.赛马娘 领养 名字 性格描述"
    const { uma, trait } = owned

    if (!room) {
      const lastAt = this.lastRaceAt.get(groupId) || 0
      const remain = config.cooldownSeconds - Math.floor((Date.now() - lastAt) / 1000)
      if (remain > 0) return `刚跑完一局，先歇 ${formatDuration(remain)} 再开。`

      room = {
        groupId,
        starterId: userId,
        createdAt: Date.now(),
        phase: "lobby",
        track: this.pickTrack(),
        participants: new Map(),
        event: e,
        timer: null
      }
      this.rooms.set(groupId, room)
      createdByJoin = true
    }

    if (room.phase === "race") {
      return [
        "这一局已经开跑了，不能再报名。",
        this.formatActiveRaceStatus(room)
      ].join("\n")
    }

    const elapsed = Math.floor((Date.now() - room.createdAt) / 1000)
    if (elapsed > config.lobbySeconds) {
      this.clearAutoStart(room)
      this.rooms.delete(groupId)
      const lastAt = this.lastRaceAt.get(groupId) || 0
      const remain = config.cooldownSeconds - Math.floor((Date.now() - lastAt) / 1000)
      if (remain > 0) return `上一局报名超时了，刚跑完一局，先歇 ${formatDuration(remain)} 再开。`

      room = {
        groupId,
        starterId: userId,
        createdAt: Date.now(),
        phase: "lobby",
        track: this.pickTrack(),
        participants: new Map(),
        event: e,
        timer: null
      }
      this.rooms.set(groupId, room)
      createdByJoin = true
    }

    const strategy = this.parseStrategy(strategyText)
    if (room.participants.has(userId)) {
      const player = room.participants.get(userId)
      player.strategyKey = this.getStrategyKey(strategy)
      player.strategyLabel = strategy.label
      room.createdAt = Date.now()
      room.event = e
      this.scheduleAutoStart(room, config)
      return `${this.getDisplayName(e)} 选择了${strategy.label}，已更新策略。`
    }
    if (room.participants.size >= config.maxPlayers) return "这局人满了，下一局再来。"

    room.participants.set(userId, {
      userId,
      nickname: this.getDisplayName(e),
      umaName: uma.name,
      umaAffix: this.normalizeUmaAffix(uma),
      attributes: uma.attributes,
      personality: uma.personality,
      proficiency: this.normalizeProficiency(uma.proficiency),
      traitKey: trait.key,
      traitLabel: trait.label,
      strategyKey: this.getStrategyKey(strategy),
      strategyLabel: strategy.label,
      joinedAt: Date.now()
    })
    room.createdAt = Date.now()
    room.event = e
    this.scheduleAutoStart(room, config)
    if (createdByJoin) {
      return [
        "赛马娘小游戏开局啦。",
        this.formatTrack(room.track),
        `报名成功：${this.getDisplayName(e)} 的「${uma.name}」`,
        `${this.getDisplayName(e)} 选择了${strategy.label}`,
        `报名：.赛马娘 加入 [策略]`,
        this.formatStrategyTips(),
        `开跑：.赛马娘 开跑`,
        `人数：${room.participants.size}/${RACE_SIZE}，开跑不够 ${RACE_SIZE} 人会补 NPC`
      ].join("\n")
    }
    return [
      `报名成功：${this.getDisplayName(e)} 的「${uma.name}」（${room.participants.size}/${config.maxPlayers}）`,
      `${this.getDisplayName(e)} 选择了${strategy.label}`
    ].join("\n")
  }

  scheduleAutoStart(room, config = this.getConfig()) {
    if (!room) return
    this.clearAutoStart(room)
    const delayMs = Math.max(1, Number(config.lobbySeconds) || DEFAULT_CONFIG.lobbySeconds) * 1000
    room.timer = setTimeout(() => {
      this.autoStartRace(room.groupId).catch(error => {
        this.logger?.warn?.(`[赛马娘小游戏] 自动开赛失败: ${error.message}`)
      })
    }, delayMs)
    room.timer.unref?.()
  }

  clearAutoStart(room) {
    if (room?.timer) {
      clearTimeout(room.timer)
      room.timer = null
    }
  }

  scheduleStageAdvance(room, config = this.getConfig()) {
    if (!room || room.phase !== "race") return
    this.clearStageTimer(room)
    const delayMs = Math.max(1, Number(config.raceStageSeconds) || DEFAULT_CONFIG.raceStageSeconds) * 1000
    room.stageTimer = setTimeout(() => {
      this.advanceRaceStage(room.groupId).catch(error => {
        this.logger?.warn?.(`[赛马娘小游戏] 阶段推进失败: ${error.message}`)
      })
    }, delayMs)
    room.stageTimer.unref?.()
  }

  clearStageTimer(room) {
    if (room?.stageTimer) {
      clearTimeout(room.stageTimer)
      room.stageTimer = null
    }
  }

  async autoStartRace(groupId) {
    const room = this.getRoom(groupId)
    if (!room) return
    const event = room.event
    if (!event?.reply) {
      this.rooms.delete(String(groupId || ""))
      return
    }
    if (!room.participants?.size) {
      this.clearAutoStart(room)
      this.rooms.delete(String(groupId || ""))
      await event.reply("报名时间到了，但没有参赛者，本局赛马取消。")
      return
    }
    const result = await this.runRace(event)
    if (typeof result === "string") await sendSmartReply(event, `报名时间到了，自动开赛。\n${result}`, { kind: "umaRaceResult" })
    else await event.reply(["报名时间到了，自动开赛。", ...(Array.isArray(result) ? result : [result])])
  }

  getStrategyKey(strategy) {
    for (const [key, value] of Object.entries(STRATEGIES)) {
      if (value === strategy) return key
    }
    return "normal"
  }

  cancelRace(e) {
    if (!e?.group_id) return "这个小游戏要在群里玩。"
    const groupId = String(e.group_id)
    const room = this.getRoom(groupId)
    if (!room) return "现在没有赛马局。"
    const userId = String(e.user_id || e.sender?.user_id || "")
    if (!e.isMaster && userId !== room.starterId) return "只有开局的人或主人可以取消这一局。"
    this.clearAutoStart(room)
    this.clearStageTimer(room)
    this.rooms.delete(groupId)
    return "这局赛马已经取消。"
  }

  async runRace(e) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    if (!e?.group_id) return "这个小游戏要在群里玩。"

    const groupId = String(e.group_id)
    const room = this.getRoom(groupId)
    if (!room) return "现在没有赛马局。先发：.赛马娘 开始"
    if (room.phase === "race") return this.formatActiveRaceStatus(room)

    const players = this.prepareRacePlayers([...room.participants.values()])
    if (players.length < RACE_SIZE) {
      this.fillNpcPlayers(players, RACE_SIZE)
    }

    this.clearAutoStart(room)
    room.phase = "race"
    room.event = e
    room.startedAt = Date.now()
    room.stageIndex = 0
    room.condition = this.pickCondition()
    room.twist = this.pickTwist()
    room.scene = this.pickScene()
    room.raceProfile = this.buildRaceProfile(room.track, room.twist, room.scene, room.condition)
    room.decisions = new Map()
    room.history = []
    room.runners = this.initializeStageRunners(players, room.track, room.twist, room.scene, room.condition)
    this.lastRaceAt.set(groupId, Date.now())
    this.scheduleStageAdvance(room, config)

    const message = await this.renderRaceReportOrFallback(
      e,
      this.buildOpeningRaceReport(room),
      this.formatRaceStage(room, { opening: true, includeTips: false })
    )
    const withDecision = this.appendMessageText(message, this.formatRaceDecisionCopyText())
    return [this.formatOpeningAnnouncer(room), ...(Array.isArray(withDecision) ? withDecision : [withDecision])]
  }

  async raceDecision(e) {
    if (!e?.group_id) return "这个小游戏要在群里玩。"
    const groupId = String(e.group_id)
    const room = this.getRoom(groupId)
    if (!room) return "现在没有赛马局。先发：.赛马娘 开始"
    if (room.phase !== "race") return "比赛还没开跑。开跑后每个阶段可以发：.赛马娘 决策 提速"

    const userId = this.getUserId(e)
    const runner = room.runners?.find(item => String(item.userId) === userId && !item.isNpc)
    if (!runner) return "你不在这一局里，不能下阶段决策。"

    const action = this.parseRaceAction(e?.msg)
    if (!action) {
      return [
        "没看懂这个决策。",
        this.formatRaceActionTips()
      ].join("\n")
    }

    const stage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]
    if (!room.decisions) room.decisions = new Map()
    let stageDecisions = room.decisions.get(stage.key)
    if (!stageDecisions) {
      stageDecisions = new Map()
      room.decisions.set(stage.key, stageDecisions)
    }
    const previous = stageDecisions.get(userId)
    stageDecisions.set(userId, action.key)
    room.event = e

    if (this.areAllHumanPlayersDecided(room, stageDecisions)) {
      await this.advanceRaceStage(groupId)
      return ""
    }

    return previous && previous !== action.key
      ? `${runner.nickname} 把${stage.label}决策改成了：${action.label}`
      : `${runner.nickname} 的${stage.label}决策：${action.label}`
  }

  areAllHumanPlayersDecided(room, stageDecisions) {
    const humans = (room.runners || []).filter(runner => !runner.isNpc)
    return humans.length > 0 && humans.every(runner => stageDecisions.has(String(runner.userId)))
  }

  parseRaceAction(msg = "") {
    const text = String(msg || "")
      .replace(/^[.。]赛马娘\s*(决策|选择|行动|策略)\s*/u, "")
      .trim()
    if (!text) return null
    for (const [key, action] of Object.entries(RACE_ACTIONS)) {
      if (action.aliases.some(alias => text.includes(alias))) return { key, ...action }
    }
    return null
  }

  formatRaceActionTips() {
    return [
      "可选决策：提速 / 减速 / 稳住 / 抢位 / 爆发 / 赌一把 / 跟跑 / 压节奏",
      "格式：.赛马娘 决策 提速，也可以用：.赛马娘 策略 提速"
    ].join("\n")
  }

  formatRaceDecisionCopyText() {
    return [
      "请使用：.赛马娘 决策 [行动]",
      "也可以用：.赛马娘 策略 [行动]",
      "行动：提速 / 减速 / 稳住 / 抢位 / 爆发 / 赌一把 / 跟跑 / 压节奏"
    ].join("\n")
  }

  initializeStageRunners(players, track, twist, scene, condition = {}) {
    const strategyCounts = this.countStrategies(players)
    const raceProfile = this.buildRaceProfile(track, twist, scene, condition)
    const raceTags = this.getRaceTags(track, twist, scene, condition)
    return players.map(player => {
      const attributes = this.isValidAttributes(player.attributes)
        ? player.attributes
        : this.generateAttributes(player.umaName || player.nickname, "均衡")
      const strategyKey = player.strategyKey && STRATEGIES[player.strategyKey] ? player.strategyKey : "normal"
      const strategy = STRATEGIES[strategyKey]
      const trait = this.getRaceTrait(player)
      const speed = this.rollAttributeValue(attributes.speed)
      const staminaAttr = this.rollAttributeValue(attributes.stamina)
      const power = this.rollAttributeValue(attributes.power)
      const focus = this.rollAttributeValue(attributes.focus)
      const wisdom = this.rollAttributeValue(attributes.wisdom)
      const luck = this.rollAttributeValue(attributes.luck, 50 + (trait.luckBonus || 0), 6)
      const conditionBonus = randomBetween(-7, 8)
      const fitBonus = Number(track.fit?.[strategyKey]) || 0
      const twistBonus = Number(twist.fit?.[strategyKey]) || 0
      const sceneBonus = Number(scene.fit?.[strategyKey]) || 0
      const traitTagBonus = this.getTraitTagBonus(trait, raceTags)
      const traitBonus = this.getTraitBonus(trait, strategyKey, raceTags)
      const strategyCrowdPenalty = this.getStrategyCrowdPenalty(strategyKey, strategyCounts, players.length)
      const basePosition = speed * 0.24 +
        staminaAttr * 0.15 +
        power * 0.15 +
        focus * 0.16 +
        wisdom * 0.14 +
        luck * 0.08 +
        fitBonus +
        twistBonus * 0.55 +
        sceneBonus * 0.55 +
        traitBonus +
        conditionBonus -
        strategyCrowdPenalty +
        randomBetween(-8, 9)
      const staminaMax = Math.min(145, 82 + Number(attributes.stamina || 0) * 2.35 + randomBetween(-4, 7))
      const rhythmMax = Math.min(135, 78 + Number(attributes.focus || 0) * 2.05 + randomBetween(-5, 7))
      const burstMax = Math.min(130, 58 + Number(attributes.power || 0) * 2.15 + randomBetween(-5, 7))
      const routeBase = Math.min(128, 58 + Number(attributes.wisdom || 0) * 2.25 + randomBetween(-6, 8))
      const baseVelocity = clampNumber(
        42 +
        (speed - 70) * 0.115 +
        (power - 70) * 0.035 +
        (focus - 70) * 0.018 +
        fitBonus * 0.18 +
        traitBonus * 0.12 -
        strategyCrowdPenalty * 0.2 +
        randomBetween(-3.5, 4.5),
        28,
        92
      )

      return {
        ...player,
        attributes,
        strategyKey,
        strategyLabel: strategy.label,
        traitKey: trait.key,
        traitLabel: trait.label,
        traitTagBonus,
        proficiency: this.normalizeProficiency(player.proficiency),
        raceTags: [...raceTags],
        race: {
          speed,
          staminaAttr,
          power,
          focus,
          wisdom,
          luck,
          position: basePosition,
          distance: Math.max(0, basePosition * 0.42 + randomBetween(-5, 5)),
          velocity: baseVelocity * raceProfile.speedCarry,
          maxVelocity: clampNumber(baseVelocity + 18 + (speed - 70) * 0.035, 46, 122),
          staminaMax,
          stamina: staminaMax,
          rhythmMax,
          rhythm: rhythmMax,
          burstMax,
          burstReserve: burstMax,
          route: routeBase,
          luckState: Math.min(120, 46 + Number(attributes.luck || 0) * 2.3 + randomBetween(-10, 11)),
          notes: [this.formatConditionEvent(player.nickname, conditionBonus)]
        }
      }
    })
  }

  async advanceRaceStage(groupId) {
    const room = this.getRoom(groupId)
    if (!room || room.phase !== "race") return
    if (room.advancing) return
    room.advancing = true
    this.clearStageTimer(room)
    try {
      const stage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]
      const lines = this.resolveRaceStage(room, stage)
      room.history.push({ stage: stage.key, lines })

      if (room.stageIndex >= RACE_STAGES.length - 1) {
        const finalMessage = await this.finishStagedRace(room)
        await room.event?.reply?.(finalMessage)
        return
      }

      const previousStage = stage
      room.stageIndex += 1
      room.advancing = false
      this.scheduleStageAdvance(room)
      const fallbackText = [
        `${stage.label}结束：`,
        ...lines,
        "",
        this.formatRaceStage(room, { includeTips: false })
      ].join("\n")
      const message = await this.renderRaceReportOrFallback(
        room.event,
        this.buildStageRaceReport(room, previousStage, lines),
        fallbackText
      )
      await room.event?.reply?.(this.appendMessageText(message, this.formatRaceDecisionCopyText()))
    } finally {
      if (this.getRoom(groupId) === room) room.advancing = false
    }
  }

  resolveRaceStage(room, stage) {
    const rankedBefore = this.rankRunners(room.runners)
    const stageDecisions = room.decisions?.get(stage.key) || new Map()
    room.stageSnapshot = new Map(rankedBefore.map((runner, index) => [String(runner.userId), {
      rank: index + 1,
      userId: runner.userId,
      distance: Number(runner.race?.distance) || 0,
      velocity: Number(runner.race?.velocity) || 0
    }]))
    room.stageActionEffects = new Map()
    const lines = []
    for (const runner of rankedBefore) {
      const beforeRank = rankedBefore.findIndex(item => item.userId === runner.userId) + 1
      const manualAction = stageDecisions.get(String(runner.userId))
      const actionKey = runner.isNpc
        ? this.pickNpcStageAction(runner, beforeRank, stage, room)
        : (manualAction || this.getDefaultStageActionForStage(runner, stage, beforeRank, room))
      const action = RACE_ACTIONS[actionKey] ? { key: actionKey, ...RACE_ACTIONS[actionKey] } : { key: "steady", ...RACE_ACTIONS.steady }
      const result = this.applyRaceAction(runner, action, stage, beforeRank, room)
      if (!runner.isNpc && result.line) lines.push(result.line)
    }
    for (const runner of room.runners) {
      const race = runner.race
      if (race.stamina < 24) {
        race.velocity = Math.max(5, (Number(race.velocity) || 0) - randomBetween(4, 9))
        race.distance = Math.max(0, (Number(race.distance) || 0) - randomBetween(8, 18))
      }
      if (race.rhythm < 24) {
        race.velocity = Math.max(5, (Number(race.velocity) || 0) - randomBetween(3, 8))
        race.distance = Math.max(0, (Number(race.distance) || 0) - randomBetween(6, 16))
      }
      if (race.stamina > 82 && stage.key === "finish") race.distance += randomBetween(5, 14)
      race.position = Number(race.distance) || 0
    }
    room.stageSnapshot = null
    room.stageActionEffects = null
    return lines.length ? lines.slice(0, 5) : ["大家都按自己的节奏处理了这一段，队形还在继续变化。"]
  }

  applyRaceAction(runner, action, stage, beforeRank, room) {
    const race = runner.race
    const check = this.rollRaceActionCheck(runner, action.key, stage, room)
    const effect = CHECK_GRADE_EFFECTS[check.grade] || CHECK_GRADE_EFFECTS.success
    const stageRate = this.getStageActionRate(action.key, stage.key, room.track?.id)
    const env = this.getStageEnvironment(room, stage)
    const attrPush = this.getActionAttributePush(runner, action.key)
    const crowdRisk = action.key === "inside" && beforeRank <= 4 ? randomBetween(0, 8) : 0
    const lowStaminaPenalty = race.stamina < 38 && ["speed_up", "burst", "gamble"].includes(action.key)
      ? randomBetween(5, 14)
      : 0
    const lowRhythmPenalty = race.rhythm < 38 && ["inside", "gamble", "burst"].includes(action.key)
      ? randomBetween(4, 12)
      : 0
    const stabilityGuard = Math.max(0, (race.focus - 70) * 0.018)
    const staminaGuard = Math.max(0, (race.staminaAttr - 70) * 0.018)
    const wisdomGuard = Math.max(0, (race.wisdom - 70) * 0.014)
    const resistedPenalty = (crowdRisk + lowStaminaPenalty + lowRhythmPenalty) * Math.max(0.35, 1 - stabilityGuard - staminaGuard - wisdomGuard)
    const beforeVelocity = Number(race.velocity) || 0
    const beforeStamina = Number(race.stamina) || 0
    let velocityDelta = attrPush * 0.34 * stageRate * effect.multiplier - resistedPenalty * 0.18
    let directDistanceDelta = attrPush * 1.2 * stageRate * effect.multiplier - resistedPenalty
    let note = ""
    const affixMechanicNotes = []

    if (action.key === "speed_up") {
      const speedLift = (randomBetween(7, 13) + attrPush * 0.16) * effect.multiplier
      velocityDelta += speedLift
      directDistanceDelta += speedLift * 0.62
      race.stamina -= this.adjustRaceCost(randomBetween(12, 20) * env.staminaCostRate * (1 + Math.max(0, env.slope) * 1.35), effect.staminaCost, race.staminaAttr)
      race.rhythm -= this.adjustRaceCost(randomBetween(3, 8) * env.rhythmDifficulty, effect.rhythmPenalty, race.focus)
      note = `${runner.nickname} 选择提速，${check.text}，${check.success ? ACTION_CHECKS.speed_up.successText : ACTION_CHECKS.speed_up.failText}。`
    } else if (action.key === "slow_down") {
      const brake = randomBetween(8, 15) * (check.success ? 0.8 : 1.15)
      velocityDelta -= brake
      directDistanceDelta -= randomBetween(7, 15) * (check.success ? 0.75 : 1.2)
      race.stamina += randomBetween(14, 24) * effect.stateBonus
      race.rhythm += randomBetween(8, 15) * effect.stateBonus
      note = `${runner.nickname} 主动减速，${check.text}，${check.success ? ACTION_CHECKS.slow_down.successText : ACTION_CHECKS.slow_down.failText}。`
    } else if (action.key === "steady") {
      race.rhythm += randomBetween(8, 15) * effect.stateBonus
      race.stamina -= this.adjustRaceCost(randomBetween(2, 6) * env.staminaCostRate, effect.staminaCost, race.staminaAttr)
      race.route += check.success ? randomBetween(2, 6) * effect.stateBonus : 0
      velocityDelta *= 0.78
      directDistanceDelta += check.success ? randomBetween(2, 7) * effect.stateBonus : 0
      note = `${runner.nickname} 稳住节奏，${check.text}，${check.success ? ACTION_CHECKS.steady.successText : ACTION_CHECKS.steady.failText}。`
    } else if (action.key === "inside") {
      const routeGain = check.success ? randomBetween(7, 15) * effect.stateBonus : randomBetween(-7, 1)
      race.route += routeGain
      race.rhythm -= this.adjustRaceCost((randomBetween(2, 7) + env.corner * 10 + env.routeDifficulty * 0.18) * env.rhythmDifficulty, effect.rhythmPenalty, race.focus)
      if (check.success) {
        directDistanceDelta += randomBetween(8, 18) * effect.stateBonus
        velocityDelta += randomBetween(2, 6) * effect.multiplier
      }
      if (!check.success || crowdRisk > 0) directDistanceDelta -= randomBetween(5, 13) * (check.success ? 0.55 : 1.1)
      note = `${runner.nickname} 选择抢位，${check.text}，${check.success ? ACTION_CHECKS.inside.successText : ACTION_CHECKS.inside.failText}。`
    } else if (action.key === "burst") {
      const burstLift = (randomBetween(16, 29) + attrPush * 0.2) * effect.multiplier
      velocityDelta += burstLift
      directDistanceDelta += burstLift * 0.82
      race.burstReserve -= this.adjustRaceCost(randomBetween(22, 36) * (1 + Math.max(0, env.slope) * 0.9), effect.staminaCost, race.power)
      race.stamina -= this.adjustRaceCost(randomBetween(18, 31) * env.staminaCostRate * (1 + Math.max(0, env.slope) * 1.2), effect.staminaCost, race.staminaAttr)
      race.rhythm -= this.adjustRaceCost(randomBetween(7, 14) * env.rhythmDifficulty, effect.rhythmPenalty, race.focus)
      if (race.burstReserve < 18) {
        directDistanceDelta -= randomBetween(9, 18)
        velocityDelta -= randomBetween(6, 13)
      }
      note = `${runner.nickname} 开始爆发，${check.text}，${check.success ? ACTION_CHECKS.burst.successText : ACTION_CHECKS.burst.failText}。`
    } else if (action.key === "gamble") {
      const luckEdge = Math.max(0, (Number(race.luck) - 90) * 0.22)
      const powerCeiling = Math.max(0, (Number(race.power) - 82) * 0.12)
      const speedCeiling = Math.max(0, (Number(race.speed) - 82) * 0.08)
      const ceilingBonus = luckEdge + powerCeiling + speedCeiling
      const gradeCeilingRate = check.grade === "critical" ? 1.42 : check.grade === "hard" ? 1.18 : 1
      const failGuard = Math.max(0.25, 1 - Math.max(0, Number(race.luck) - 90) * 0.003)
      const gamble = this.rollGambleActionEffect(check, ceilingBonus, effect, failGuard)
      directDistanceDelta += gamble.distance
      velocityDelta += gamble.velocity
      race.stamina += gamble.stamina
      race.rhythm += gamble.rhythm
      race.route += gamble.route
      race.luckState -= randomBetween(7, 18) * (check.success ? 0.85 : 1.25)
      race.rhythm -= this.adjustRaceCost(randomBetween(4, 12) * env.rhythmDifficulty, effect.rhythmPenalty, race.focus)
      note = `${runner.nickname} 赌了一把，${check.text}，${gamble.text}。`
    } else if (action.key === "follow") {
      race.rhythm += randomBetween(5, 12) * effect.stateBonus
      race.stamina -= this.adjustRaceCost(randomBetween(3, 7) * env.staminaCostRate, effect.staminaCost, race.staminaAttr)
      const chase = this.getFollowChaseEffect(runner, beforeRank, room, check, effect)
      const followDelta = chase.distance
      directDistanceDelta += followDelta
      velocityDelta += chase.velocity
      note = `${runner.nickname} 选择跟跑，${check.text}，${chase.text}。`
    } else if (action.key === "pace") {
      race.stamina += randomBetween(5, 12) * effect.stateBonus
      race.rhythm += randomBetween(4, 10) * effect.stateBonus
      velocityDelta -= stage.key === "finish" ? randomBetween(2, 7) : randomBetween(0, 3)
      directDistanceDelta += (stage.key === "finish" ? randomBetween(-8, 4) : randomBetween(-3, 8)) * (check.success ? 1 : 1.25)
      note = `${runner.nickname} 压住节奏，${check.text}，${check.success ? ACTION_CHECKS.pace.successText : ACTION_CHECKS.pace.failText}。`
    }

    const affix = this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner)
    const mechanic = affix?.mechanic || ""
    const mechanicKey = `action:${mechanic}`
    const canUseActionMechanic = mechanic &&
      this.affixMatchesAction(affix, action.key) &&
      !this.isAffixMechanicUsed(runner, mechanicKey)
    if (canUseActionMechanic && check.success && mechanic === "extra_push") {
      const extra = randomBetween(10, 24)
      directDistanceDelta += extra
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix.label}多顶出${Math.round(extra)}m`)
    } else if (canUseActionMechanic && mechanic === "stamina_guard") {
      const recover = randomBetween(7, 14)
      race.stamina += recover
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix.label}让体力少掉了一截`)
    } else if (canUseActionMechanic && check.success && mechanic === "finish_burst" && stage.key === "finish") {
      const extra = randomBetween(14, 30)
      directDistanceDelta += extra
      race.burstReserve -= randomBetween(5, 11)
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix.label}在终点前多冲了${Math.round(extra)}m`)
    } else if (canUseActionMechanic && check.success && mechanic === "route_surge") {
      const route = randomBetween(7, 14)
      race.route += route
      directDistanceDelta += randomBetween(5, 13)
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix.label}把路线处理得更漂亮`)
    } else if (canUseActionMechanic && !check.success && mechanic === "soften_failure") {
      directDistanceDelta += randomBetween(8, 16)
      velocityDelta += randomBetween(2, 5)
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix.label}把失败损失压低了`)
    } else if (canUseActionMechanic && !check.success && mechanic === "bad_luck_echo") {
      race.rhythm -= randomBetween(7, 14)
      directDistanceDelta -= randomBetween(5, 13)
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix.label}让节奏又乱了一拍`)
    }
    if (affixMechanicNotes.length) note += ` ${affixMechanicNotes.join("；")}。`

    const catchup = this.getCatchupActionBonus(runner, action.key, beforeRank, room, check)
    if (catchup.distance || catchup.velocity) {
      directDistanceDelta += catchup.distance
      velocityDelta += catchup.velocity
      if (catchup.text) note += ` ${catchup.text}。`
    }

    if (runner.isNpc) {
      velocityDelta = this.scalePositiveRaceDelta(velocityDelta, 0.92)
      directDistanceDelta = this.scalePositiveRaceDelta(directDistanceDelta, 0.92)
    }

    const slopeVelocityDrag = Math.max(0, env.slope) * env.friction * 18
    const downhillBoost = Math.max(0, -env.slope) * 12
    const cornerDrag = env.corner * Math.max(0, 18 - (race.focus - 70) * 0.08 - (race.wisdom - 70) * 0.06)
    const velocityDecay = this.getStageVelocityDecay(race, action.key, env, check)
    race.velocity = clampNumber((Number(race.velocity) || 0) + velocityDelta + downhillBoost - slopeVelocityDrag - cornerDrag - velocityDecay, 8, Number(race.maxVelocity) || 118)

    const environmentalCost = (env.segmentDistance / 110) *
      env.friction *
      env.staminaCostRate *
      (1 + Math.max(0, env.slope) * 1.7 + env.corner * 0.35)
    const rhythmCost = (env.corner * 12 + Math.max(0, env.routeDifficulty) * 0.28 + Math.max(0, env.slope) * 7) * env.rhythmDifficulty
    race.stamina -= this.adjustRaceCost(environmentalCost, 1, race.staminaAttr)
    race.rhythm -= this.adjustRaceCost(rhythmCost, 1, race.focus)

    race.stamina = Math.max(0, Math.min(Number(race.staminaMax) || 145, race.stamina))
    race.rhythm = Math.max(0, Math.min(Number(race.rhythmMax) || 135, race.rhythm))
    race.burstReserve = Math.max(0, Math.min(Number(race.burstMax) || 130, race.burstReserve))
    race.route = Math.max(0, Math.min(130, race.route))
    race.luckState = Math.max(0, Math.min(125, race.luckState))

    const routeEfficiency = clampNumber(0.76 + race.route / 260 - env.corner * 0.18 - env.routeDifficulty / 180, 0.58, 1.18)
    const rhythmEfficiency = clampNumber(0.74 + race.rhythm / 310, 0.58, 1.14)
    const staminaEfficiency = race.stamina >= 42
      ? clampNumber(0.82 + race.stamina / 260, 0.78, 1.16)
      : clampNumber(0.56 + race.stamina / 120, 0.45, 0.9)
    const velocityEfficiency = clampNumber(0.72 + race.velocity / 170, 0.72, 1.42)
    const distanceDelta = Math.max(
      8,
      env.segmentDistance * velocityEfficiency * routeEfficiency * rhythmEfficiency * staminaEfficiency +
        directDistanceDelta +
        randomBetween(-6 - env.variance, 7 + env.variance)
    )
    race.distance = Math.max(0, (Number(race.distance) || 0) + distanceDelta)
    race.position = race.distance
    race.lastDelta = {
      distance: distanceDelta,
      velocityBefore: beforeVelocity,
      velocityAfter: race.velocity,
      staminaDelta: race.stamina - beforeStamina,
      velocityDelta: race.velocity - beforeVelocity,
      velocityDecay
    }
    race.lastCheck = check
    race.lastActionKey = action.key
    room.stageActionEffects?.set?.(String(runner.userId), {
      actionKey: action.key,
      velocityBefore: beforeVelocity,
      velocityAfter: race.velocity,
      velocityDelta: race.velocity - beforeVelocity,
      distanceDelta
    })
    this.recordActionProficiencyUse(runner, action.key, check)
    const numericText = this.formatActionNumericDelta(race.lastDelta)
    race.notes = [note, numericText, this.describeRunnerState(runner)].filter(Boolean)
    return { line: `${note} ${numericText} ${this.describeRunnerState(runner)}`.trim() }
  }

  formatActionNumericDelta(delta = {}) {
    const from = Math.round(Number(delta.velocityBefore) || 0)
    const to = Math.round(Number(delta.velocityAfter) || 0)
    const staminaDelta = Math.round(Number(delta.staminaDelta) || 0)
    const staminaText = staminaDelta >= 0 ? `+${staminaDelta}` : `${staminaDelta}`
    const distance = Math.round(Number(delta.distance) || 0)
    return `速度 ${from}->${to}，体力 ${staminaText}，推进 ${distance}m。`
  }

  scalePositiveRaceDelta(value, rate = 1) {
    const amount = Number(value) || 0
    if (amount <= 0) return amount
    return amount * Number(rate || 1)
  }

  getStageVelocityDecay(race = {}, actionKey = "", env = {}, check = {}) {
    const base = randomBetween(4.5, 8.5) *
      (Number(env.friction) || 1) *
      (1 + Math.max(0, Number(env.slope) || 0) * 1.2 + (Number(env.corner) || 0) * 0.28)
    const focusGuard = Math.max(0, (Number(race.focus) - 70) * 0.018)
    const staminaGuard = Math.max(0, (Number(race.staminaAttr) - 70) * 0.012)
    const actionRates = {
      steady: check.success ? 0.28 : 0.45,
      pace: check.success ? 0.42 : 0.58,
      slow_down: 0.88,
      follow: check.success ? 0.55 : 0.76,
      inside: check.success ? 0.62 : 0.86,
      speed_up: 0.82,
      burst: 1.05,
      gamble: check.success ? 0.7 : 1.08
    }
    const rate = actionRates[actionKey] || 0.75
    return Math.max(1.2, base * rate * Math.max(0.58, 1 - focusGuard - staminaGuard))
  }

  rollGambleActionEffect(check = {}, ceilingBonus = 0, effect = CHECK_GRADE_EFFECTS.success, failGuard = 1) {
    if (!check.success) {
      const loss = randomBetween(12, 26) * Math.max(0.7, Math.abs(effect.multiplier || 1)) * failGuard
      const stumble = randomBetween(4, 10) * failGuard
      const failText = check.grade === "fumble"
        ? "大失败，机会没抓住，反而被挤出了节奏"
        : "没接住机会，身位和节奏都亏了一截"
      return {
        distance: -loss,
        velocity: -stumble,
        stamina: -randomBetween(3, 9) * failGuard,
        rhythm: -randomBetween(6, 14) * failGuard,
        route: -randomBetween(1, 6) * failGuard,
        text: failText
      }
    }

    const gradeRate = check.grade === "critical" ? 1.42 : check.grade === "hard" ? 1.18 : 1
    const roll = Math.random()
    const base = (randomBetween(12, 32) + ceilingBonus) * (effect.stateBonus || 1) * gradeRate
    if (check.grade === "critical") {
      return {
        distance: base + randomBetween(22, 42),
        velocity: randomBetween(12, 24) + ceilingBonus * 0.28,
        stamina: -randomBetween(4, 10),
        rhythm: randomBetween(0, 5),
        route: randomBetween(6, 14),
        text: "大成功，像是突然踩中了奇迹路线，整段队形都被她撕开了"
      }
    }
    if (roll < 0.34) {
      return {
        distance: base + randomBetween(8, 18),
        velocity: base * 0.3,
        stamina: -randomBetween(2, 6),
        rhythm: -randomBetween(2, 7),
        route: randomBetween(1, 5),
        text: "突然抓到空档，一口气把距离吃了回来"
      }
    }
    if (roll < 0.67) {
      return {
        distance: base * 0.78,
        velocity: randomBetween(8, 18) + ceilingBonus * 0.22,
        stamina: -randomBetween(6, 13),
        rhythm: -randomBetween(3, 8),
        route: 0,
        text: "速度一下子顶上去，场面被她搅乱了"
      }
    }
    return {
      distance: base * 0.62,
      velocity: randomBetween(3, 9),
      stamina: randomBetween(2, 8),
      rhythm: randomBetween(1, 6),
      route: randomBetween(3, 8),
      text: "不仅没乱，还顺手把路线和气息都接住了"
    }
  }

  getFollowChaseEffect(runner = {}, beforeRank = 1, room = {}, check = {}, effect = CHECK_GRADE_EFFECTS.success) {
    const snapshot = room.stageSnapshot
    if (!snapshot || beforeRank <= 1) {
      const distance = check.success ? randomBetween(2, 8) * (effect.stateBonus || 1) : randomBetween(-5, 2)
      return {
        distance,
        velocity: distance * 0.12,
        text: check.success ? "前面没有可借的影子，只是把自己的节奏贴稳了" : ACTION_CHECKS.follow.failText
      }
    }
    const front = [...snapshot.values()].find(item => item.rank === beforeRank - 1)
    const self = snapshot.get(String(runner.userId))
    const frontEffect = front ? room.stageActionEffects?.get?.(String(front.userId)) : null
    const gap = Math.max(0, (Number(front?.distance) || 0) - (Number(self?.distance) || 0))
    const frontVelocityGain = Math.max(0, Number(frontEffect?.velocityDelta) || 0)
    const frontPulledDistance = Math.max(0, Number(frontEffect?.distanceDelta) || 0)
    const successRate = check.success ? 1 : 0.42
    const gapCut = Math.min(26, gap * randomBetween(0.18, 0.38))
    const draft = check.success
      ? gap <= 72
        ? randomBetween(7, 15)
        : gap <= 150
          ? randomBetween(4, 10)
          : randomBetween(0, 5)
      : 0
    const tow = (frontVelocityGain * randomBetween(0.65, 1.15) + frontPulledDistance * 0.045) * successRate
    const distance = (beforeRank > 4 ? randomBetween(5, 12) : randomBetween(1, 7)) * successRate + gapCut * successRate + tow + draft
    const velocity = (frontVelocityGain * randomBetween(0.22, 0.42) + distance * 0.08) * successRate
    return {
      distance,
      velocity,
      text: check.success
        ? `咬住前一名的节奏，差距被缩短了${Math.round(Math.max(0, distance))}m`
        : ACTION_CHECKS.follow.failText
    }
  }

  getCatchupActionBonus(runner = {}, actionKey = "", beforeRank = 1, room = {}, check = {}) {
    if (beforeRank <= 3 || !["follow", "gamble", "burst"].includes(actionKey)) {
      return { distance: 0, velocity: 0, text: "" }
    }
    const context = this.getRaceGapContext(runner, room)
    if (context.leaderGap < 90 && context.previousGap < 48) return { distance: 0, velocity: 0, text: "" }
    const successRate = check.success ? 1 : 0.35
    const pressure = clampNumber(context.leaderGap / 180, 0.35, 1.35)
    const actionRate = actionKey === "follow" ? 1.05 : actionKey === "gamble" ? 1.18 : 0.92
    const distance = randomBetween(5, 16) * pressure * actionRate * successRate
    const velocity = randomBetween(1, 5) * pressure * actionRate * successRate
    if (distance <= 1) return { distance: 0, velocity: 0, text: "" }
    const text = actionKey === "follow"
      ? "后排借到前方队列的风，追回了一小段"
      : actionKey === "gamble"
        ? "落后位置反而给了她放手一搏的空间"
        : "后排开始强行追速，差距被压回一点"
    return { distance, velocity, text }
  }

  getRaceGapContext(runner = {}, room = {}) {
    const snapshot = room.stageSnapshot
    const self = snapshot?.get?.(String(runner.userId))
    if (!snapshot || !self) return { previousGap: 0, leaderGap: 0, rank: 1 }
    const entries = [...snapshot.values()].sort((a, b) => a.rank - b.rank)
    const leader = entries[0] || self
    const previous = entries.find(item => item.rank === self.rank - 1) || self
    return {
      rank: self.rank,
      previousGap: Math.max(0, (Number(previous.distance) || 0) - (Number(self.distance) || 0)),
      leaderGap: Math.max(0, (Number(leader.distance) || 0) - (Number(self.distance) || 0))
    }
  }

  adjustRaceCost(value, rate = 1, guardAttribute = 70) {
    const guard = Math.max(0, (Number(guardAttribute) - 70) * 0.004)
    return Number(value) * Number(rate || 1) * Math.max(0.68, 1 - guard)
  }

  rollRaceActionCheck(runner, actionKey, stage, room) {
    const race = runner.race || {}
    const config = ACTION_CHECKS[actionKey] || ACTION_CHECKS.steady
    const primary = Number(race[config.primary]) || 70
    const secondary = Number(race[config.secondary]) || 70
    const state = Number(race[config.state]) || 70
    const stageBonus = Number(config.scene?.[stage.key]) || 0
    const trackBonus = Number(config.track?.[room.track?.id]) || 0
    const twistBonus = Number(room.twist?.fit?.[runner.strategyKey]) * 0.18 || 0
    const sceneBonus = Number(room.scene?.fit?.[runner.strategyKey]) * 0.18 || 0
    const traitTagBonus = clampNumber(Number(runner.traitTagBonus) || 0, -3, 4) * 0.55
    const proficiencyBonus = this.getActionProficiencyBonus(runner, actionKey)
    const affixBonus = this.getAffixActionBonus(runner, actionKey)
    const supportBonus = this.getActionCheckSupportBonus(runner, actionKey)
    const staminaPenalty = race.stamina < 35 && ["speed_up", "burst", "gamble"].includes(actionKey) ? -8 : 0
    const rhythmPenalty = race.rhythm < 35 && ["inside", "burst", "gamble"].includes(actionKey) ? -7 : 0
    const luckCritBonus = Math.max(0, (Number(race.luck) - 75) * 0.015)
    const target = Math.round(clampNumber(
      44 +
      (primary - 70) * 0.23 +
      (secondary - 70) * 0.13 +
      (state - 70) * (config.stateWeight || 0.08) +
      stageBonus +
      trackBonus +
      twistBonus +
      sceneBonus +
      traitTagBonus +
      proficiencyBonus +
      affixBonus +
      supportBonus +
      staminaPenalty +
      rhythmPenalty,
      25,
      88
    ))
    const affix = this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner)
    const mechanic = affix?.mechanic || ""
    const mechanicKey = `check:${mechanic}`
    const canUseMechanic = mechanic && this.affixMatchesAction(affix, actionKey) && !this.isAffixMechanicUsed(runner, mechanicKey)
    const roll = randomInt(1, 100)
    const criticalLimit = Math.min(8, 5 + Math.floor(luckCritBonus))
    let finalRoll = roll
    let grade = this.gradeRaceRoll(roll, target, criticalLimit)
    const notes = []
    if (canUseMechanic && mechanic === "advantage_roll") {
      const extraRoll = randomInt(1, 100)
      const extraGrade = this.gradeRaceRoll(extraRoll, target, criticalLimit)
      if (this.isBetterGrade(extraGrade, grade) || (extraGrade === grade && extraRoll < finalRoll)) {
        finalRoll = extraRoll
        grade = extraGrade
      }
      this.markAffixMechanicUsed(runner, mechanicKey)
      notes.push(`${affix.label}额外掷骰 ${roll}/${extraRoll}，取${finalRoll}`)
    } else if (canUseMechanic && mechanic === "reroll_fumble" && grade === "fumble") {
      const extraRoll = randomInt(1, 100)
      finalRoll = extraRoll
      grade = this.gradeRaceRoll(extraRoll, target, criticalLimit)
      this.markAffixMechanicUsed(runner, mechanicKey)
      notes.push(`${affix.label}改写大失败，重掷为${extraRoll}`)
    } else if (canUseMechanic && mechanic === "downgrade_first_critical" && grade === "critical") {
      grade = "hard"
      this.markAffixMechanicUsed(runner, mechanicKey)
      notes.push(`${affix.label}压住了大成功`)
    }
    const label = CHECK_GRADE_EFFECTS[grade]?.label || "失败"
    return {
      roll: finalRoll,
      rawRoll: roll,
      target,
      grade,
      label,
      affixNotes: notes,
      success: ["critical", "hard", "success"].includes(grade),
      text: `D100=${finalRoll}/${target}，${label}${notes.length ? `（${notes.join("；")}）` : ""}`
    }
  }

  getActionCheckSupportBonus(runner, actionKey) {
    const race = runner.race || {}
    const profiles = {
      speed_up: { power: 0.05, focus: 0.03, wisdom: 0.02, luck: 0.018, staminaAttr: 0.016 },
      slow_down: { wisdom: 0.04, luck: 0.018, speed: 0.016, power: 0.012 },
      steady: { staminaAttr: 0.035, wisdom: 0.034, luck: 0.018, speed: 0.012, power: 0.01 },
      inside: { speed: 0.04, luck: 0.028, staminaAttr: 0.018, power: 0.014 },
      burst: { speed: 0.06, staminaAttr: 0.028, focus: 0.024, luck: 0.026, wisdom: 0.014 },
      gamble: { power: 0.06, speed: 0.045, wisdom: 0.034, focus: 0.026, staminaAttr: 0.018 },
      follow: { speed: 0.032, staminaAttr: 0.028, luck: 0.02, power: 0.012 },
      pace: { focus: 0.044, wisdom: 0.032, power: 0.018, luck: 0.016, speed: 0.012 }
    }
    const profile = profiles[actionKey] || {}
    const bonus = Object.entries(profile).reduce((sum, [key, weight]) => {
      return sum + ((Number(race[key]) || 70) - 70) * weight
    }, 0)
    return clampNumber(bonus, -5, 7)
  }

  getActionAttributePush(runner, actionKey) {
    const race = runner.race
    const attr = {
      speed_up: race.speed * 0.082 + race.staminaAttr * 0.024 + race.power * 0.026 + race.focus * 0.018 + race.wisdom * 0.012 + race.luck * 0.01,
      slow_down: race.staminaAttr * 0.046 + race.focus * 0.038 + race.wisdom * 0.02 + race.luck * 0.01 + race.speed * 0.008,
      steady: race.focus * 0.064 + race.wisdom * 0.032 + race.staminaAttr * 0.018 + race.luck * 0.012 + race.speed * 0.008,
      inside: race.wisdom * 0.064 + race.focus * 0.036 + race.speed * 0.018 + race.luck * 0.014 + race.staminaAttr * 0.01,
      burst: race.power * 0.086 + race.speed * 0.044 + race.staminaAttr * 0.018 + race.focus * 0.014 + race.luck * 0.014,
      gamble: race.luck * 0.092 + race.power * 0.038 + race.speed * 0.024 + race.wisdom * 0.018 + race.focus * 0.014 + race.staminaAttr * 0.01,
      follow: race.wisdom * 0.048 + race.focus * 0.042 + race.speed * 0.018 + race.staminaAttr * 0.018 + race.luck * 0.012,
      pace: race.staminaAttr * 0.052 + race.focus * 0.034 + race.wisdom * 0.022 + race.power * 0.012 + race.luck * 0.01
    }
    return (Number(attr[actionKey]) || 0) + this.getSignatureAttributePush(runner, actionKey)
  }

  getSignatureAttributePush(runner, actionKey) {
    const race = runner.race || {}
    const values = [
      ["speed", Number(race.speed) || 70],
      ["stamina", Number(race.staminaAttr) || 70],
      ["power", Number(race.power) || 70],
      ["focus", Number(race.focus) || 70],
      ["wisdom", Number(race.wisdom) || 70],
      ["luck", Number(race.luck) || 70]
    ].sort((a, b) => b[1] - a[1])
    const [key, value] = values[0] || ["focus", 70]
    if (value < 118) return 0
    const relevance = {
      speed: { speed_up: 1, burst: 0.68, inside: 0.42, follow: 0.34, gamble: 0.34, steady: 0.2, pace: 0.16, slow_down: 0.1 },
      stamina: { pace: 1, slow_down: 0.82, steady: 0.58, follow: 0.38, speed_up: 0.26, burst: 0.24, gamble: 0.18, inside: 0.16 },
      power: { burst: 1, speed_up: 0.58, gamble: 0.48, follow: 0.34, inside: 0.26, steady: 0.18, pace: 0.18, slow_down: 0.12 },
      focus: { steady: 1, follow: 0.72, pace: 0.62, inside: 0.48, slow_down: 0.38, speed_up: 0.22, burst: 0.2, gamble: 0.2 },
      wisdom: { inside: 1, follow: 0.76, steady: 0.58, slow_down: 0.42, gamble: 0.36, pace: 0.34, speed_up: 0.18, burst: 0.16 },
      luck: { gamble: 1, burst: 0.44, speed_up: 0.36, inside: 0.34, follow: 0.3, steady: 0.24, pace: 0.2, slow_down: 0.16 }
    }
    const rate = relevance[key]?.[actionKey] || 0.15
    return clampNumber((value - 118) * 0.045 * rate, 0, 7)
  }

  getStageActionRate(actionKey, stageKey, trackId) {
    const table = {
      start: { speed_up: 1.15, inside: 1.18, steady: 1.08, burst: 0.92, slow_down: 0.72, pace: 0.9 },
      mid: { slow_down: 1.15, follow: 1.15, pace: 1.18, inside: 1.08, speed_up: 0.95, burst: 0.86 },
      finish: { burst: 1.28, speed_up: 1.16, gamble: 1.18, follow: 0.9, pace: 0.78, slow_down: 0.65 }
    }
    let rate = table[stageKey]?.[actionKey] || 1
    if (trackId === "short_sprint" && ["speed_up", "burst"].includes(actionKey)) rate += 0.08
    if (trackId === "endurance" && ["pace", "slow_down", "follow"].includes(actionKey)) rate += 0.08
    if (trackId === "many_corners" && ["inside", "steady"].includes(actionKey)) rate += 0.08
    if (trackId === "rain_mud" && ["steady", "pace"].includes(actionKey)) rate += 0.08
    return rate
  }

  getDefaultStageAction(runner) {
    return this.getDefaultStageActionForStage(runner, { key: "mid" })
  }

  getAttributeSpecialty(attributes = {}) {
    const ranked = ATTRIBUTE_DEFS
      .map(def => ({ key: def.key, value: Number(attributes[def.key]) || 0 }))
      .sort((a, b) => b.value - a.value)
    const top = ranked[0] || { key: "focus", value: 0 }
    const second = ranked[1] || { value: 0 }
    return {
      key: top.key,
      value: top.value,
      gap: top.value - second.value,
      isClear: top.value >= 28 && top.value - second.value >= 8
    }
  }

  getSpecialtyAction(runner = {}, stage = {}) {
    const specialty = this.getAttributeSpecialty(runner.attributes || {})
    if (!specialty.isClear) return null
    const stageKey = stage?.key || "mid"
    const table = {
      speed: { start: "speed_up", mid: "speed_up", finish: "speed_up" },
      stamina: { start: "steady", mid: "pace", finish: "pace" },
      power: { start: "speed_up", mid: "follow", finish: "burst" },
      focus: { start: "steady", mid: "steady", finish: "follow" },
      wisdom: { start: "inside", mid: "follow", finish: "inside" },
      luck: { start: "gamble", mid: "gamble", finish: "gamble" }
    }
    return table[specialty.key]?.[stageKey] || null
  }

  getDefaultStageActionForStage(runner = {}, stage = {}, beforeRank = null, room = null) {
    const dynamic = this.getDynamicStageAction(runner, stage, beforeRank, room)
    if (dynamic) return dynamic
    const strategyKey = runner.strategyKey || "normal"
    const specialtyAction = this.getSpecialtyAction(runner, stage)
    if (specialtyAction && ["normal", "burst", "conserve"].includes(strategyKey)) {
      if (strategyKey === "burst" && stage?.key === "finish") return specialtyAction === "gamble" ? "gamble" : "burst"
      if (strategyKey === "conserve" && stage?.key !== "start") return specialtyAction === "gamble" ? "gamble" : "pace"
      return specialtyAction
    }
    return STRATEGY_DEFAULT_ACTIONS[strategyKey] || "steady"
  }

  getDynamicStageAction(runner = {}, stage = {}, beforeRank = null, room = null) {
    const race = runner.race || {}
    const rank = Number(beforeRank) || 1
    const stageKey = stage?.key || "mid"
    const gap = room ? this.getRaceGapContext(runner, room) : { previousGap: 0, leaderGap: 0, rank }
    const specialty = this.getAttributeSpecialty(runner.attributes || {})

    if (race.stamina < 22) return stageKey === "finish" ? "slow_down" : "pace"
    if (race.rhythm < 24) return rank <= 3 ? "steady" : "follow"
    if (race.burstReserve < 22 && ["burst", "gamble"].includes(this.getSpecialtyAction(runner, stage))) {
      return stageKey === "finish" ? "speed_up" : "steady"
    }

    if (rank >= 5 || gap.leaderGap >= 120 || gap.previousGap >= 72) {
      if (stageKey === "finish") {
        if (specialty.key === "luck" && race.luckState > 28) return "gamble"
        if (race.burstReserve > 38 || specialty.key === "power") return "burst"
        return "speed_up"
      }
      if (stageKey === "mid") {
        if (gap.previousGap <= 150) return "follow"
        if (specialty.key === "luck" && race.luckState > 36) return "gamble"
        return "speed_up"
      }
      return specialty.key === "wisdom" ? "inside" : "speed_up"
    }

    if (rank <= 3 && stageKey === "finish") {
      if (race.stamina > 55 && race.burstReserve > 45 && specialty.key === "power") return "burst"
      if (race.rhythm < 42) return "steady"
    }

    return null
  }

  pickNpcStageAction(runner, beforeRank, stage, room = null) {
    const race = runner.race
    if (race.stamina < 32) return pick(["slow_down", "pace", "steady"])
    if (race.rhythm < 32) return pick(["steady", "follow", "slow_down"])
    const dynamic = this.getDynamicStageAction(runner, stage, beforeRank, room)
    if (dynamic) return dynamic
    if (stage.key === "finish") return beforeRank <= 3 ? pick(["speed_up", "burst", "steady"]) : pick(["burst", "gamble", "speed_up"])
    if (stage.key === "mid") return beforeRank <= 3 ? pick(["follow", "pace", "steady"]) : pick(["inside", "speed_up", "follow"])
    return this.getDefaultStageActionForStage(runner, stage)
  }

  rankRunners(runners = []) {
    return [...runners].sort((a, b) =>
      (b.race?.distance || b.race?.position || 0) - (a.race?.distance || a.race?.position || 0) ||
      (b.race?.velocity || 0) - (a.race?.velocity || 0)
    )
  }

  formatRaceStage(room, { opening = false, includeTips = true } = {}) {
    const stage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]
    const stageCount = `${room.stageIndex + 1}/${RACE_STAGES.length}`
    const lines = [
      opening ? "比赛开跑。" : `${stage.label}开始。`,
      this.formatTrack(room.track),
      `场地状态：${room.condition?.name || "维护良好"} - ${room.condition?.description || "赛道状态稳定。"}`,
      `复合场景：${this.formatRaceSceneName(room)}`,
      `当前阶段：${stage.label}（${stageCount}）- ${stage.prompt}`,
      room.stageIndex === 0 ? `临场变化：${room.twist.name} - ${room.twist.description}` : `赛况事件：${room.scene.name} - ${room.scene.description}`,
      "",
      "当前队形：",
      ...this.formatStageRanking(room.runners),
      ""
    ]
    if (includeTips) lines.push(this.formatRaceActionTips())
    return lines.join("\n").trim()
  }

  formatActiveRaceStatus(room) {
    const stage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]
    return [
      `这一局已经开跑了，当前是${stage.label}。`,
      `复合场景：${this.formatRaceSceneName(room)}`,
      "当前队形：",
      ...this.formatStageRanking(room.runners || []),
      "",
      this.formatRaceActionTips()
    ].join("\n")
  }

  formatStageRanking(runners = []) {
    return this.rankRunners(runners).slice(0, RACE_SIZE).map((runner, index) =>
      `${index + 1}. ${this.formatRunnerName(runner)}｜${this.describeRunnerState(runner)}`
    )
  }

  describeRunnerState(runner) {
    const race = runner?.race || {}
    const breath = race.stamina >= 86
      ? "呼吸很稳"
      : race.stamina >= 62
        ? "已经轻微喘气"
        : race.stamina >= 36
          ? "气息明显乱了"
          : "像是快被体力拖住了"
    const rhythm = race.rhythm >= 86
      ? "步点很干净"
      : race.rhythm >= 62
        ? "节奏还压得住"
        : race.rhythm >= 36
          ? "步伐有点散"
          : "节奏被拉得很碎"
    const route = race.route >= 82
      ? "贴着舒服路线"
      : race.route >= 55
        ? "还在找空档"
        : "有点被堵在外侧"
    const burst = race.burstReserve >= 78
      ? "还藏着冲刺劲"
      : race.burstReserve >= 42
        ? "余力还够再顶一下"
        : "爆发余力不多"
    return `${breath}，${rhythm}，${route}，${burst}`
  }

  async renderRaceReportOrFallback(e, report, fallbackText) {
    try {
      // 懒加载渲染器:它静态依赖 Yunzai 运行时的 lib/puppeteer,非 Yunzai 环境
      // (单测/独立工具)下加载失败会落到这里的文本兜底,而不是让整个模块崩掉
      const { renderUmaRaceReport } = await import("./UmaRaceReportRenderer.js")
      const image = await renderUmaRaceReport(e, report)
      if (!image) throw new Error("empty render result")
      return image
    } catch (error) {
      this.logger?.warn?.(`[赛马娘小游戏] 渲染比赛报告失败: ${error.message}`)
      return fallbackText
    }
  }

  appendMessageText(message, text) {
    if (!text) return message
    if (typeof message === "string") return [message, `\n${text}`]
    if (Array.isArray(message)) return [...message, `\n${text}`]
    return [message, `\n${text}`]
  }

  buildStageRaceReport(room, previousStage, lines = []) {
    const currentStage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]
    return {
      type: "stage",
      title: `${previousStage.label}结束`,
      subtitle: `进入${currentStage.label}：${currentStage.prompt}`,
      scene: [room.track.name, room.condition?.name, room.twist.name, room.scene.name].filter(Boolean).join(" / "),
      generatedAt: this.formatReportTime(),
      prompt: "当前队形已更新，下一段可以调整跑法。",
      ranking: this.buildRaceReportRanking(room.runners),
      highlights: lines.slice(0, 5)
    }
  }

  buildOpeningRaceReport(room) {
    const currentStage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]
    return {
      type: "stage",
      title: "比赛开跑",
      subtitle: `${currentStage.label}：${currentStage.prompt}`,
      scene: [room.track.name, room.condition?.name, room.twist.name, room.scene.name].filter(Boolean).join(" / "),
      generatedAt: this.formatReportTime(),
      prompt: `复合场景：${this.formatRaceSceneName(room)}。${currentStage.prompt}`,
      ranking: this.buildRaceReportRanking(room.runners),
      highlights: [
        this.formatTrack(room.track).replace(/^本局赛道：/, "赛道："),
        `场地状态：${room.condition?.name || "维护良好"} - ${room.condition?.description || "赛道状态稳定。"}`,
        `复合场景：${this.formatRaceSceneName(room)}`,
        `临场变化：${room.twist.name} - ${room.twist.description}`
      ]
    }
  }

  buildFinalRaceReport(result, awardLines = []) {
    return {
      type: "final",
      title: "赛马结果出炉",
      subtitle: this.formatTrack(result.track).replace(/^本局赛道：/, ""),
      scene: [result.track.name, result.condition?.name, result.twist.name, result.scene.name].filter(Boolean).join(" / "),
      generatedAt: this.formatReportTime(),
      prompt: "前三名获得全群互通积分，其余真实玩家获得参与奖。",
      ranking: this.buildRaceReportRanking(result.ranking),
      highlights: (result.highlights || []).slice(0, 5),
      awards: awardLines.length ? awardLines : ["本局无人获得积分"],
      proficiencyGains: result.proficiencyGains || []
    }
  }

  buildRaceReportRanking(runners = []) {
    const ranked = this.rankRunners(runners).slice(0, RACE_SIZE)
    return ranked.map((runner, index) => {
      const distance = Number(runner.race?.distance ?? runner.race?.position) || 0
      const previous = index > 0 ? ranked[index - 1] : null
      const previousDistance = previous ? Number(previous.race?.distance ?? previous.race?.position) || 0 : distance
      const gapToPrevious = Math.max(0, previousDistance - distance)
      return {
        rank: index + 1,
        name: runner.umaName || runner.nickname || "无名小马",
        affix: this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner),
        isNpc: !!runner.isNpc,
        gapToPrevious,
        gapText: this.formatRaceGapText(gapToPrevious, index),
        meta: [runner.traitLabel ? `特质：${runner.traitLabel}` : "", this.formatTraitAffinity(runner)].filter(Boolean).join("｜"),
        strategy: runner.strategyLabel || "正常跑",
        state: this.describeRunnerState(runner)
      }
    })
  }

  formatRaceGapText(gapToPrevious = 0, index = 0) {
    if (index === 0) return "领先"
    const meters = Math.max(0, Number(gapToPrevious) || 0)
    if (meters < 3) return "贴身"
    const bodyLengths = meters / 6
    if (bodyLengths >= 15) return "被拉开很远"
    if (bodyLengths >= 8) return `差 ${bodyLengths.toFixed(0)} 身位`
    return `差 ${bodyLengths.toFixed(1)} 身位`
  }

  formatReportTime() {
    return new Date().toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    })
  }

  async finishStagedRace(room) {
    this.clearStageTimer(room)
    const ranking = this.rankRunners(room.runners)
    this.rooms.delete(String(room.groupId || ""))
    const config = this.getConfig()
    const awardLines = await this.applyAwards(ranking, this.getAwards(config), config)
    const proficiencyGains = await this.applyProficiencyGains(ranking, config)
    const result = {
      ranking,
      track: room.track,
      condition: room.condition,
      twist: room.twist,
      scene: room.scene,
      proficiencyGains,
      highlights: [
        ...this.buildRaceReviewLines(ranking),
        ...room.history.flatMap(item => item.lines).slice(-5),
        pick(room.track.events).replace("{name}", ranking[0]?.nickname || "前排")
      ].slice(0, 5)
    }
    return await this.renderRaceReportOrFallback(
      room.event,
      this.buildFinalRaceReport(result, awardLines),
      [
        this.formatRaceResult(result, awardLines),
        this.formatProficiencyGainLines(proficiencyGains)
      ].filter(Boolean).join("\n\n")
    )
  }

  fillNpcPlayers(players, minPlayers) {
    const need = Math.max(0, Number(minPlayers) - players.length)
    const usedNames = new Set(players.map(player => player.nickname))
    const usedUmaNames = new Set(players.map(player => player.umaName || player.nickname))
    const baseTotal = this.getNpcBaseAttributeTotal(players)
    for (let index = 0; index < need; index++) {
      const name = this.pickNpcName(usedNames)
      const umaName = this.pickNpcUmaName(usedUmaNames)
      const personality = pick(["稳重可靠", "活泼开朗", "不服输", "聪明冷静", "耐心坚韧", "幸运自由"])
      const total = this.pickNpcAttributeTotal(baseTotal)
      usedNames.add(name)
      usedUmaNames.add(umaName)
      players.push({
        userId: `npc:${Date.now()}:${index}`,
        nickname: name,
        umaName,
        umaAffix: this.normalizeUmaAffix({}),
        attributes: this.generateAttributes(umaName, personality, total),
        personality,
        traitKey: this.inferPersonalityTrait(umaName, personality).key,
        traitLabel: this.inferPersonalityTrait(umaName, personality).label,
        strategyKey: pick(["normal", "steady", "burst", "conserve", "inside"]),
        isNpc: true,
        joinedAt: Date.now()
      })
    }
  }

  pickNpcName(usedNames) {
    const available = NPC_NAMES.filter(name => !usedNames.has(name))
    return available.length ? pick(available) : `临时选手${usedNames.size + 1}`
  }

  pickNpcUmaName(usedNames) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const name = `${pick(NPC_UMA_PREFIXES)}${pick(NPC_UMA_SUFFIXES)}`
      if (!usedNames.has(name)) return name
    }
    return `临时赛马娘${usedNames.size + 1}`
  }

  getNpcBaseAttributeTotal(players = []) {
    const humans = players.filter(player => !player.isNpc && this.isValidAttributes(player.attributes))
    const totals = humans
      .map(player => this.sumAttributes(player.attributes))
      .filter(total => Number.isFinite(total) && total > 0)
    if (!totals.length) return ATTRIBUTE_TOTAL
    const average = totals.reduce((sum, total) => sum + total, 0) / totals.length
    const factor = humans.length <= 1 ? 0.82 : humans.length === 2 ? 0.88 : humans.length === 3 ? 0.94 : 1
    return average * factor
  }

  pickNpcAttributeTotal(baseTotal = ATTRIBUTE_TOTAL) {
    const min = Math.max(ATTRIBUTE_DEFS.length * 4, Math.floor(baseTotal * 0.9))
    const max = Math.max(min, Math.ceil(baseTotal * 1.1))
    return Math.floor(randomBetween(min, max + 1))
  }

  simulateRace(players, track = pick(TRACKS), twist = pick(RACE_TWISTS), scene = pick(RACE_SCENES), condition = pick(RACE_CONDITIONS)) {
    players = this.prepareRacePlayers(players)
    const room = {
      groupId: "simulate",
      phase: "race",
      track,
      condition,
      twist,
      scene,
      raceProfile: this.buildRaceProfile(track, twist, scene, condition),
      stageIndex: 0,
      decisions: new Map(),
      history: [],
      runners: this.initializeStageRunners(players, track, twist, scene, condition)
    }
    for (const stage of RACE_STAGES) {
      room.stageIndex = RACE_STAGES.findIndex(item => item.key === stage.key)
      const lines = this.resolveRaceStage(room, stage)
      room.history.push({ stage: stage.key, lines })
    }
    const ranking = this.rankRunners(room.runners)
    const highlights = [
      ...room.history.flatMap(item => item.lines).slice(-5),
      pick(track.events).replace("{name}", ranking[0]?.nickname || "前排")
    ].slice(0, 5)
    return { ranking, highlights, track, condition, twist, scene }
  }

  countStrategies(players) {
    const counts = new Map()
    for (const player of players) {
      const key = player.strategyKey && STRATEGIES[player.strategyKey] ? player.strategyKey : "normal"
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return counts
  }

  getRaceTrait(player = {}) {
    return PERSONALITY_TRAITS.find(trait => trait.key === player.traitKey) ||
      this.inferPersonalityTrait(player.umaName || player.nickname, player.personality || "")
  }

  normalizeProficiency(proficiency = {}) {
    const normalized = {}
    for (const key of Object.keys(RACE_ACTIONS)) {
      normalized[key] = clampNumber(proficiency?.[key], 0, PROFICIENCY_MAX)
    }
    return normalized
  }

  getProficiencyLevel(value = 0) {
    const amount = clampNumber(value, 0, PROFICIENCY_MAX)
    return PROFICIENCY_LEVELS.find(level => amount >= level.min) || PROFICIENCY_LEVELS[PROFICIENCY_LEVELS.length - 1]
  }

  getProficiencyProgress(value = 0) {
    const amount = clampNumber(value, 0, PROFICIENCY_MAX)
    const ascending = [...PROFICIENCY_LEVELS].sort((a, b) => a.min - b.min)
    let currentIndex = 0
    for (let i = 0; i < ascending.length; i++) {
      if (amount >= ascending[i].min) currentIndex = i
    }
    const current = ascending[currentIndex] || ascending[0]
    const next = ascending[currentIndex + 1] || null
    const target = next ? next.min : PROFICIENCY_MAX
    const base = current?.min || 0
    const span = Math.max(1, target - base)
    const progress = next
      ? clampNumber((amount - base) / span, 0, 1)
      : clampNumber(amount / PROFICIENCY_MAX, 0, 1)
    return {
      value: amount,
      level: current?.label || "生疏",
      levelIndex: currentIndex + 1,
      nextLevel: next?.label || "满值",
      target,
      need: next ? Math.max(0, target - amount) : Math.max(0, PROFICIENCY_MAX - amount),
      percent: Math.round(progress * 100)
    }
  }

  getActionProficiencyBonus(runner = {}, actionKey = "") {
    const value = Number(runner.proficiency?.[actionKey]) || 0
    return this.getProficiencyLevel(value).bonus || 0
  }

  recordActionProficiencyUse(runner = {}, actionKey = "", check = {}) {
    if (!runner || runner.isNpc || !RACE_ACTIONS[actionKey]) return
    if (!runner.race) runner.race = {}
    if (!Array.isArray(runner.race.actionUses)) runner.race.actionUses = []
    runner.race.actionUses.push({
      actionKey,
      grade: check.grade || "fail"
    })
  }

  calculateProficiencyGains(runner = {}) {
    const uses = Array.isArray(runner.race?.actionUses) ? runner.race.actionUses : []
    const actionCounts = new Map()
    const rawGains = new Map()
    for (const use of uses) {
      if (!RACE_ACTIONS[use.actionKey]) continue
      const count = actionCounts.get(use.actionKey) || 0
      actionCounts.set(use.actionKey, count + 1)
      const base = PROFICIENCY_REPEAT_GAINS[Math.min(count, PROFICIENCY_REPEAT_GAINS.length - 1)] || 0
      const checkGain = PROFICIENCY_CHECK_GAINS[use.grade] || 0
      rawGains.set(use.actionKey, (rawGains.get(use.actionKey) || 0) + base + checkGain)
    }

    const capped = [...rawGains.entries()]
      .map(([actionKey, gain]) => ({
        actionKey,
        gain: Math.min(PROFICIENCY_SINGLE_ACTION_CAP, gain)
      }))
      .filter(item => item.gain > 0)
      .sort((a, b) => b.gain - a.gain)

    let remaining = PROFICIENCY_TOTAL_RACE_CAP
    const result = []
    for (const item of capped) {
      if (remaining <= 0) break
      const gain = Math.min(item.gain, remaining)
      if (gain > 0) result.push({ actionKey: item.actionKey, gain })
      remaining -= gain
    }
    return result
  }

  getRaceTags(track = {}, twist = {}, scene = {}, condition = {}) {
    return new Set([
      ...(Array.isArray(track.tags) ? track.tags : []),
      ...(Array.isArray(condition.tags) ? condition.tags : []),
      ...(Array.isArray(twist.tags) ? twist.tags : []),
      ...(Array.isArray(scene.tags) ? scene.tags : [])
    ].filter(Boolean))
  }

  getTraitTagBonus(trait = {}, raceTags = new Set()) {
    let bonus = 0
    for (const tag of raceTags) {
      bonus += Number(trait.tagFit?.[tag]) || 0
    }
    return clampNumber(bonus, -4, 5)
  }

  getTraitBonus(trait, strategyKey, raceTags = new Set()) {
    return (Number(trait?.fit?.[strategyKey]) || 0) + this.getTraitTagBonus(trait, raceTags)
  }

  formatTraitAffinity(runner = {}) {
    const bonus = Number(runner.traitTagBonus) || 0
    if (bonus >= 2) return "适性：契合"
    if (bonus <= -2) return "适性：吃力"
    return "适性：普通"
  }

  rollAttributeValue(attribute, base = 48, scale = 5) {
    return base + (Number(attribute) || 0) * scale + randomBetween(0, 18)
  }

  getStrategyCrowdPenalty(strategyKey, strategyCounts, totalPlayers) {
    const count = strategyCounts.get(strategyKey) || 0
    if (count <= 1 || totalPlayers <= 2) return 0
    const crowdedRatio = count / totalPlayers
    if (crowdedRatio < 0.45) return 0
    return randomBetween(2, Math.min(14, 2 + (count - 1) * 4))
  }

  buildRunnerEvent(name, strategy, track, twist, scene, details = {}) {
    if (details.riskPenalty > 0) {
      return `${name} 选择${strategy.label}，但这次有点用力过猛，节奏被打乱了一段。`
    }
    if (details.insideCrowdPenalty > 0) {
      return `${name} 选择抢内道，可这局人太多，刚进弯道就被堵了一下。`
    }
    if (details.strategyCrowdPenalty > 0) {
      return `${name} 也选了${strategy.label}，但同策略的人太多，节奏互相挤在一起。`
    }
    if (details.twistBonus >= 6) {
      return (twist.event || "{name} 抓住了临场变化。").replace("{name}", name)
    }
    if (details.twistBonus <= -6) {
      return `${name} 选择${strategy.label}，但临场变化是${twist.name}，这次有点被克到了。`
    }
    if (details.sceneBonus >= 6) {
      return (scene.event || "{name} 抓住了赛况变化。").replace("{name}", name)
    }
    if (details.sceneBonus <= -6) {
      return `${name} 选择${strategy.label}，但赛况是${scene.name}，这次处理起来很别扭。`
    }
    if (details.traitBonus >= 7) {
      return `${name} 的${details.traitLabel || "性格"}刚好适合这一局，跑法明显更顺。`
    }
    if (Math.abs(details.conditionBonus) >= 4) {
      return this.formatConditionEvent(name, details.conditionBonus)
    }
    if (details.fitBonus >= 8) {
      return `${name} 选择${strategy.label}，刚好很适合${track.name}，优势越跑越明显。`
    }
    if (details.fitBonus <= -7) {
      return `${name} 选择${strategy.label}，但和${track.name}不太合拍，中段有点吃亏。`
    }
    return strategy.event.replace("{name}", name)
  }

  formatConditionEvent(name, conditionBonus) {
    const item = CONDITION_EVENTS.find(event => conditionBonus >= event.min) || CONDITION_EVENTS[CONDITION_EVENTS.length - 1]
    return item.text.replace("{name}", name)
  }

  buildRaceHighlights(runners, track, twist, scene) {
    const top = runners.slice(0, Math.min(4, runners.length))
    const highlightSet = new Set()
    highlightSet.add(`临场变化：${twist.name} - ${twist.description}`)
    highlightSet.add(`赛况事件：${scene.name} - ${scene.description}`)
    highlightSet.add(pick(track.events).replace("{name}", top[0]?.nickname || "前排"))
    for (const runner of top) {
      if (runner?.event) highlightSet.add(runner.event)
      if (highlightSet.size >= 5) break
    }
    return [...highlightSet].slice(0, 5)
  }

  getAwards(config) {
    return [config.winPoints, config.secondPoints, config.thirdPoints]
  }

  async applyProficiencyGains(ranking = [], config = this.getConfig()) {
    const data = this.readPoints(config)
    const results = []
    for (const runner of ranking) {
      if (runner.isNpc) continue
      const gains = this.calculateProficiencyGains(runner)
      if (!gains.length) continue
      const record = data.players?.[runner.userId]
      if (!record?.uma) continue
      const proficiency = this.normalizeProficiency(record.uma.proficiency)
      const displayed = []
      for (const item of gains) {
        const before = Number(proficiency[item.actionKey]) || 0
        const after = Math.min(PROFICIENCY_MAX, before + item.gain)
        proficiency[item.actionKey] = after
        if (after > before) {
          displayed.push({
            actionKey: item.actionKey,
            label: RACE_ACTIONS[item.actionKey]?.label || item.actionKey,
            gain: after - before,
            before,
            after,
            progress: this.getProficiencyProgress(after)
          })
        }
      }
      if (!displayed.length) continue
      record.uma.proficiency = proficiency
      record.updatedAt = nowIso()
      data.players[runner.userId] = record
      results.push({
        userId: runner.userId,
        nickname: runner.nickname,
        umaName: runner.umaName || runner.nickname,
        gains: displayed.slice(0, 3)
      })
    }
    if (results.length) await this.writePoints(data, config)
    return results
  }

  formatProficiencyGainLines(entries = []) {
    if (!entries.length) return ""
    const lines = entries.map(entry => {
      const gains = (entry.gains || [])
        .map(item => `${item.label} +${item.gain}（${item.progress?.level || "生疏"} ${item.after}/${item.progress?.target || PROFICIENCY_MAX}）`)
        .join("，")
      return `${entry.umaName || entry.nickname}：${gains}`
    })
    return ["熟练度提升：", ...lines].join("\n")
  }

  async applyAwards(ranking, awards, config) {
    const data = this.readPoints(config)
    const lines = []
    ranking.forEach((runner, index) => {
      const points = awards[index] || 0
      const participationPoints = Number(config.participationPoints) || 0
      if (runner.isNpc) {
        if (points > 0) lines.push(`${index + 1}. ${runner.nickname} 是NPC，不计入积分`)
        return
      }
      const record = data.players[runner.userId] || {
        userId: runner.userId,
        nickname: runner.nickname,
        points: 0,
        wins: 0,
        races: 0,
        podiums: 0,
        updatedAt: nowIso()
      }
      record.nickname = runner.nickname
      record.races = (Number(record.races) || 0) + 1
      if (index === 0) record.wins = (Number(record.wins) || 0) + 1
      if (index <= 2) record.podiums = (Number(record.podiums) || 0) + 1
      if (points > 0) {
        record.points = (Number(record.points) || 0) + points
        lines.push(`${index + 1}. ${runner.nickname} +${points}`)
      } else if (participationPoints > 0) {
        record.points = (Number(record.points) || 0) + participationPoints
        lines.push(`${index + 1}. ${runner.nickname} 参与奖 +${participationPoints}`)
      } else {
        record.points = Number(record.points) || 0
      }
      record.updatedAt = nowIso()
      data.players[runner.userId] = record
    })
    await this.writePoints(data, config)
    return lines
  }

  formatRaceResult(result, awardLines) {
    const rankingLines = result.ranking.slice(0, 8).map((runner, index) =>
      `${index + 1}. ${this.formatRaceRunnerName(runner)}（${runner.strategyLabel || "正常跑"}）`
    )
    return [
      "赛马结果出炉：",
      this.formatTrack(result.track),
      `场地状态：${result.condition?.name || "维护良好"} - ${result.condition?.description || "赛道状态稳定。"}`,
      `复合场景：${[result.track.name, result.condition?.name, result.twist.name, result.scene.name].filter(Boolean).join(" + ")}`,
      ...result.highlights.map(line => `- ${line}`),
      "",
      "名次：",
      ...rankingLines,
      "",
      awardLines.length ? `积分：\n${awardLines.join("\n")}` : "积分：本局无人获得积分"
    ].join("\n")
  }

  buildRaceReviewLines(ranking = []) {
    const lines = []
    const top = ranking[0]
    if (top) {
      const action = RACE_ACTIONS[top.race?.lastActionKey]?.label || top.strategyLabel || "跑法"
      const distance = Math.round(Number(top.race?.lastDelta?.distance) || 0)
      lines.push(`本局关键点：${top.umaName || top.nickname} 最后一段用「${action}」稳住优势，推进约 ${distance}m。`)
    }

    const comeback = ranking
      .filter(runner => runner !== top)
      .map(runner => ({
        runner,
        delta: Number(runner.race?.lastDelta?.distance) || 0,
        action: runner.race?.lastActionKey || ""
      }))
      .sort((a, b) => b.delta - a.delta)[0]
    if (comeback?.runner && comeback.delta >= 280) {
      lines.push(`${comeback.runner.umaName || comeback.runner.nickname} 末段追回得很凶，但前面积累的差距还没完全抹平。`)
    }

    const tired = ranking.find(runner => (Number(runner.race?.stamina) || 0) < 32 || (Number(runner.race?.rhythm) || 0) < 32)
    if (tired) {
      lines.push(`${tired.umaName || tired.nickname} 后段状态被拖住，体力或节奏成了主要问题。`)
    }

    return lines.slice(0, 3)
  }

  formatRunnerName(runner) {
    return this.formatRaceRunnerName(runner)
  }

  showScore(e) {
    const userId = String(e?.user_id || e?.sender?.user_id || "")
    if (!userId) return "没拿到你的 QQ 号。"
    const data = this.readPoints()
    const record = data.players[userId]
    if (!record) return "你还没有赛马积分。"
    return [
      `${record.nickname || userId} 的赛马积分：${Number(record.points) || 0}`,
      `胜场：${Number(record.wins) || 0}，参赛：${Number(record.races) || 0}，前三：${Number(record.podiums) || 0}`
    ].join("\n")
  }

  parseScoreAdjustInput(msg = "") {
    const text = String(msg || "")
      .replace(/^[.。]赛马娘\s*(加积分|改积分|调整积分)\s*/u, "")
      .trim()
    const qq = text.match(/\b\d{5,12}\b/)?.[0]
    const numberMatches = [...text.matchAll(/[+-]?\d+/g)].map(match => match[0])
    const amountText = numberMatches.find(value => value !== qq)
    const amount = Number(amountText)
    if (!qq || !Number.isFinite(amount)) return null
    return { userId: qq, amount }
  }

  async adjustScore(e) {
    if (!e?.isMaster) return "只有主人可以调整赛马娘积分。"
    const parsed = this.parseScoreAdjustInput(e?.msg)
    if (!parsed) {
      return [
        "格式：.赛马娘 加积分 QQ 分数",
        "例：.赛马娘 加积分 123456789 10",
        "扣分也可以用负数：.赛马娘 加积分 123456789 -5"
      ].join("\n")
    }

    const config = this.getConfig()
    const data = this.readPoints(config)
    const existing = data.players?.[parsed.userId]
    const before = Number(existing?.points) || 0
    const after = before + parsed.amount
    const record = existing || {
      userId: parsed.userId,
      nickname: parsed.userId,
      points: 0,
      wins: 0,
      races: 0,
      podiums: 0,
      updatedAt: nowIso()
    }

    record.points = after
    record.updatedAt = nowIso()
    data.players[parsed.userId] = record
    await this.writePoints(data, config)

    return [
      "赛马娘积分已调整。",
      `QQ：${parsed.userId}`,
      `变动：${parsed.amount >= 0 ? "+" : ""}${parsed.amount}`,
      `积分：${before} -> ${after}`
    ].join("\n")
  }

  showRank(limit) {
    const config = this.getConfig()
    const finalLimit = safeNumber(limit, config.rankLimit, 3, 50)
    const data = this.readPoints(config)
    const ranking = Object.values(data.players || {})
      .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0) || (Number(b.wins) || 0) - (Number(a.wins) || 0))
      .slice(0, finalLimit)

    if (!ranking.length) return "现在还没有赛马积分排行。"
    return [
      "赛马积分排行：",
      ...ranking.map((item, index) =>
        `${index + 1}. ${item.nickname || item.userId}：${Number(item.points) || 0} 分 / ${Number(item.wins) || 0} 胜`
      )
    ].join("\n")
  }

  showHelp() {
    return [
      "赛马娘小游戏：",
      ".赛马娘 领养 名字 性格描述 - 创建自己的赛马娘",
      ".赛马娘 我的赛马娘 - 查看六维属性",
      ".赛马娘 弃养 - 删除当前小马档案，保留积分",
      ".赛马娘 训练 - 进入训练页面",
      ".赛马娘 词条 - 查看当前词条",
      ".赛马娘 重铸 - 消耗积分立即重铸词条，不能反悔",
      ".赛马娘 词条池 - 查看所有词条品级",
      ".赛马娘 开始 - 开一局",
      ".赛马娘 加入 [策略] - 报名，可选策略",
      "策略：稳一点 / 拼一把 / 留体力 / 抢内道；不填就是正常跑",
      ".赛马娘 开跑 - 开始三段比赛",
      ".赛马娘 决策 [行动] - 每个阶段调整一次跑法，也可用 .赛马娘 策略 [行动]",
      "行动：提速 / 减速 / 稳住 / 抢位 / 爆发 / 赌一把 / 跟跑 / 压节奏",
      ".赛马娘 积分 - 查看自己的全群互通积分",
      ".赛马娘 排行 - 查看全局排行"
    ].join("\n")
  }
}

export const umaRaceManager = new UmaRaceManager()
