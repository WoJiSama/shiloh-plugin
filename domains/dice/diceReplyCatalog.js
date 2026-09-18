export const DEFAULT_TEMPLATES = {
  roll: "{name} 掷骰：{expr}={detail}={total}",
  check: "{name} 进行 {skill} 检定：{diceText}={roll}/{target} {level}",
  check_critical: "",
  check_extreme: "",
  check_hard: "",
  check_success: "",
  check_fail: "",
  check_fumble: "",
  hiddenPublic: "{name} 进行了一次暗骰，结果已私聊发送。",
  hiddenPrivate: "暗骰结果：\n{result}",
  san: "{name} SAN Check：{diceText}={roll}/{target} {level}，理智损失 {loss}，剩余 {sanAfter}{insanity}",
  en: "{name} 进行 {skill} 成长检定：1D100={roll}/{target} {result}",
  card: "{name} 的人物卡：\n{card}",
  cardSaved: "人物卡已更新：{updates}",
  coc: "COC7 调查员属性：\n{attributes}",
  opposed: "对抗检定：\n{left}\n{right}\n结果：{winner}",
  jrrp: "{name} 今日人品：{value}",
  db: "{name} 体格 {build}，伤害加值 {db}",
  dnd: "DND5E 属性：\n{attributes}",
  bonus: "{name} 掷{kind}：{diceText}={value}",
  insanity: "{kind}：{index}. {text}",
  error: "{message}"
}

export const DEFAULT_CHECK_LEVELS = {
  critical: "大成功",
  extreme: "极难成功",
  hard: "困难成功",
  success: "成功",
  fail: "失败",
  fumble: "大失败"
}

export const CHECK_LEVEL_KEYS = ["critical", "extreme", "hard", "success", "fail", "fumble"]

export const CHECK_LEVEL_LABELS = { ...DEFAULT_CHECK_LEVELS }

export const DEFAULT_TEMP_INSANITY = [
  "失忆：调查员发现自己只记得最后身处的安全地点。",
  "假性残疾：调查员暂时失明、失聪或失去肢体功能。",
  "暴力倾向：调查员陷入攻击冲动。",
  "偏执：调查员开始怀疑身边的人。",
  "重要之人：调查员把某人误认为重要之人。",
  "昏厥：调查员直接失去意识。",
  "逃避行为：调查员只想远离当前场景。",
  "歇斯底里：调查员大哭、大笑或尖叫。",
  "恐惧症：调查员获得一个临时恐惧症。",
  "躁狂症：调查员获得一个临时躁狂症。"
]

export const DEFAULT_INDEFINITE_INSANITY = [
  "失忆：调查员回过神来时已经身处陌生地点。",
  "被窃：调查员发现重要物品不见了。",
  "伤痕：调查员醒来时身上出现新的伤痕。",
  "暴力：调查员卷入了暴力冲突。",
  "极端信念：调查员执着于某个荒诞想法。",
  "重要之人：调查员极度依赖某位重要之人。",
  "被收容：调查员在安全机构或医院中醒来。",
  "逃避现实：调查员用极端方式逃避真相。",
  "恐惧症：调查员获得一个新的恐惧症。",
  "躁狂症：调查员获得一个新的躁狂症。"
]

function tpl(key, label, hint) {
  return { key, label, hint }
}

export const BUILTIN_RULES = [
  {
    id: "coc7",
    name: "COC 7版（克苏鲁的呼唤）",
    desc: "检定/理智/成长/疯狂全套，房规 .setcoc 0-5 可调",
    commands: [".ra", ".rav", ".rh", ".sc", ".en", ".st", ".pc", ".coc7", ".setcoc", ".ti", ".li"],
    hasLevels: true,
    hasInsanity: true,
    groups: [
      {
        command: ".ra",
        title: ".ra 检定",
        templates: [
          tpl("check", "默认（所有档位共用）", "{name} {skill} {diceText} {roll} {target} {level}"),
          tpl("check_critical", "大成功 · 整句发送", "留空则用默认模板；变量同默认"),
          tpl("check_extreme", "极难成功 · 整句发送", "留空则用默认模板"),
          tpl("check_hard", "困难成功 · 整句发送", "留空则用默认模板"),
          tpl("check_success", "成功 · 整句发送", "留空则用默认模板"),
          tpl("check_fail", "失败 · 整句发送", "留空则用上面的默认模板。要单独改失败发送，在这里写完整句子"),
          tpl("check_fumble", "大失败 · 整句发送", "留空则用上面的默认模板。要单独改大失败发送，在这里写完整句子")
        ]
      },
      {
        command: ".rh",
        title: ".rh 暗骰",
        templates: [
          tpl("hiddenPublic", "群内提示", "{name} {result}"),
          tpl("hiddenPrivate", "私聊结果", "{name} {result}")
        ]
      },
      {
        command: ".sc",
        title: ".sc SAN Check",
        templates: [tpl("san", "发送文案", "{name} {diceText} {roll} {target} {level} {loss} {sanAfter} {insanity}")]
      },
      {
        command: ".en",
        title: ".en 成长",
        templates: [tpl("en", "发送文案", "{name} {skill} {roll} {target} {result}")]
      },
      {
        command: ".st",
        title: ".st 人物卡",
        hint: "查卡/录卡发送文案在这里改。.st show、.st 侦查=60 都走这两条。",
        templates: [
          tpl("card", "查卡 / show", "{name} {card}"),
          tpl("cardSaved", "录卡成功", "{name} {updates}")
        ]
      },
      {
        command: ".rav",
        title: ".rav 对抗",
        templates: [tpl("opposed", "发送文案", "{left} {right} {winner}")]
      },
      {
        command: ".coc7",
        title: ".coc7 属性",
        templates: [tpl("coc", "发送文案", "{name} {attributes}")]
      },
      {
        command: ".ti / .li",
        title: ".ti / .li 疯狂",
        templates: [tpl("insanity", "发送文案", "{kind} {index} {text}")]
      },
      {
        command: ".pc",
        title: ".pc 多卡管理",
        templates: [],
        hint: "list/new/use/del 等提示目前是固定文案，暂不支持改发送。"
      },
      {
        command: ".setcoc",
        title: ".setcoc 房规",
        templates: [],
        hint: "房规说明目前是固定文案，暂不支持改发送。"
      }
    ]
  },
  {
    id: "dnd5e",
    name: "D&D 5e / 通用掷骰",
    desc: "属性生成、奖惩骰、通用掷骰",
    commands: [".dnd", ".r", ".bp", ".pp", ".db", ".jrrp"],
    groups: [
      {
        command: ".r",
        title: ".r 掷骰",
        templates: [tpl("roll", "发送文案", "{name} {expr} {detail} {total}")]
      },
      {
        command: ".dnd",
        title: ".dnd 属性生成",
        templates: [tpl("dnd", "发送文案", "{attributes}")]
      },
      {
        command: ".bp / .pp",
        title: ".bp / .pp 奖惩骰",
        templates: [tpl("bonus", "发送文案", "{name} {kind} {diceText} {value}")]
      },
      {
        command: ".db",
        title: ".db 伤害加值",
        templates: [tpl("db", "发送文案", "{name} {sum} {build} {db}")]
      },
      {
        command: ".jrrp",
        title: ".jrrp 今日人品",
        templates: [tpl("jrrp", "发送文案", "{name} {value}")]
      }
    ]
  },
  {
    id: "common",
    name: "通用显示",
    desc: "昵称和自动群名片，不绑定 COC/DND",
    commands: [".nn", ".sn"],
    groups: [{
      command: ".nn / .sn",
      title: ".nn / .sn 显示名",
      templates: [],
      hint: "这两条改的是骰娘显示名和自动群名片，不是掷骰发送文案。"
    }]
  },
  {
    id: "deck",
    name: "牌堆系统（海豹 deck 兼容）",
    desc: "牌堆文件放 config/decks/，支持 keys/list/search",
    commands: [".draw"],
    groups: [{
      command: ".draw",
      title: ".draw 抽牌",
      templates: [],
      hint: "此规则无需配置模板；牌堆文件放服务器 config/decks/ 目录。"
    }]
  }
]

export function mergeDiceReplyConfig(raw = {}) {
  const templates = { ...DEFAULT_TEMPLATES, ...(raw.templates && typeof raw.templates === "object" ? raw.templates : {}) }
  const checkLevels = { ...DEFAULT_CHECK_LEVELS }
  const rawLevels = raw.checkLevels && typeof raw.checkLevels === "object" ? raw.checkLevels : {}
  for (const key of CHECK_LEVEL_KEYS) {
    if (rawLevels[key] != null && String(rawLevels[key]).trim()) checkLevels[key] = String(rawLevels[key])
  }
  const rawTables = raw.insanityTables && typeof raw.insanityTables === "object" ? raw.insanityTables : {}
  return {
    templates,
    checkLevels,
    insanityTables: {
      temp: Array.isArray(rawTables.temp) ? rawTables.temp : DEFAULT_TEMP_INSANITY,
      indefinite: Array.isArray(rawTables.indefinite) ? rawTables.indefinite : DEFAULT_INDEFINITE_INSANITY
    }
  }
}

export function pickCheckTemplate(templates = {}, levelText = "", checkLevels = DEFAULT_CHECK_LEVELS) {
  const levels = { ...DEFAULT_CHECK_LEVELS, ...(checkLevels || {}) }
  for (const key of CHECK_LEVEL_KEYS) {
    if (levelText === levels[key]) {
      const specific = templates[`check_${key}`]
      if (String(specific || "").trim()) return specific
      break
    }
  }
  return templates.check || DEFAULT_TEMPLATES.check
}

export function cocRankToCompareRank(rank) {
  if (rank === 4) return 5
  if (rank === 3) return 4
  if (rank === 2) return 3
  if (rank === 1) return 2
  if (rank === -2) return 0
  return 1
}

export function buildDiceReplyPayload(diceSystem = {}) {
  const merged = mergeDiceReplyConfig(diceSystem || {})
  return {
    templates: merged.templates,
    checkLevels: merged.checkLevels,
    insanityTables: merged.insanityTables,
    builtin: BUILTIN_RULES,
    checkLevelMeta: CHECK_LEVEL_KEYS.map(key => ({ key, label: CHECK_LEVEL_LABELS[key] }))
  }
}
