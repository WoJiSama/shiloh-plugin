import { collectExpressionReferences, parseDiceRuleExpression } from "./DiceRuleExpression.js"
import { DICE_COMMAND_RULES } from "./diceCommandPolicy.js"

export const DICE_RULE_RUNTIME_VERSION = "2.0"
export const DICE_RULE_MAX_PACKAGE_BYTES = 64 * 1024

const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{2,47}$/
const ITEM_ID_PATTERN = /^[a-z][a-z0-9_]{0,47}$/
const FIELD_TYPES = new Set(["integer", "number", "string", "boolean"])
const ARGUMENT_TYPES = new Set([...FIELD_TYPES, "enum", "actor"])
const VALUE_ACTIONS = new Set(["set", "add", "subtract", "min", "max", "clamp", "clear"])
const STATUS_ACTIONS = new Set(["add_status", "remove_status"])
const ITEM_ACTIONS = new Set(["add_item", "remove_item", "equip", "unequip"])
const ABILITY_ACTIONS = new Set(["learn_ability", "forget_ability", "use_ability", "reset_ability"])
const ACTIONS = new Set([...VALUE_ACTIONS, ...STATUS_ACTIONS, ...ITEM_ACTIONS, ...ABILITY_ACTIONS])
const EXPRESSION_FUNCTIONS = new Set(["min", "max", "clamp", "abs", "floor", "ceil", "round", "sqrt", "pow", "if", "coalesce", "len", "dice", "cancel", "successes", "explode", "reroll", "pool"])
const PERMISSIONS = new Set(["player", "gm", "admin", "master"])
const VISIBILITIES = new Set(["public", "private", "gm"])
const ACTOR_KINDS = new Set(["self", "member", "npc"])
const ACTION_SCOPES = new Set(["actor", "target", "group"])
const STATUS_TICKS = new Set(["manual", "turn_start", "turn_end", "round_start", "round_end"])
const EVENT_NAMES = new Set(["session_start", "session_end", "round_start", "round_end", "turn_start", "turn_end"])
const RESERVED_ALIASES = new Set([
  "r", "roll", "ra", "rc", "rb", "rp", "rh", "rah", "sc", "en", "st", "pc", "nn",
  "set", "setcoc", "骰娘", "dice", "骰规则", "log", "help", "帮助"
])
const RESERVED_SUBCOMMAND_ALIASES = new Set([
  "卡", "card", "设", "set", "查", "get", "删", "clear", "权限", "role", "roles", "npc",
  "群卡", "groupcard", "群设", "groupset", "群查", "groupget", "团务", "session", "先攻", "init",
  "战役", "campaign", "群组", "状态", "status", "物品", "item", "inventory", "技能", "ability", "abilities", "spell", "审计", "audit", "投递", "delivery"
])

const TOP_LEVEL_KEYS = new Set(["version", "id", "name", "aliases", "description", "compatibility", "identity", "character", "group", "statuses", "items", "abilities", "events", "dice_sets", "tables", "commands", "templates", "limits"])
const COMPATIBILITY_KEYS = new Set(["min_runtime", "package_version", "migrations"])
const MIGRATION_KEYS = new Set(["from", "to", "rename_fields", "add_defaults", "rename_group_fields", "add_group_defaults"])
const IDENTITY_KEYS = new Set(["display_name", "fallback", "group_card", "sync_group_card"])
const CHARACTER_KEYS = new Set(["fields"])
const FIELD_KEYS = new Set(["type", "label", "description", "default", "formula", "min", "max", "step", "enum", "max_length", "secret", "persistent"])
const DICE_SET_KEYS = new Set(["label", "faces"])
const DICE_FACE_KEYS = new Set(["value", "text", "weight"])
const TABLE_KEYS = new Set(["label", "entries"])
const TABLE_ENTRY_KEYS = new Set(["weight", "text", "value", "tags"])
const GROUP_KEYS = new Set(["fields"])
const STATUS_KEYS = new Set(["label", "description", "default_duration", "max_stacks", "tick", "on_apply", "on_tick", "on_expire"])
const ITEM_KEYS = new Set(["label", "description", "stackable", "max_quantity", "slot", "consumable", "on_use", "on_equip", "on_unequip"])
const ABILITY_KEYS = new Set(["label", "description", "kind", "max_rank", "cooldown", "resource_scope", "resource_field", "resource_cost", "on_use"])
const COMMAND_KEYS = new Set(["id", "aliases", "label", "description", "permission", "visibility", "public_output", "arguments", "rolls", "draws", "let", "opposed", "branches", "actions", "template", "output", "error_output"])
const ARGUMENT_KEYS = new Set(["id", "label", "description", "type", "required", "default", "min", "max", "enum", "rest", "multiple", "allowed"])
const BRANCH_KEYS = new Set(["when", "result", "let", "actions", "output", "tags"])
const ACTION_KEYS = new Set(["op", "scope", "target", "field", "value", "min", "max", "when", "status", "duration", "stacks", "item", "quantity", "ability", "rank"])
const OPPOSED_KEYS = new Set(["target", "actor_value", "target_value", "mode", "tie"])
const LIMIT_KEYS = new Set(["max_dice_count", "max_rolls", "max_expression_length", "max_output_length", "max_table_entries"])

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value))
}

function addError(errors, path, message) {
  errors.push(`${path}: ${message}`)
}

function findCoreCommandRoute(prefix) {
  const value = String(prefix || "")
  for (const candidate of [`.${value}`, `.${value} test`]) {
    const match = DICE_COMMAND_RULES.find(rule => new RegExp(rule.reg, "i").test(candidate))
    if (match) return match.fnc
  }
  return ""
}

function checkObject(value, path, errors) {
  if (isObject(value)) return true
  addError(errors, path, "必须是对象")
  return false
}

function rejectUnknownKeys(value, allowed, path, errors) {
  if (!isObject(value)) return
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, `${path}.${key}`, "未知字段")
  }
}

function checkString(value, path, errors, { required = false, max = 300 } = {}) {
  if (value === undefined || value === null) {
    if (required) addError(errors, path, "不能为空")
    return ""
  }
  if (typeof value !== "string") {
    addError(errors, path, "必须是字符串")
    return ""
  }
  const text = value.trim()
  if (required && !text) addError(errors, path, "不能为空")
  if (Array.from(text).length > max) addError(errors, path, `长度不能超过 ${max}`)
  if (/\[CQ:/i.test(text)) addError(errors, path, "不能包含 CQ 消息码")
  return text
}

function checkInternalId(value, path, errors) {
  const id = checkString(value, path, errors, { required: true, max: 48 })
  if (id && !ITEM_ID_PATTERN.test(id)) addError(errors, path, "必须匹配 [a-z][a-z0-9_]{0,47}")
  return id
}

function checkObjectId(value, path, errors, label = "ID") {
  const id = String(value || "")
  if (!ITEM_ID_PATTERN.test(id)) addError(errors, path, `${label} 不合法`)
  return id
}

function validateAliases(value, path, errors, { reserved = false } = {}) {
  if (!Array.isArray(value) || !value.length) {
    addError(errors, path, "必须是非空字符串数组")
    return []
  }
  const aliases = []
  const normalizedAliases = new Set()
  for (let i = 0; i < value.length; i += 1) {
    const alias = checkString(value[i], `${path}[${i}]`, errors, { required: true, max: 24 })
    if (!alias) continue
    if (/^[.。]|\s/.test(alias)) addError(errors, `${path}[${i}]`, "不能包含空格或以句号开头")
    if (reserved) {
      const coreRoute = RESERVED_ALIASES.has(alias.toLowerCase()) ? alias : findCoreCommandRoute(alias)
      if (coreRoute) addError(errors, `${path}[${i}]`, `与核心命令路由 ${coreRoute} 冲突`)
    }
    const normalized = alias.toLowerCase()
    if (!normalizedAliases.has(normalized)) {
      aliases.push(alias)
      normalizedAliases.add(normalized)
    }
  }
  if (aliases.length !== value.length) addError(errors, path, "别名不能重复")
  return aliases
}

function checkNumberSetting(value, path, errors, { integer = false, min = -Infinity, max = Infinity, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) addError(errors, path, "不能为空")
    return null
  }
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    addError(errors, path, integer ? "必须是整数" : "必须是有限数字")
    return null
  }
  if (value < min || value > max) addError(errors, path, `必须在 ${min} 到 ${max} 之间`)
  return value
}

function checkTypedValue(value, definition, path, errors) {
  const type = definition.type
  if (type === "integer" && (!Number.isInteger(value) || !Number.isFinite(value))) addError(errors, path, "必须是整数")
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) addError(errors, path, "必须是有限数字")
  if (type === "string" && typeof value !== "string") addError(errors, path, "必须是字符串")
  if (type === "boolean" && typeof value !== "boolean") addError(errors, path, "必须是布尔值")
  if (["integer", "number"].includes(type) && typeof value === "number") {
    if (definition.min !== undefined && value < definition.min) addError(errors, path, `不能小于 ${definition.min}`)
    if (definition.max !== undefined && value > definition.max) addError(errors, path, `不能大于 ${definition.max}`)
  }
  if (type === "string" && definition.max_length && Array.from(value).length > definition.max_length) addError(errors, path, `长度不能超过 ${definition.max_length}`)
  if (Array.isArray(definition.enum) && !definition.enum.some(item => typeof item === typeof value && item === value)) addError(errors, path, "不在 enum 允许值中")
}

function compareVersions(left = "0", right = "0") {
  const a = String(left).split(".").map(part => Number(part) || 0)
  const b = String(right).split(".").map(part => Number(part) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0)
  }
  return 0
}

function walkAst(ast, callback) {
  callback(ast)
  if (ast?.type === "UnaryExpression") walkAst(ast.argument, callback)
  if (ast?.type === "BinaryExpression") {
    walkAst(ast.left, callback)
    walkAst(ast.right, callback)
  }
  if (ast?.type === "ConditionalExpression") {
    walkAst(ast.test, callback)
    walkAst(ast.consequent, callback)
    walkAst(ast.alternate, callback)
  }
  if (ast?.type === "CallExpression") for (const arg of ast.arguments) walkAst(arg, callback)
}

function validateExpression(source, path, errors, scope, options = {}) {
  const expression = typeof source === "number" || typeof source === "boolean" ? String(source) : source
  if (typeof expression !== "string") {
    addError(errors, path, "必须是表达式字符串或字面量")
    return null
  }
  let ast
  try {
    ast = parseDiceRuleExpression(expression, { maxLength: options.maxLength || 512 })
  } catch (error) {
    addError(errors, path, error.message)
    return null
  }
  const analysis = collectExpressionReferences(ast)
  const extraFunctions = Array.isArray(options.extraFunctions) ? options.extraFunctions : []
  for (const name of analysis.calls) {
    if (!EXPRESSION_FUNCTIONS.has(name) && !extraFunctions.includes(name)) addError(errors, path, `不支持的函数 ${name}`)
    if (!options.allowDice && name === "dice") addError(errors, path, "这里只允许确定性表达式，不能调用 dice()")
  }
  if (!options.allowDice && analysis.containsDice) addError(errors, path, "这里只允许确定性表达式，不能直接掷骰")
  for (const reference of analysis.references) {
    const [root, key, member] = reference.split(".")
    if (!scope[root]) {
      addError(errors, path, `当前阶段不能引用 ${reference}`)
      continue
    }
    if (scope[root] instanceof Set && key && !scope[root].has(key)) addError(errors, path, `未知值引用 ${reference}`)
    if (root === "roll" && member && !["total", "detail", "expr"].includes(member)) addError(errors, path, `骰点只支持 total/detail/expr：${reference}`)
    if (root === "table" && member && !["value", "text", "tags"].includes(member)) addError(errors, path, `随机表只支持 value/text/tags：${reference}`)
    if (root === "group" && key !== "id") addError(errors, path, `群信息只支持 group.id：${reference}`)
    if (root === "session" && key && !["active", "round", "turn", "phase", "title"].includes(key)) addError(errors, path, `团务状态不支持 ${reference}`)
    if (root === "target" && key && !["id", "name", "kind", "attr", "derived", "statuses", "inventory"].includes(key)) addError(errors, path, `目标信息不支持 ${reference}`)
    if (root === "opposed" && key && !["actor", "target", "result", "winner", "margin"].includes(key)) addError(errors, path, `对抗结果不支持 ${reference}`)
    if (root === "status" && key && !["id", "stacks", "duration"].includes(key)) addError(errors, path, `状态上下文不支持 ${reference}`)
    if (root === "result" && key) addError(errors, path, `结果只能引用 result：${reference}`)
  }
  walkAst(ast, node => {
    if (node.type !== "CallExpression" || node.name !== "dice") return
    const first = node.arguments[0]
    if (first?.type !== "Literal" || typeof first.value !== "string") {
      addError(errors, path, "dice() 的第一个参数必须是静态骰组名称")
    } else if (!scope.diceSets?.has(first.value)) {
      addError(errors, path, `未知自定义骰 ${first.value}`)
    }
  })
  return ast
}

function validateTemplate(template, path, errors, scope) {
  if (typeof template !== "string") {
    addError(errors, path, "必须是字符串")
    return
  }
  if (/\[CQ:/i.test(template)) addError(errors, path, "不能包含 CQ 消息码")
  if (!template.trim()) addError(errors, path, "不能为空")
  if (Array.from(template).length > 2000) addError(errors, path, "模板长度不能超过 2000")
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    const reference = match[1].trim()
    const [root, key, member] = reference.split(".")
    if (["actor", "result"].includes(root)) continue
    if (root === "command" && key === "label") continue
    if (["sender"].includes(root) && ["card", "nickname"].includes(key)) continue
    if (!scope[root]) {
      addError(errors, path, `未知模板变量 ${reference}`)
      continue
    }
    if (scope[root] instanceof Set && key && !scope[root].has(key)) addError(errors, path, `未知模板变量 ${reference}`)
    if (root === "roll" && member && !["total", "detail", "expr"].includes(member)) addError(errors, path, `未知模板变量 ${reference}`)
    if (root === "table" && member && !["value", "text", "tags"].includes(member)) addError(errors, path, `未知模板变量 ${reference}`)
    if (root === "session" && key && !["active", "round", "turn", "phase", "title"].includes(key)) addError(errors, path, `未知模板变量 ${reference}`)
    if (root === "target" && key && !["id", "name", "kind", "attr", "derived", "statuses", "inventory"].includes(key)) addError(errors, path, `未知模板变量 ${reference}`)
    if (root === "opposed" && key && !["actor", "target", "result", "winner", "margin"].includes(key)) addError(errors, path, `未知模板变量 ${reference}`)
  }
}

function validateErrorTemplate(template, path, errors) {
  if (typeof template !== "string") {
    addError(errors, path, "必须是字符串")
    return
  }
  if (/\[CQ:/i.test(template)) addError(errors, path, "不能包含 CQ 消息码")
  if (!template.trim()) addError(errors, path, "不能为空")
  if (Array.from(template).length > 2000) addError(errors, path, "模板长度不能超过 2000")
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    if (match[1].trim() !== "message") addError(errors, path, `错误模板只支持 message：${match[1].trim()}`)
  }
}

function findRestrictedCommandAccess(command, fields, groupFields, abilities, templates) {
  const found = new Set()
  const scan = (value, key = "", parent = null) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\b(attr|derived|shared)\.([a-z][a-z0-9_]*)\b/g)) {
        const secret = match[1] === "shared" ? groupFields.secret : fields.secret
        if (secret.has(match[2])) found.add(`${match[1]}.${match[2]}`)
      }
      if (key === "field" && parent) {
        const secret = parent.scope === "group" ? groupFields.secret : fields.secret
        if (secret.has(value)) found.add(`${parent.scope === "group" ? "shared" : "attr"}.${value}`)
      }
      if (key === "ability" && abilities.restricted?.has(value)) found.add(`abilities.${value}`)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item)
      return
    }
    if (!value || typeof value !== "object") return
    for (const [childKey, childValue] of Object.entries(value)) scan(childValue, childKey, value)
  }
  scan(command)
  if (command.template && typeof templates[command.template] === "string") scan(templates[command.template])
  return [...found]
}

function validateFields(pack, errors, { key = "character", allowedKeys = CHARACTER_KEYS, extraScope = {}, extraFunctions = [] } = {}) {
  const block = pack[key] ?? { fields: {} }
  const empty = { persistent: new Set(), stored: new Set(), transient: new Set(), derived: new Set(), secret: new Set(), fields: {} }
  if (!checkObject(block, key, errors)) return empty
  rejectUnknownKeys(block, allowedKeys, key, errors)
  const fields = block.fields ?? {}
  if (!checkObject(fields, `${key}.fields`, errors)) return empty
  const persistent = new Set()
  const stored = new Set()
  const transient = new Set()
  const derived = new Set()
  const secret = new Set()
  for (const [id, definition] of Object.entries(fields)) {
    const path = `${key}.fields.${id}`
    checkObjectId(id, path, errors, "字段 ID")
    if (!checkObject(definition, path, errors)) continue
    rejectUnknownKeys(definition, FIELD_KEYS, path, errors)
    if (!FIELD_TYPES.has(definition.type)) addError(errors, `${path}.type`, "必须是 integer、number、string 或 boolean")
    checkString(definition.label, `${path}.label`, errors, { max: 60 })
    checkString(definition.description, `${path}.description`, errors, { max: 200 })
    if (definition.formula !== undefined) {
      if (!['integer', 'number'].includes(definition.type)) addError(errors, `${path}.formula`, "formula 只支持数值字段")
      if (definition.default !== undefined) addError(errors, path, "formula 不能与 default 同时设置")
      if (definition.persistent !== undefined) addError(errors, path, "formula 字段不能设置 persistent")
      derived.add(id)
    } else {
      persistent.add(id)
      if (definition.persistent === false) transient.add(id)
      else stored.add(id)
    }
    if (definition.min !== undefined) checkNumberSetting(definition.min, `${path}.min`, errors)
    if (definition.max !== undefined) checkNumberSetting(definition.max, `${path}.max`, errors)
    if (typeof definition.min === "number" && typeof definition.max === "number" && definition.min > definition.max) addError(errors, path, "min 不能大于 max")
    if (definition.step !== undefined) checkNumberSetting(definition.step, `${path}.step`, errors, { min: 0 })
    if (definition.max_length !== undefined) checkNumberSetting(definition.max_length, `${path}.max_length`, errors, { integer: true, min: 1, max: 200 })
    if (definition.secret !== undefined && typeof definition.secret !== "boolean") addError(errors, `${path}.secret`, "必须是布尔值")
    if (definition.persistent !== undefined && typeof definition.persistent !== "boolean") addError(errors, `${path}.persistent`, "必须是布尔值")
    if (definition.enum !== undefined && (!Array.isArray(definition.enum) || !definition.enum.length)) addError(errors, `${path}.enum`, "必须是非空数组")
    if (definition.default !== undefined && definition.formula === undefined) checkTypedValue(definition.default, definition, `${path}.default`, errors)
    if (definition.secret === true) secret.add(id)
  }
  if (derived.size > 80) addError(errors, `${key}.fields`, "派生字段不能超过 80 个")

  const scope = { attr: persistent, derived, diceSets: new Set(), ...extraScope }
  const dependencyGraph = new Map()
  for (const id of derived) {
    const path = `${key}.fields.${id}.formula`
    const ast = validateExpression(fields[id].formula, path, errors, scope, { extraFunctions })
    const deps = new Set()
    if (ast) {
      for (const reference of collectExpressionReferences(ast).references) {
        const [root, key] = reference.split(".")
        if (root === "derived") deps.add(key)
      }
    }
    dependencyGraph.set(id, deps)
  }
  const visiting = new Set()
  const visited = new Set()
  const visit = (id, stack = []) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id)
      addError(errors, `character.fields.${id}.formula`, `循环依赖 ${[...stack.slice(start), id].join(" -> ")}`)
      return
    }
    if (visited.has(id)) return
    if (stack.length >= 24) {
      addError(errors, `character.fields.${id}.formula`, "派生字段依赖深度不能超过 24")
      return
    }
    visiting.add(id)
    for (const dep of dependencyGraph.get(id) || []) visit(dep, [...stack, id])
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of derived) visit(id)
  for (const id of derived) {
    if (secret.has(id)) continue
    try {
      const references = collectExpressionReferences(parseDiceRuleExpression(fields[id].formula)).references
      if ([...references].some(reference => reference.startsWith("attr.") && secret.has(reference.split(".")[1]))) secret.add(id)
    } catch {}
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [id, deps] of dependencyGraph) {
      if (!secret.has(id) && [...deps].some(dep => secret.has(dep))) {
        secret.add(id)
        changed = true
      }
    }
  }
  return { persistent, stored, transient, derived, secret, fields }
}

function validateDiceSets(pack, errors) {
  const diceSets = pack.dice_sets ?? {}
  if (!checkObject(diceSets, "dice_sets", errors)) return new Set()
  const ids = new Set()
  for (const [id, definition] of Object.entries(diceSets)) {
    const path = `dice_sets.${id}`
    if (!ITEM_ID_PATTERN.test(id)) addError(errors, path, "骰组 ID 不合法")
    ids.add(id)
    if (!checkObject(definition, path, errors)) continue
    rejectUnknownKeys(definition, DICE_SET_KEYS, path, errors)
    checkString(definition.label, `${path}.label`, errors, { max: 60 })
    if (!Array.isArray(definition.faces) || definition.faces.length < 2 || definition.faces.length > 100) {
      addError(errors, `${path}.faces`, "必须包含 2 到 100 个骰面")
      continue
    }
    definition.faces.forEach((face, index) => {
      const facePath = `${path}.faces[${index}]`
      if (typeof face === "number") {
        if (!Number.isFinite(face)) addError(errors, facePath, "骰面必须是有限数字")
        return
      }
      if (!checkObject(face, facePath, errors)) return
      rejectUnknownKeys(face, DICE_FACE_KEYS, facePath, errors)
      checkNumberSetting(face.value, `${facePath}.value`, errors, { required: true })
      checkString(face.text, `${facePath}.text`, errors, { max: 60 })
      if (face.weight !== undefined) checkNumberSetting(face.weight, `${facePath}.weight`, errors, { integer: true, min: 1, max: 100000 })
    })
  }
  return ids
}

function validateTables(pack, errors, maxEntries) {
  const tables = pack.tables ?? {}
  if (!checkObject(tables, "tables", errors)) return new Set()
  const ids = new Set()
  for (const [id, definition] of Object.entries(tables)) {
    const path = `tables.${id}`
    if (!ITEM_ID_PATTERN.test(id)) addError(errors, path, "随机表 ID 不合法")
    ids.add(id)
    if (!checkObject(definition, path, errors)) continue
    rejectUnknownKeys(definition, TABLE_KEYS, path, errors)
    checkString(definition.label, `${path}.label`, errors, { max: 60 })
    if (!Array.isArray(definition.entries) || !definition.entries.length || definition.entries.length > maxEntries) {
      addError(errors, `${path}.entries`, `必须包含 1 到 ${maxEntries} 项`)
      continue
    }
    definition.entries.forEach((entry, index) => {
      const entryPath = `${path}.entries[${index}]`
      if (!checkObject(entry, entryPath, errors)) return
      rejectUnknownKeys(entry, TABLE_ENTRY_KEYS, entryPath, errors)
      checkString(entry.text, `${entryPath}.text`, errors, { required: true, max: 300 })
      if (entry.value !== undefined) checkNumberSetting(entry.value, `${entryPath}.value`, errors)
      if (entry.weight !== undefined) checkNumberSetting(entry.weight, `${entryPath}.weight`, errors, { integer: true, min: 1, max: 100000 })
      if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some(tag => typeof tag !== "string"))) addError(errors, `${entryPath}.tags`, "必须是字符串数组")
    })
  }
  return ids
}

function validateStatusDefinitions(pack, errors) {
  const definitions = pack.statuses ?? {}
  const ids = new Set()
  if (!checkObject(definitions, "statuses", errors)) return { ids, definitions: {} }
  for (const [id, definition] of Object.entries(definitions)) {
    const path = `statuses.${id}`
    checkObjectId(id, path, errors, "状态 ID")
    ids.add(id)
    if (!checkObject(definition, path, errors)) continue
    rejectUnknownKeys(definition, STATUS_KEYS, path, errors)
    checkString(definition.label, `${path}.label`, errors, { required: true, max: 60 })
    checkString(definition.description, `${path}.description`, errors, { max: 200 })
    if (definition.default_duration !== undefined) checkNumberSetting(definition.default_duration, `${path}.default_duration`, errors, { integer: true, min: 1, max: 100000 })
    if (definition.max_stacks !== undefined) checkNumberSetting(definition.max_stacks, `${path}.max_stacks`, errors, { integer: true, min: 1, max: 1000 })
    if (definition.tick !== undefined && !STATUS_TICKS.has(definition.tick)) addError(errors, `${path}.tick`, `必须是 ${[...STATUS_TICKS].join("、")}`)
  }
  return { ids, definitions }
}

function validateItemDefinitions(pack, errors) {
  const definitions = pack.items ?? {}
  const ids = new Set()
  if (!checkObject(definitions, "items", errors)) return { ids, definitions: {} }
  for (const [id, definition] of Object.entries(definitions)) {
    const path = `items.${id}`
    checkObjectId(id, path, errors, "物品 ID")
    ids.add(id)
    if (!checkObject(definition, path, errors)) continue
    rejectUnknownKeys(definition, ITEM_KEYS, path, errors)
    checkString(definition.label, `${path}.label`, errors, { required: true, max: 60 })
    checkString(definition.description, `${path}.description`, errors, { max: 200 })
    checkString(definition.slot, `${path}.slot`, errors, { max: 40 })
    if (definition.stackable !== undefined && typeof definition.stackable !== "boolean") addError(errors, `${path}.stackable`, "必须是布尔值")
    if (definition.consumable !== undefined && typeof definition.consumable !== "boolean") addError(errors, `${path}.consumable`, "必须是布尔值")
    if (definition.max_quantity !== undefined) checkNumberSetting(definition.max_quantity, `${path}.max_quantity`, errors, { integer: true, min: 1, max: 1000000 })
    if (definition.stackable === false && definition.max_quantity !== undefined && definition.max_quantity !== 1) addError(errors, `${path}.max_quantity`, "不可堆叠物品的上限只能是 1")
  }
  return { ids, definitions }
}

function validateAbilityDefinitions(pack, errors, fields, groupFields) {
  const definitions = pack.abilities ?? {}
  const ids = new Set()
  const restricted = new Set()
  if (!checkObject(definitions, "abilities", errors)) return { ids, restricted, definitions: {} }
  for (const [id, definition] of Object.entries(definitions)) {
    const path = `abilities.${id}`
    checkObjectId(id, path, errors, "能力 ID")
    ids.add(id)
    if (!checkObject(definition, path, errors)) continue
    rejectUnknownKeys(definition, ABILITY_KEYS, path, errors)
    checkString(definition.label, `${path}.label`, errors, { required: true, max: 60 })
    checkString(definition.description, `${path}.description`, errors, { max: 300 })
    if (definition.kind !== undefined && !["skill", "spell"].includes(definition.kind)) addError(errors, `${path}.kind`, "必须是 skill 或 spell")
    if (definition.max_rank !== undefined) checkNumberSetting(definition.max_rank, `${path}.max_rank`, errors, { integer: true, min: 1, max: 100 })
    if (definition.cooldown !== undefined) checkNumberSetting(definition.cooldown, `${path}.cooldown`, errors, { integer: true, min: 0, max: 100000 })
    if (definition.resource_scope !== undefined && !["actor", "group"].includes(definition.resource_scope)) addError(errors, `${path}.resource_scope`, "必须是 actor 或 group")
    if (definition.resource_field !== undefined) {
      const scopeFields = definition.resource_scope === "group" ? groupFields : fields
      if (!scopeFields.stored.has(definition.resource_field)) addError(errors, `${path}.resource_field`, `资源字段 ${definition.resource_field} 不存在或不可持久化`)
      const field = scopeFields.fields[definition.resource_field]
      if (field && !["integer", "number"].includes(field.type)) addError(errors, `${path}.resource_field`, "资源字段必须是数值型")
    }
    if (definition.resource_cost !== undefined) checkNumberSetting(definition.resource_cost, `${path}.resource_cost`, errors, { min: 0, max: 1000000000 })
    if (definition.resource_cost !== undefined && !definition.resource_field) addError(errors, path, "设置 resource_cost 时必须同时设置 resource_field")
    const resourceFields = definition.resource_scope === "group" ? groupFields : fields
    if (definition.resource_field && resourceFields.secret.has(definition.resource_field)) restricted.add(id)
  }
  return { ids, restricted, definitions }
}

function validateActions(actions, path, errors, scope, fields, expressionOptions = {}, definitions = {}) {
  if (actions === undefined) return
  if (!Array.isArray(actions) || actions.length > 20) {
    addError(errors, path, "必须是最多 20 项的数组")
    return
  }
  actions.forEach((action, index) => {
    const actionPath = `${path}[${index}]`
    if (!checkObject(action, actionPath, errors)) return
    rejectUnknownKeys(action, ACTION_KEYS, actionPath, errors)
    if (!ACTIONS.has(action.op)) addError(errors, `${actionPath}.op`, "不支持的动作")
    const actionScope = action.scope || "actor"
    if (!ACTION_SCOPES.has(actionScope)) addError(errors, `${actionPath}.scope`, `必须是 ${[...ACTION_SCOPES].join("、")}`)
    if (actionScope === "target") {
      if (!action.target) addError(errors, `${actionPath}.target`, "目标动作必须指定 actor 参数 ID")
      else if (!definitions.actorArgs?.has(action.target)) addError(errors, `${actionPath}.target`, `未知 actor 参数 ${action.target}`)
    } else if (action.target !== undefined) addError(errors, `${actionPath}.target`, "只有 target scope 可以设置 target")

    if (VALUE_ACTIONS.has(action.op)) {
      const field = checkInternalId(action.field, `${actionPath}.field`, errors)
      const writable = actionScope === "group" ? definitions.groupFields || { persistent: new Set(), derived: new Set() } : fields
      if (field && !writable.persistent.has(field)) addError(errors, `${actionPath}.field`, writable.derived.has(field) ? "派生字段不能写入" : `未知字段 ${field}`)
      if (!["clear"].includes(action.op) && action.value === undefined && action.op !== "clamp") addError(errors, `${actionPath}.value`, "不能为空")
    } else if (action.field !== undefined) addError(errors, `${actionPath}.field`, `${action.op} 不使用 field`)

    if (STATUS_ACTIONS.has(action.op)) {
      if (!checkInternalId(action.status, `${actionPath}.status`, errors) || !definitions.statuses?.has(action.status)) addError(errors, `${actionPath}.status`, `未知状态 ${action.status || ""}`)
      if (action.op === "add_status") {
        if (action.duration !== undefined) validateExpression(action.duration, `${actionPath}.duration`, errors, scope, expressionOptions)
        if (action.stacks !== undefined) validateExpression(action.stacks, `${actionPath}.stacks`, errors, scope, expressionOptions)
      }
    } else if (action.status !== undefined || action.duration !== undefined || action.stacks !== undefined) addError(errors, actionPath, `${action.op} 不使用状态参数`)

    if (ITEM_ACTIONS.has(action.op)) {
      if (!checkInternalId(action.item, `${actionPath}.item`, errors) || !definitions.items?.has(action.item)) addError(errors, `${actionPath}.item`, `未知物品 ${action.item || ""}`)
      if (["add_item", "remove_item"].includes(action.op) && action.quantity !== undefined) validateExpression(action.quantity, `${actionPath}.quantity`, errors, scope, expressionOptions)
    } else if (action.item !== undefined || action.quantity !== undefined) addError(errors, actionPath, `${action.op} 不使用物品参数`)

    if (ABILITY_ACTIONS.has(action.op)) {
      if (!checkInternalId(action.ability, `${actionPath}.ability`, errors) || !definitions.abilities?.has(action.ability)) addError(errors, `${actionPath}.ability`, `未知能力 ${action.ability || ""}`)
      if (action.op === "learn_ability" && action.rank !== undefined) validateExpression(action.rank, `${actionPath}.rank`, errors, scope, expressionOptions)
    } else if (action.ability !== undefined || action.rank !== undefined) addError(errors, actionPath, `${action.op} 不使用能力参数`)

    if (action.value !== undefined) validateExpression(action.value, `${actionPath}.value`, errors, scope, expressionOptions)
    if (action.min !== undefined) validateExpression(String(action.min), `${actionPath}.min`, errors, scope, expressionOptions)
    if (action.max !== undefined) validateExpression(String(action.max), `${actionPath}.max`, errors, scope, expressionOptions)
    if (action.op === "clamp" && (action.min === undefined || action.max === undefined)) addError(errors, actionPath, "clamp 必须同时设置 min 和 max")
    if (action.when !== undefined) validateExpression(action.when, `${actionPath}.when`, errors, scope, expressionOptions)
  })
}

function validateLifecycleActions(pack, errors, fields, groupFields, statuses, items, abilities, limits) {
  const scope = {
    attr: fields.persistent,
    derived: fields.derived,
    shared: groupFields.persistent,
    session: true,
    inventory: items,
    abilities,
    status: true,
    group: true,
    result: true,
    diceSets: new Set()
  }
  const definitions = { actorArgs: new Set(), groupFields, statuses, items, abilities }
  for (const [id, definition] of Object.entries(pack.statuses || {})) {
    for (const key of ["on_apply", "on_tick", "on_expire"]) {
      validateActions(definition?.[key], `statuses.${id}.${key}`, errors, scope, fields, { maxLength: limits.max_expression_length }, definitions)
    }
  }
  for (const [id, definition] of Object.entries(pack.items || {})) {
    for (const key of ["on_use", "on_equip", "on_unequip"]) {
      validateActions(definition?.[key], `items.${id}.${key}`, errors, scope, fields, { maxLength: limits.max_expression_length }, definitions)
    }
  }
  for (const [id, definition] of Object.entries(pack.abilities || {})) {
    validateActions(definition?.on_use, `abilities.${id}.on_use`, errors, scope, fields, { maxLength: limits.max_expression_length }, definitions)
  }
  if (pack.events === undefined) return
  if (!checkObject(pack.events, "events", errors)) return
  for (const [eventName, actions] of Object.entries(pack.events)) {
    if (!EVENT_NAMES.has(eventName)) addError(errors, `events.${eventName}`, `未知事件；支持 ${[...EVENT_NAMES].join("、")}`)
    validateActions(actions, `events.${eventName}`, errors, scope, fields, { maxLength: limits.max_expression_length }, definitions)
  }
}

function validateCommands(pack, errors, fields, groupFields, statuses, items, abilities, abilityDefinitions, diceSets, tables, templates, limits, extraFunctions = []) {
  if (!Array.isArray(pack.commands) || !pack.commands.length || pack.commands.length > 30) {
    addError(errors, "commands", "必须包含 1 到 30 条命令")
    return
  }
  const commandIds = new Set()
  const commandAliases = new Set()
  pack.commands.forEach((command, commandIndex) => {
    const path = `commands[${commandIndex}]`
    if (!checkObject(command, path, errors)) return
    rejectUnknownKeys(command, COMMAND_KEYS, path, errors)
    const id = checkInternalId(command.id, `${path}.id`, errors)
    if (commandIds.has(id)) addError(errors, `${path}.id`, "命令 ID 重复")
    commandIds.add(id)
    const aliases = validateAliases(command.aliases, `${path}.aliases`, errors)
    for (const alias of aliases) {
      const normalized = alias.toLowerCase()
      if (RESERVED_SUBCOMMAND_ALIASES.has(normalized)) addError(errors, `${path}.aliases`, `子命令 ${alias} 由人物卡操作保留`)
      if (commandAliases.has(normalized)) addError(errors, `${path}.aliases`, `子命令别名 ${alias} 重复`)
      commandAliases.add(normalized)
    }
    checkString(command.label, `${path}.label`, errors, { max: 60 })
    checkString(command.description, `${path}.description`, errors, { max: 300 })
    if (command.permission !== undefined && !PERMISSIONS.has(command.permission)) addError(errors, `${path}.permission`, `必须是 ${[...PERMISSIONS].join("、")}`)
    if (command.visibility !== undefined && !VISIBILITIES.has(command.visibility)) addError(errors, `${path}.visibility`, `必须是 ${[...VISIBILITIES].join("、")}`)

    const args = new Set()
    const actorArgs = new Set()
    if (command.arguments !== undefined) {
      if (!Array.isArray(command.arguments) || command.arguments.length > 12) addError(errors, `${path}.arguments`, "必须是最多 12 项的数组")
      else command.arguments.forEach((argument, index) => {
        const argPath = `${path}.arguments[${index}]`
        if (!checkObject(argument, argPath, errors)) return
        rejectUnknownKeys(argument, ARGUMENT_KEYS, argPath, errors)
        const argId = checkInternalId(argument.id, `${argPath}.id`, errors)
        if (args.has(argId)) addError(errors, `${argPath}.id`, "参数 ID 重复")
        args.add(argId)
        if (!ARGUMENT_TYPES.has(argument.type)) addError(errors, `${argPath}.type`, "参数类型不支持")
        if (argument.required !== undefined && typeof argument.required !== "boolean") addError(errors, `${argPath}.required`, "必须是布尔值")
        if (argument.required === true && argument.default !== undefined) addError(errors, argPath, "required 参数不能设置 default")
        if (argument.rest !== undefined && typeof argument.rest !== "boolean") addError(errors, `${argPath}.rest`, "必须是布尔值")
        if (argument.rest === true && index !== command.arguments.length - 1) addError(errors, `${argPath}.rest`, "rest 参数必须放在最后")
        if (argument.multiple !== undefined && typeof argument.multiple !== "boolean") addError(errors, `${argPath}.multiple`, "必须是布尔值")
        if (argument.type === "actor") {
          actorArgs.add(argId)
          if (argument.default !== undefined) addError(errors, `${argPath}.default`, "actor 参数使用 required 或省略，不能设置普通默认值")
          const allowed = argument.allowed ?? ["self"]
          if (!Array.isArray(allowed) || !allowed.length || allowed.some(kind => !ACTOR_KINDS.has(kind))) addError(errors, `${argPath}.allowed`, `只能包含 ${[...ACTOR_KINDS].join("、")}`)
          if (argument.multiple === true && argument.rest !== true) addError(errors, argPath, "multiple actor 参数必须同时设置 rest: true")
          if (argument.enum !== undefined || argument.min !== undefined || argument.max !== undefined) addError(errors, argPath, "actor 参数不支持 enum/min/max")
        } else if (argument.multiple !== undefined || argument.allowed !== undefined) addError(errors, argPath, "multiple/allowed 仅用于 actor 参数")
        if (argument.type === "enum" && (!Array.isArray(argument.enum) || !argument.enum.length)) addError(errors, `${argPath}.enum`, "enum 参数必须提供候选数组")
        if (argument.default !== undefined) {
          if (argument.type === "enum") {
            if (!Array.isArray(argument.enum) || !argument.enum.some(item => typeof item === typeof argument.default && item === argument.default)) addError(errors, `${argPath}.default`, "默认值不在 enum 中")
          } else if (FIELD_TYPES.has(argument.type)) checkTypedValue(argument.default, argument, `${argPath}.default`, errors)
        }
        checkString(argument.label, `${argPath}.label`, errors, { max: 60 })
        checkString(argument.description, `${argPath}.description`, errors, { max: 200 })
      })
    }

    const rolls = new Set()
    const rollDefinitions = command.rolls ?? {}
    if (!checkObject(rollDefinitions, `${path}.rolls`, errors)) return
    if (Object.keys(rollDefinitions).length > limits.max_rolls) addError(errors, `${path}.rolls`, `不能超过 ${limits.max_rolls} 个命名骰点`)
    for (const [rollId, expression] of Object.entries(rollDefinitions)) {
      if (!ITEM_ID_PATTERN.test(rollId)) addError(errors, `${path}.rolls.${rollId}`, "骰点 ID 不合法")
      const scope = { arg: args, attr: fields.persistent, derived: fields.derived, roll: new Set(rolls), diceSets }
      validateExpression(expression, `${path}.rolls.${rollId}`, errors, scope, { allowDice: true, maxLength: limits.max_expression_length })
      rolls.add(rollId)
    }

    const draws = new Set()
    if (command.draws !== undefined) {
      if (checkObject(command.draws, `${path}.draws`, errors)) {
        for (const [drawId, tableId] of Object.entries(command.draws)) {
          if (!ITEM_ID_PATTERN.test(drawId)) addError(errors, `${path}.draws.${drawId}`, "抽表 ID 不合法")
          if (typeof tableId !== "string" || !tables.has(tableId)) addError(errors, `${path}.draws.${drawId}`, `未知随机表 ${tableId}`)
          draws.add(drawId)
        }
      }
    }

    const lets = new Set()
    const baseScope = {
      arg: args,
      attr: fields.persistent,
      derived: fields.derived,
      roll: rolls,
      table: draws,
      let: lets,
      group: true,
      target: actorArgs.size ? true : false,
      shared: groupFields.persistent,
      session: true,
      inventory: items,
      abilities,
      diceSets
    }
    if (command.let !== undefined) {
      if (checkObject(command.let, `${path}.let`, errors)) {
        for (const [letId, expression] of Object.entries(command.let)) {
          if (!ITEM_ID_PATTERN.test(letId)) addError(errors, `${path}.let.${letId}`, "中间值 ID 不合法")
          validateExpression(expression, `${path}.let.${letId}`, errors, baseScope, { maxLength: limits.max_expression_length, extraFunctions: extraFunctions })
          lets.add(letId)
        }
      }
    }
    const scope = {
      ...baseScope,
      let: lets,
      result: true,
      target: actorArgs.size ? true : false,
      shared: groupFields.persistent,
      session: true,
      inventory: items,
      abilities,
      opposed: command.opposed ? true : false
    }
    const templateScope = { arg: args, attr: fields.persistent, derived: fields.derived, roll: rolls, table: draws, let: lets, target: actorArgs.size ? true : false, shared: groupFields.persistent, session: true, inventory: items, abilities, opposed: command.opposed ? true : false }
    const actionDefinitions = { actorArgs, groupFields, statuses, items, abilities }
    validateActions(command.actions, `${path}.actions`, errors, scope, fields, { maxLength: limits.max_expression_length }, actionDefinitions)

    if (command.opposed !== undefined) {
      if (checkObject(command.opposed, `${path}.opposed`, errors)) {
        rejectUnknownKeys(command.opposed, OPPOSED_KEYS, `${path}.opposed`, errors)
        if (!actorArgs.has(command.opposed.target)) addError(errors, `${path}.opposed.target`, "必须引用本命令的 actor 参数")
        if (!["higher", "lower"].includes(command.opposed.mode || "higher")) addError(errors, `${path}.opposed.mode`, "必须是 higher 或 lower")
        if (!["tie", "actor", "target"].includes(command.opposed.tie || "tie")) addError(errors, `${path}.opposed.tie`, "必须是 tie、actor 或 target")
        if (command.opposed.actor_value === undefined) addError(errors, `${path}.opposed.actor_value`, "不能为空")
        else validateExpression(command.opposed.actor_value, `${path}.opposed.actor_value`, errors, scope, { allowDice: true, maxLength: limits.max_expression_length })
        if (command.opposed.target_value === undefined) addError(errors, `${path}.opposed.target_value`, "不能为空")
        else validateExpression(command.opposed.target_value, `${path}.opposed.target_value`, errors, scope, { allowDice: true, maxLength: limits.max_expression_length })
      }
    }

    if (command.branches !== undefined) {
      if (!Array.isArray(command.branches) || !command.branches.length || command.branches.length > 30) addError(errors, `${path}.branches`, "必须包含 1 到 30 个分支")
      else {
        let defaultSeen = false
        command.branches.forEach((branch, branchIndex) => {
          const branchPath = `${path}.branches[${branchIndex}]`
          if (!checkObject(branch, branchPath, errors)) return
          rejectUnknownKeys(branch, BRANCH_KEYS, branchPath, errors)
          if (branch.when === undefined) {
            if (defaultSeen) addError(errors, branchPath, "默认分支只能有一个")
            if (branchIndex !== command.branches.length - 1) addError(errors, branchPath, "默认分支必须放在最后")
            defaultSeen = true
          } else validateExpression(branch.when, `${branchPath}.when`, errors, scope, { maxLength: limits.max_expression_length })
          checkString(branch.result, `${branchPath}.result`, errors, { max: 100 })
          const branchLets = new Set(lets)
          if (branch.let !== undefined && checkObject(branch.let, `${branchPath}.let`, errors)) {
            for (const [letId, expression] of Object.entries(branch.let)) {
              if (!ITEM_ID_PATTERN.test(letId)) addError(errors, `${branchPath}.let.${letId}`, "中间值 ID 不合法")
              validateExpression(expression, `${branchPath}.let.${letId}`, errors, { ...scope, let: branchLets }, { maxLength: limits.max_expression_length })
              branchLets.add(letId)
            }
          }
          const branchScope = { ...scope, let: branchLets }
          validateActions(branch.actions, `${branchPath}.actions`, errors, branchScope, fields, { maxLength: limits.max_expression_length }, actionDefinitions)
          if (branch.output !== undefined) validateTemplate(branch.output, `${branchPath}.output`, errors, { ...templateScope, let: branchLets })
          if (branch.tags !== undefined && (!Array.isArray(branch.tags) || branch.tags.some(tag => typeof tag !== "string"))) addError(errors, `${branchPath}.tags`, "必须是字符串数组")
        })
      }
    }
    if (command.template !== undefined) {
      if (typeof command.template !== "string" || !Object.prototype.hasOwnProperty.call(templates, command.template)) addError(errors, `${path}.template`, `未知模板 ${command.template}`)
      else validateTemplate(templates[command.template], `templates.${command.template}`, errors, templateScope)
      if (command.output !== undefined) addError(errors, path, "template 不能与 output 同时设置")
    }
    if (command.output !== undefined) validateTemplate(command.output, `${path}.output`, errors, templateScope)
    if (command.public_output !== undefined) validateTemplate(command.public_output, `${path}.public_output`, errors, templateScope)
    if (command.error_output !== undefined) validateErrorTemplate(command.error_output, `${path}.error_output`, errors)
    const hasDefaultBranchOutput = command.branches?.some(branch => branch?.when === undefined && branch?.output !== undefined)
    if (command.template === undefined && command.output === undefined && !hasDefaultBranchOutput) addError(errors, path, "必须设置 output、template 或默认分支 output")
    const restrictedAccess = findRestrictedCommandAccess(command, fields, groupFields, abilityDefinitions, templates)
    if (restrictedAccess.length && !["gm", "admin", "master"].includes(command.permission)) {
      addError(errors, `${path}.permission`, `访问 secret 字段时至少需要 gm：${restrictedAccess.join("、")}`)
    }
    if (restrictedAccess.length && !["private", "gm"].includes(command.visibility)) {
      addError(errors, `${path}.visibility`, `访问 secret 字段时必须使用 private 或 gm，不能公开输出：${restrictedAccess.join("、")}`)
    }
  })
}

export function validateDiceRulePack(input, options = {}) {
  const errors = []
  const warnings = []
  let pack
  try {
    pack = clonePlain(input)
  } catch {
    return { ok: false, pack: null, errors: ["$: YAML 结构必须是无循环的普通对象"], warnings }
  }
  if (!checkObject(pack, "$", errors)) return { ok: false, pack: null, errors, warnings }
  rejectUnknownKeys(pack, TOP_LEVEL_KEYS, "$", errors)
  if (pack.version !== 1) addError(errors, "version", "V1 规则包必须设置为 1")
  const id = checkString(pack.id, "id", errors, { required: true, max: 48 })
  if (id && !PACK_ID_PATTERN.test(id)) addError(errors, "id", "必须匹配 [a-z][a-z0-9-]{2,47}")
  if (id) {
    const coreRoute = RESERVED_ALIASES.has(id.toLowerCase()) ? id : findCoreCommandRoute(id)
    if (coreRoute) addError(errors, "id", `与核心命令路由 ${coreRoute} 冲突`)
  }
  checkString(pack.name, "name", errors, { required: true, max: 60 })
  validateAliases(pack.aliases, "aliases", errors, { reserved: true })
  checkString(pack.description, "description", errors, { max: 300 })

  if (pack.compatibility !== undefined && checkObject(pack.compatibility, "compatibility", errors)) {
    rejectUnknownKeys(pack.compatibility, COMPATIBILITY_KEYS, "compatibility", errors)
    checkString(pack.compatibility.min_runtime, "compatibility.min_runtime", errors, { max: 20 })
    const packageVersion = checkString(pack.compatibility.package_version, "compatibility.package_version", errors, { max: 40 })
    if (packageVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion)) addError(errors, "compatibility.package_version", "必须使用语义版本，例如 1.2.0")
    if (pack.compatibility.migrations !== undefined) {
      if (!Array.isArray(pack.compatibility.migrations) || pack.compatibility.migrations.length > 20) addError(errors, "compatibility.migrations", "必须是最多 20 项的数组")
      else {
        const migrationSources = new Set()
        pack.compatibility.migrations.forEach((migration, index) => {
          const path = `compatibility.migrations[${index}]`
          if (!checkObject(migration, path, errors)) return
          rejectUnknownKeys(migration, MIGRATION_KEYS, path, errors)
          const from = checkString(migration.from, `${path}.from`, errors, { required: true, max: 40 })
          const to = checkString(migration.to, `${path}.to`, errors, { max: 40 })
          if (from && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(from)) addError(errors, `${path}.from`, "必须使用语义版本")
          if (to && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(to)) addError(errors, `${path}.to`, "必须使用语义版本")
          if (migrationSources.has(from)) addError(errors, `${path}.from`, `迁移来源 ${from} 重复`)
          migrationSources.add(from)
          for (const key of ["rename_fields", "add_defaults", "rename_group_fields", "add_group_defaults"]) {
            if (migration[key] !== undefined && !isObject(migration[key])) addError(errors, `${path}.${key}`, "必须是对象")
          }
          if (isObject(migration.rename_fields)) {
            const sources = new Set(Object.keys(migration.rename_fields))
            const targets = new Set()
            for (const [oldId, newId] of Object.entries(migration.rename_fields)) {
              if (oldId === newId) addError(errors, `${path}.rename_fields.${oldId}`, "来源和目标不能相同")
              if (targets.has(newId)) addError(errors, `${path}.rename_fields.${oldId}`, `目标字段 ${newId} 被重复使用`)
              if (sources.has(newId)) addError(errors, `${path}.rename_fields.${oldId}`, `V1 不支持链式重命名到 ${newId}`)
              targets.add(newId)
            }
          }
        })
      }
    }
  }
  if (pack.compatibility?.min_runtime && compareVersions(pack.compatibility.min_runtime, DICE_RULE_RUNTIME_VERSION) > 0) {
    addError(errors, "compatibility.min_runtime", `需要规则运行时 ${pack.compatibility.min_runtime}，当前只有 ${DICE_RULE_RUNTIME_VERSION}`)
  }

  const limits = {
    max_dice_count: Number(options.maxDiceCount) || 100,
    max_rolls: 12,
    max_expression_length: 512,
    max_output_length: 2000,
    max_table_entries: 100,
    ...(isObject(pack.limits) ? pack.limits : {})
  }
  if (pack.limits !== undefined) {
    if (checkObject(pack.limits, "limits", errors)) {
      rejectUnknownKeys(pack.limits, LIMIT_KEYS, "limits", errors)
      const hard = { max_dice_count: Number(options.maxDiceCount) || 100, max_rolls: 12, max_expression_length: 512, max_output_length: 2000, max_table_entries: 100 }
      for (const [key, value] of Object.entries(pack.limits)) checkNumberSetting(value, `limits.${key}`, errors, { integer: true, min: 1, max: hard[key] })
    }
  }
  const templates = pack.templates ?? {}
  if (checkObject(templates, "templates", errors)) {
    for (const [id, template] of Object.entries(templates)) {
      checkObjectId(id, `templates.${id}`, errors, "模板 ID")
      if (typeof template !== "string") addError(errors, `templates.${id}`, "模板必须是字符串")
      if (typeof template === "string" && Array.from(template).length > limits.max_output_length) addError(errors, `templates.${id}`, `长度不能超过 ${limits.max_output_length}`)
    }
  }
  const statusDefinitions = validateStatusDefinitions(pack, errors)
  const itemDefinitions = validateItemDefinitions(pack, errors)
  const groupFields = validateFields(pack, errors, { key: "group", allowedKeys: GROUP_KEYS, extraFunctions: options.extraFunctions })
  const abilityIds = new Set(Object.keys(isObject(pack.abilities) ? pack.abilities : {}))
  const fields = validateFields(pack, errors, {
    extraFunctions: options.extraFunctions,
    extraScope: { shared: groupFields.persistent, inventory: itemDefinitions.ids, abilities: abilityIds }
  })
  const abilityDefinitions = validateAbilityDefinitions(pack, errors, fields, groupFields)
  for (const [migrationIndex, migration] of (pack.compatibility?.migrations || []).entries()) {
    const path = `compatibility.migrations[${migrationIndex}]`
    for (const [oldId, newId] of Object.entries(migration.rename_fields || {})) {
      if (!ITEM_ID_PATTERN.test(oldId)) addError(errors, `${path}.rename_fields.${oldId}`, "旧字段 ID 不合法")
      if (!fields.stored.has(newId)) addError(errors, `${path}.rename_fields.${oldId}`, `目标字段 ${newId} 不存在或不是可持久字段`)
    }
    for (const [id, value] of Object.entries(migration.add_defaults || {})) {
      const definition = fields.fields[id]
      if (!definition || !fields.stored.has(id)) addError(errors, `${path}.add_defaults.${id}`, `字段 ${id} 不存在或不是可持久字段`)
      else checkTypedValue(value, definition, `${path}.add_defaults.${id}`, errors)
    }
    for (const [oldId, newId] of Object.entries(migration.rename_group_fields || {})) {
      if (!ITEM_ID_PATTERN.test(oldId)) addError(errors, `${path}.rename_group_fields.${oldId}`, "旧群字段 ID 不合法")
      if (!groupFields.stored.has(newId)) addError(errors, `${path}.rename_group_fields.${oldId}`, `目标群字段 ${newId} 不存在或不是可持久字段`)
    }
    for (const [id, value] of Object.entries(migration.add_group_defaults || {})) {
      const definition = groupFields.fields[id]
      if (!definition || !groupFields.stored.has(id)) addError(errors, `${path}.add_group_defaults.${id}`, `群字段 ${id} 不存在或不是可持久字段`)
      else checkTypedValue(value, definition, `${path}.add_group_defaults.${id}`, errors)
    }
  }
  const diceSets = validateDiceSets(pack, errors)
  const tables = validateTables(pack, errors, limits.max_table_entries)

  if (pack.identity !== undefined && checkObject(pack.identity, "identity", errors)) {
    rejectUnknownKeys(pack.identity, IDENTITY_KEYS, "identity", errors)
    const identityScope = { attr: fields.persistent, derived: fields.derived }
    if (pack.identity.display_name !== undefined) validateTemplate(pack.identity.display_name, "identity.display_name", errors, identityScope)
    if (pack.identity.fallback !== undefined) validateTemplate(pack.identity.fallback, "identity.fallback", errors, identityScope)
    if (pack.identity.group_card !== undefined) validateTemplate(pack.identity.group_card, "identity.group_card", errors, identityScope)
    if (pack.identity.sync_group_card !== undefined && typeof pack.identity.sync_group_card !== "boolean") addError(errors, "identity.sync_group_card", "必须是布尔值")
    for (const [key, template] of Object.entries(pack.identity)) {
      if (typeof template !== "string") continue
      const leaked = [...template.matchAll(/\b(attr|derived)\.([a-z][a-z0-9_]*)\b/g)].find(match => fields.secret.has(match[2]))
      if (leaked) addError(errors, `identity.${key}`, `显示名称不能引用 secret 字段 ${leaked[0]}`)
    }
  }
  validateLifecycleActions(pack, errors, fields, groupFields, statusDefinitions.ids, itemDefinitions.ids, abilityDefinitions.ids, limits)
  validateCommands(pack, errors, fields, groupFields, statusDefinitions.ids, itemDefinitions.ids, abilityDefinitions.ids, abilityDefinitions, diceSets, tables, templates, limits, options.extraFunctions)

  const packageVersion = pack.compatibility?.package_version || "1.0.0"
  pack.compatibility = { min_runtime: DICE_RULE_RUNTIME_VERSION, package_version: packageVersion, ...(pack.compatibility || {}) }
  pack.character = { fields: {}, ...(pack.character || {}) }
  pack.group = { fields: {}, ...(pack.group || {}) }
  pack.statuses ||= {}
  pack.items ||= {}
  pack.abilities ||= {}
  pack.events ||= {}
  pack.dice_sets ||= {}
  pack.tables ||= {}
  pack.templates ||= {}
  pack.limits = limits
  return { ok: errors.length === 0, pack, errors, warnings }
}
