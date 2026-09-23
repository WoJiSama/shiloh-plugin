import { fileURLToPath } from "node:url"

export const DICE_COMMAND_PREFIX_PATTERN = "[.。]"

function exactRule(headPattern) {
  return `^${DICE_COMMAND_PREFIX_PATTERN}(?:${headPattern})\\s*$`
}

function argumentRule(headPattern, { allowCompactLatin = false } = {}) {
  const compactBoundary = allowCompactLatin ? "" : "(?![A-Za-z])"
  return `^${DICE_COMMAND_PREFIX_PATTERN}(?:${headPattern})${compactBoundary}[\\s\\S]*$`
}

function knownCompactLatinRule(headPattern, compactArgs = []) {
  const compactPattern = compactArgs.join("|")
  return `^${DICE_COMMAND_PREFIX_PATTERN}(?:${headPattern})(?:(?=(?:${compactPattern})(?:[^A-Za-z]|$))|(?=[^A-Za-z]|$))[\\s\\S]*$`
}

/**
 * Dice command routing policy shared by the plugin entry and regression tests.
 *
 * Rules accept both ASCII/full-width Chinese periods. Arguments may be joined
 * directly to a command when they start with Chinese text, a number or normal
 * dice punctuation. Latin text can still be supplied after whitespace. Known
 * compact subcommands such as `.pcnew` are explicitly allowed so a short
 * command cannot accidentally consume another Latin command such as `.rabc`.
 */
export const DICE_COMMAND_RULES = Object.freeze([
  { reg: exactRule("dice"), fnc: "diceHubMenu" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}dice\\s+(?:import|导入|教程)(?:\\s+(\\S+))?\\s*$`, fnc: "diceImportHub" },
  { reg: exactRule("骰娘|dice"), fnc: "showHelp" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}(?:骰娘|dice)\\s*(?:帮助|help)\\s*$`, fnc: "showHelp" },
  { reg: argumentRule("骰规则|dice\\s*rule", { allowCompactLatin: true }), fnc: "manageDiceRules" },
  { reg: argumentRule("help|帮助", { allowCompactLatin: true }), fnc: "help" },
  { reg: knownCompactLatinRule("bot|dismiss|bye", ["on", "off", "bye", "dismiss"]), fnc: "botControl" },
  { reg: knownCompactLatinRule("reply", ["on", "off"]), fnc: "replyControl" },
  { reg: argumentRule("send", { allowCompactLatin: true }), fnc: "sendToMaster" },
  { reg: argumentRule("find", { allowCompactLatin: true }), fnc: "findEntry" },
  { reg: argumentRule("draw|抽牌"), fnc: "drawCard" },
  { reg: knownCompactLatinRule("set(?!coc)", ["d\\d+", "coc7?", "dnd5e", "dnd"]), fnc: "setDiceOption" },
  { reg: knownCompactLatinRule("sn", ["on", "off"]), fnc: "sn" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}log\\s*(?:on|start|开始|开启)(?![A-Za-z])[\\s\\S]*$`, fnc: "logStart" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}log\\s*(?:new|新建|create)(?![A-Za-z])[\\s\\S]*$`, fnc: "logNew" },
  // off/end 容忍尾部参数：群里习惯带团名（.log off 至死方休），锚死结尾会静默吞掉命令。
  // end 必须排在 off/结束 之前，否则「结束并导出」会被 off 的「结束」前缀截走。
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}log\\s*(?:end|结束并导出)(?![A-Za-z])[\\s\\S]*$`, fnc: "logEnd" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}log\\s*(?:off|stop|结束|关闭)(?![A-Za-z])[\\s\\S]*$`, fnc: "logStop" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}log\\s*(?:status|状态)?\\s*$`, fnc: "logStatus" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}log\\s*(?:export|get|导出|获取)(?![A-Za-z])[\\s\\S]*$`, fnc: "logExport" },
  { reg: argumentRule("ri"), fnc: "initiativeRoll" },
  { reg: knownCompactLatinRule("init|先攻", ["list", "show", "clear", "clr", "del", "rm"]), fnc: "initiative" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}(?:r(?![A-Za-z])|roll)[\\s\\S]*$`, fnc: "roll" },
  { reg: argumentRule("rsr", { allowCompactLatin: true }), fnc: "rsr" },
  { reg: argumentRule("ww"), fnc: "ww" },
  { reg: argumentRule("dx"), fnc: "dx" },
  { reg: argumentRule("ekgen"), fnc: "ekgen" },
  { reg: argumentRule("ek"), fnc: "ek" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}bp(?:\\d+)?(?![A-Za-z])[\\s\\S]*$`, fnc: "bonusRoll" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}pp(?:\\d+)?(?![A-Za-z])[\\s\\S]*$`, fnc: "penaltyRoll" },
  { reg: argumentRule("rav"), fnc: "opposed" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}(?:rab|rap|rahb|rahp|rah|ra)(?:\\d+)?#?(?:b|p)?(?![A-Za-z+\\-])[\\s\\S]*$`, fnc: "seaCocCheck" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}(?:ra|rc)[+\\-]?\\d+(?![A-Za-z])[\\s\\S]*$`, fnc: "numberedCheck" },
  { reg: argumentRule("ra|rc"), fnc: "check" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}rb(?:\\d+)?(?![A-Za-z])[\\s\\S]*$`, fnc: "bonusCheck" },
  { reg: `^${DICE_COMMAND_PREFIX_PATTERN}rp(?:\\d+)?(?![A-Za-z])[\\s\\S]*$`, fnc: "penaltyCheck" },
  { reg: argumentRule("rh|rah"), fnc: "hiddenCheck" },
  { reg: argumentRule("sc"), fnc: "sanCheck" },
  { reg: argumentRule("en"), fnc: "enCheck" },
  { reg: argumentRule("coc7?|天命"), fnc: "coc" },
  { reg: argumentRule("dnd5e?|dnd"), fnc: "dnd" },
  { reg: argumentRule("buff|ss|cast|longrest|ds"), fnc: "dndUtility" },
  { reg: argumentRule("namednd"), fnc: "nameDnd" },
  { reg: exactRule("jrrp|今日人品"), fnc: "jrrp" },
  { reg: argumentRule("db|伤害加值"), fnc: "db" },
  { reg: argumentRule("st"), fnc: "st" },
  { reg: knownCompactLatinRule("pc", ["list", "new", "save", "use", "load", "del", "tag", "lock", "unlock"]), fnc: "pc" },
  { reg: argumentRule("nn", { allowCompactLatin: true }), fnc: "nn" },
  { reg: argumentRule("setcoc"), fnc: "setCoc" },
  { reg: exactRule("ti"), fnc: "ti" },
  { reg: exactRule("li"), fnc: "li" }
])

export function normalizeDiceCommandText(input = "") {
  const text = String(input || "")
  return text.startsWith("。") ? `.${text.slice(1)}` : text
}

export function stripDiceCommand(input, headPattern) {
  return normalizeDiceCommandText(input)
    .replace(new RegExp(`^\\.${headPattern}\\s*`, "i"), "")
    .trim()
}

export function matchDiceCommand(input, bodyPattern, flags = "i") {
  return normalizeDiceCommandText(input).match(new RegExp(`^\\.${bodyPattern}$`, flags))
}


/**
 * 解析 docs/dice-rules 下的文档绝对路径（.dice import 发送用）。
 */
export function resolveDiceDocPath(relativeName) {
  return fileURLToPath(new URL(`../../docs/dice-rules/${relativeName.replace(/^(\/|\.)\/+/, "")}`, import.meta.url))
}
