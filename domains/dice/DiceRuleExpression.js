const DEFAULT_MAX_LENGTH = 512
const DEFAULT_MAX_DEPTH = 32
const DEFAULT_MAX_NODES = 256
const DEFAULT_MAX_ABS_VALUE = 1e12
const BLOCKED_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"])

export class DiceRuleExpressionError extends Error {
  constructor(message, position = -1, code = "expression_error") {
    super(position >= 0 ? `${message}（位置 ${position + 1}）` : message)
    this.name = "DiceRuleExpressionError"
    this.code = code
    this.position = position
  }
}

class Lexer {
  constructor(source) {
    this.source = source
    this.pos = 0
  }

  next() {
    while (/\s/.test(this.source[this.pos] || "")) this.pos += 1
    if (this.pos >= this.source.length) return { type: "eof", value: "", pos: this.pos }
    const pos = this.pos
    const rest = this.source.slice(pos)
    const dice = rest.match(/^(?:\d*)[dD]\d+(?:(?:kh|kl|dh|dl|min|max)\d*)?(?![A-Za-z0-9_])/i)
    if (dice) {
      this.pos += dice[0].length
      return { type: "dice", value: dice[0], pos }
    }
    const number = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)/)
    if (number) {
      this.pos += number[0].length
      return { type: "number", value: Number(number[0]), pos }
    }
    const first = this.source[pos]
    if (first === "'" || first === '"') return this.readString(first, pos)
    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/)
    if (identifier) {
      this.pos += identifier[0].length
      return { type: "identifier", value: identifier[0], pos }
    }
    for (const operator of ["&&", "||", "==", "!=", "<=", ">="]) {
      if (rest.startsWith(operator)) {
        this.pos += operator.length
        return { type: "operator", value: operator, pos }
      }
    }
    if ("+-*/%!<>?:".includes(first)) {
      this.pos += 1
      return { type: "operator", value: first, pos }
    }
    if ("(),.".includes(first)) {
      this.pos += 1
      return { type: "punctuation", value: first, pos }
    }
    throw new DiceRuleExpressionError(`不支持的字符 ${JSON.stringify(first)}`, pos, "invalid_character")
  }

  readString(quote, pos) {
    this.pos += 1
    let value = ""
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos++]
      if (ch === quote) return { type: "string", value, pos }
      if (ch !== "\\") {
        value += ch
        continue
      }
      if (this.pos >= this.source.length) break
      const escaped = this.source[this.pos++]
      const mapped = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' }[escaped]
      value += mapped === undefined ? escaped : mapped
    }
    throw new DiceRuleExpressionError("字符串没有闭合", pos, "unterminated_string")
  }
}

class Parser {
  constructor(source, options = {}) {
    const text = String(source ?? "").trim()
    const maxLength = Number(options.maxLength) || DEFAULT_MAX_LENGTH
    if (!text) throw new DiceRuleExpressionError("表达式不能为空", 0, "empty_expression")
    if (text.length > maxLength) throw new DiceRuleExpressionError(`表达式长度超过上限 ${maxLength}`, maxLength, "expression_too_long")
    this.source = text
    this.lexer = new Lexer(text)
    this.current = this.lexer.next()
    this.nodeCount = 0
    this.maxNodes = Number(options.maxNodes) || DEFAULT_MAX_NODES
    this.maxDepth = Number(options.maxDepth) || DEFAULT_MAX_DEPTH
  }

  parse() {
    const ast = this.parseTernary(0)
    if (this.current.type !== "eof") throw new DiceRuleExpressionError(`无法识别 ${this.current.value}`, this.current.pos, "unexpected_token")
    return ast
  }

  node(type, props, depth) {
    this.nodeCount += 1
    if (this.nodeCount > this.maxNodes) throw new DiceRuleExpressionError(`表达式节点数超过上限 ${this.maxNodes}`, this.current.pos, "too_many_nodes")
    if (depth > this.maxDepth) throw new DiceRuleExpressionError(`表达式嵌套超过上限 ${this.maxDepth}`, this.current.pos, "expression_too_deep")
    return { type, ...props }
  }

  consume(value) {
    if (this.current.value !== value) throw new DiceRuleExpressionError(`需要 ${value}`, this.current.pos, "expected_token")
    const token = this.current
    this.current = this.lexer.next()
    return token
  }

  parseTernary(depth) {
    let test = this.parseBinary(1, depth + 1)
    if (this.current.value !== "?") return test
    const pos = this.consume("?").pos
    const consequent = this.parseTernary(depth + 1)
    this.consume(":")
    const alternate = this.parseTernary(depth + 1)
    test = this.node("ConditionalExpression", { test, consequent, alternate, pos }, depth)
    return test
  }

  parseBinary(minPrecedence, depth) {
    let left = this.parseUnary(depth + 1)
    const precedence = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 }
    while (this.current.type === "operator" && (precedence[this.current.value] || 0) >= minPrecedence) {
      const operator = this.current.value
      const pos = this.current.pos
      const operatorPrecedence = precedence[operator]
      this.current = this.lexer.next()
      const right = this.parseBinary(operatorPrecedence + 1, depth + 1)
      left = this.node("BinaryExpression", { operator, left, right, pos }, depth)
    }
    return left
  }

  parseUnary(depth) {
    if (this.current.type === "operator" && ["+", "-", "!"].includes(this.current.value)) {
      const operator = this.current.value
      const pos = this.current.pos
      this.current = this.lexer.next()
      return this.node("UnaryExpression", { operator, argument: this.parseUnary(depth + 1), pos }, depth)
    }
    return this.parsePrimary(depth + 1)
  }

  parsePrimary(depth) {
    const token = this.current
    if (token.type === "number" || token.type === "string") {
      this.current = this.lexer.next()
      return this.node("Literal", { value: token.value, pos: token.pos }, depth)
    }
    if (token.type === "dice") {
      this.current = this.lexer.next()
      return this.node("DiceExpression", { raw: token.value, pos: token.pos }, depth)
    }
    if (token.value === "(") {
      this.current = this.lexer.next()
      const expression = this.parseTernary(depth + 1)
      this.consume(")")
      return expression
    }
    if (token.type !== "identifier") throw new DiceRuleExpressionError(`无法识别 ${token.value || "表达式结尾"}`, token.pos, "unexpected_token")
    this.current = this.lexer.next()
    if (["true", "false", "null"].includes(token.value)) {
      const value = token.value === "true" ? true : token.value === "false" ? false : null
      return this.node("Literal", { value, pos: token.pos }, depth)
    }
    if (this.current.value === "(") {
      this.current = this.lexer.next()
      const args = []
      if (this.current.value !== ")") {
        while (true) {
          args.push(this.parseTernary(depth + 1))
          if (this.current.value !== ",") break
          this.current = this.lexer.next()
        }
      }
      this.consume(")")
      return this.node("CallExpression", { name: token.value, arguments: args, pos: token.pos }, depth)
    }
    const path = [token.value]
    while (this.current.value === ".") {
      this.current = this.lexer.next()
      if (this.current.type !== "identifier") throw new DiceRuleExpressionError("属性路径不完整", this.current.pos, "invalid_path")
      path.push(this.current.value)
      this.current = this.lexer.next()
    }
    if (path.some(part => BLOCKED_PATH_PARTS.has(part))) throw new DiceRuleExpressionError("属性路径包含禁止字段", token.pos, "blocked_path")
    return this.node("Reference", { path, pos: token.pos }, depth)
  }
}

export function parseDiceRuleExpression(source, options = {}) {
  return new Parser(source, options).parse()
}

export function collectExpressionReferences(ast) {
  const references = []
  const calls = []
  let containsDice = false
  const visit = node => {
    if (!node) return
    if (node.type === "Reference") references.push(node.path.join("."))
    if (node.type === "DiceExpression") containsDice = true
    if (node.type === "CallExpression") {
      calls.push(node.name)
      for (const arg of node.arguments) visit(arg)
    }
    if (node.type === "UnaryExpression") visit(node.argument)
    if (node.type === "BinaryExpression") {
      visit(node.left)
      visit(node.right)
    }
    if (node.type === "ConditionalExpression") {
      visit(node.test)
      visit(node.consequent)
      visit(node.alternate)
    }
  }
  visit(ast)
  return { references, calls, containsDice }
}

function safeNumber(value, position, maxAbsValue) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new DiceRuleExpressionError("计算结果不是有限数字", position, "non_finite_number")
  if (Math.abs(number) > maxAbsValue) throw new DiceRuleExpressionError(`计算结果超过安全范围 ${maxAbsValue}`, position, "number_out_of_range")
  return number
}

function ownPath(context, path, position) {
  let value = context
  for (const part of path) {
    if (BLOCKED_PATH_PARTS.has(part) || value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) {
      throw new DiceRuleExpressionError(`未知值引用 ${path.join(".")}`, position, "unknown_reference")
    }
    value = value[part]
  }
  return value
}

function weightedFace(faces, random) {
  const normalized = faces.map(face => typeof face === "object" && face !== null
    ? { value: Number(face.value), text: String(face.text ?? face.value), weight: Math.max(1, Math.floor(Number(face.weight) || 1)) }
    : { value: Number(face), text: String(face), weight: 1 })
  const totalWeight = normalized.reduce((sum, face) => sum + face.weight, 0)
  let cursor = Math.floor(random() * totalWeight)
  for (const face of normalized) {
    if (cursor < face.weight) return face
    cursor -= face.weight
  }
  return normalized[normalized.length - 1]
}

function rollSuccessPool(name, args, node, state) {
  const [countRaw, sidesRaw, targetRaw, explodeRaw = 0, rerollRaw = 0, botchRaw = 0] = args.map(value => safeNumber(value, node.pos, state.maxAbsValue))
  const count = Math.trunc(countRaw)
  const sides = Math.trunc(sidesRaw)
  const target = Math.trunc(targetRaw)
  const explodeAt = Math.trunc(explodeRaw)
  const rerollBelow = Math.trunc(rerollRaw)
  const botchAt = Math.trunc(botchRaw)
  if (!Number.isInteger(countRaw) || count < 1) throw new DiceRuleExpressionError(`${name} 的骰子数量必须是正整数`, node.pos, "invalid_dice_count")
  if (!Number.isInteger(sidesRaw) || sides < 2) throw new DiceRuleExpressionError(`${name} 的面数必须是至少 2 的整数`, node.pos, "invalid_dice_sides")
  if (target < 1 || target > sides) throw new DiceRuleExpressionError(`${name} 的成功阈值必须在 1-${sides}`, node.pos, "invalid_pool_target")
  if (explodeAt && (explodeAt < 2 || explodeAt > sides)) throw new DiceRuleExpressionError(`${name} 的爆骰阈值必须在 2-${sides}，或设为 0`, node.pos, "invalid_pool_explode")
  if (rerollBelow && (rerollBelow < 1 || rerollBelow >= sides)) throw new DiceRuleExpressionError(`${name} 的重掷阈值必须在 1-${sides - 1}，或设为 0`, node.pos, "invalid_pool_reroll")
  if (botchAt && (botchAt < 1 || botchAt >= target)) throw new DiceRuleExpressionError(`${name} 的抵消阈值必须小于成功阈值，或设为 0`, node.pos, "invalid_pool_botch")
  const rolls = []
  const queue = Array.from({ length: count }, () => ({ exploded: false }))
  let successes = 0
  let failures = 0
  while (queue.length) {
    queue.shift()
    state.diceCount += 1
    if (state.diceCount > state.maxDiceCount) throw new DiceRuleExpressionError(`骰子总数超过上限 ${state.maxDiceCount}`, node.pos, "too_many_dice")
    let value = Math.floor(state.random() * sides) + 1
    let rerolled = false
    if (rerollBelow && value <= rerollBelow) {
      state.diceCount += 1
      if (state.diceCount > state.maxDiceCount) throw new DiceRuleExpressionError(`骰子总数超过上限 ${state.maxDiceCount}`, node.pos, "too_many_dice")
      const before = value
      value = Math.floor(state.random() * sides) + 1
      rolls.push(`${before}→${value}`)
      rerolled = true
    }
    if (!rerolled) rolls.push(String(value))
    if (value >= target) successes += 1
    if (botchAt && value <= botchAt) failures += 1
    if (explodeAt && value >= explodeAt) queue.push({ exploded: true })
  }
  const net = Math.max(0, successes - failures)
  state.traces.push(`${name}[${rolls.join(",")}]成功${successes}${botchAt ? `-抵消${failures}` : ""}=${net}`)
  return net
}

function callBuiltin(name, args, node, state) {
  const numeric = () => args.map(value => safeNumber(value, node.pos, state.maxAbsValue))
  if (name === "min") return Math.min(...numeric())
  if (name === "max") return Math.max(...numeric())
  if (name === "abs") return Math.abs(safeNumber(args[0], node.pos, state.maxAbsValue))
  if (name === "floor") return Math.floor(safeNumber(args[0], node.pos, state.maxAbsValue))
  if (name === "ceil") return Math.ceil(safeNumber(args[0], node.pos, state.maxAbsValue))
  if (name === "round") return Math.round(safeNumber(args[0], node.pos, state.maxAbsValue))
  if (name === "sqrt") {
    const value = safeNumber(args[0], node.pos, state.maxAbsValue)
    if (value < 0) throw new DiceRuleExpressionError("sqrt 不能接收负数", node.pos, "invalid_function_argument")
    return Math.sqrt(value)
  }
  if (name === "pow") return Math.pow(...numeric().slice(0, 2))
  if (name === "clamp") {
    const [value, min, max] = numeric()
    if (min > max) throw new DiceRuleExpressionError("clamp 的最小值不能大于最大值", node.pos, "invalid_function_argument")
    return Math.min(max, Math.max(min, value))
  }
  if (name === "if") return args[0] ? args[1] : args[2]
  if (name === "coalesce") return args[0] === null || args[0] === undefined ? args[1] : args[0]
  if (name === "len") return Array.from(String(args[0] ?? "")).length
  if (name === "cancel") return Math.max(0, safeNumber(args[0], node.pos, state.maxAbsValue) - safeNumber(args[1], node.pos, state.maxAbsValue))
  if (["successes", "explode", "reroll", "pool"].includes(name)) {
    if (name === "successes") return rollSuccessPool(name, [args[0], args[1], args[2], 0, 0, 0], node, state)
    if (name === "explode") return rollSuccessPool(name, [args[0], args[1], args[2], args[3], 0, 0], node, state)
    if (name === "reroll") return rollSuccessPool(name, [args[0], args[1], args[2], 0, args[3], 0], node, state)
    return rollSuccessPool(name, args, node, state)
  }
  if (name === "dice") {
    const diceName = String(args[0] ?? "")
    const count = safeNumber(args[1], node.pos, state.maxAbsValue)
    const definition = state.diceSets[diceName]
    if (!definition || !Array.isArray(definition.faces)) throw new DiceRuleExpressionError(`未知自定义骰 ${diceName}`, node.pos, "unknown_dice_set")
    if (!Number.isInteger(count) || count < 1) throw new DiceRuleExpressionError("自定义骰数量必须是正整数", node.pos, "invalid_dice_count")
    state.diceCount += count
    if (state.diceCount > state.maxDiceCount) throw new DiceRuleExpressionError(`骰子总数超过上限 ${state.maxDiceCount}`, node.pos, "too_many_dice")
    const rolled = Array.from({ length: count }, () => weightedFace(definition.faces, state.random))
    if (rolled.some(face => !Number.isFinite(face.value))) throw new DiceRuleExpressionError(`自定义骰 ${diceName} 包含非数字骰面`, node.pos, "invalid_dice_face")
    const total = rolled.reduce((sum, face) => sum + face.value, 0)
    state.traces.push(`${definition.label || diceName}[${rolled.map(face => face.text).join(",")}]`)
    return total
  }
  throw new DiceRuleExpressionError(`不支持的函数 ${name}`, node.pos, "unknown_function")
}

function evaluateNode(node, context, state) {
  if (node.type === "Literal") return node.value
  if (node.type === "Reference") return ownPath(context, node.path, node.pos)
  if (node.type === "DiceExpression") {
    const count = Number(node.raw.match(/^(\d*)[dD]/)?.[1] || 1)
    state.diceCount += count
    if (state.diceCount > state.maxDiceCount) throw new DiceRuleExpressionError(`骰子总数超过上限 ${state.maxDiceCount}`, node.pos, "too_many_dice")
    if (typeof state.rollStandard !== "function") throw new DiceRuleExpressionError("标准骰执行器不可用", node.pos, "dice_executor_unavailable")
    const result = state.rollStandard(node.raw)
    state.traces.push(String(result.detail || `${node.raw}=${result.total}`))
    return safeNumber(result.total, node.pos, state.maxAbsValue)
  }
  if (node.type === "UnaryExpression") {
    const value = evaluateNode(node.argument, context, state)
    if (node.operator === "!") return !value
    if (node.operator === "+") return safeNumber(value, node.pos, state.maxAbsValue)
    return -safeNumber(value, node.pos, state.maxAbsValue)
  }
  if (node.type === "BinaryExpression") {
    const left = evaluateNode(node.left, context, state)
    if (node.operator === "&&") return left && evaluateNode(node.right, context, state)
    if (node.operator === "||") return left || evaluateNode(node.right, context, state)
    const right = evaluateNode(node.right, context, state)
    if (node.operator === "==") return typeof left === typeof right && left === right
    if (node.operator === "!=") return typeof left !== typeof right || left !== right
    if (["<", "<=", ">", ">="].includes(node.operator)) {
      if (typeof left !== typeof right || !["number", "string"].includes(typeof left)) throw new DiceRuleExpressionError("比较两侧类型必须一致", node.pos, "type_mismatch")
      return node.operator === "<" ? left < right : node.operator === "<=" ? left <= right : node.operator === ">" ? left > right : left >= right
    }
    if (node.operator === "+" && typeof left === "string" && typeof right === "string") return left + right
    const a = safeNumber(left, node.pos, state.maxAbsValue)
    const b = safeNumber(right, node.pos, state.maxAbsValue)
    if ((node.operator === "/" || node.operator === "%") && b === 0) throw new DiceRuleExpressionError("不能除以零", node.pos, "division_by_zero")
    const value = node.operator === "+" ? a + b : node.operator === "-" ? a - b : node.operator === "*" ? a * b : node.operator === "/" ? a / b : a % b
    return safeNumber(value, node.pos, state.maxAbsValue)
  }
  if (node.type === "ConditionalExpression") {
    return evaluateNode(node.test, context, state)
      ? evaluateNode(node.consequent, context, state)
      : evaluateNode(node.alternate, context, state)
  }
  if (node.type === "CallExpression") {
    if (node.name === "if") {
      if (node.arguments.length !== 3) throw new DiceRuleExpressionError("if 需要 3 个参数", node.pos, "invalid_argument_count")
      const test = evaluateNode(node.arguments[0], context, state)
      return evaluateNode(test ? node.arguments[1] : node.arguments[2], context, state)
    }
    if (node.name === "coalesce") {
      if (node.arguments.length !== 2) throw new DiceRuleExpressionError("coalesce 需要 2 个参数", node.pos, "invalid_argument_count")
      try {
        const first = evaluateNode(node.arguments[0], context, state)
        return first === null || first === undefined ? evaluateNode(node.arguments[1], context, state) : first
      } catch (error) {
        if (error?.code !== "unknown_reference") throw error
        return evaluateNode(node.arguments[1], context, state)
      }
    }
    const expectedCounts = { min: [1, Infinity], max: [1, Infinity], clamp: [3, 3], abs: [1, 1], floor: [1, 1], ceil: [1, 1], round: [1, 1], sqrt: [1, 1], pow: [2, 2], len: [1, 1], dice: [2, 2], cancel: [2, 2], successes: [3, 3], explode: [4, 4], reroll: [4, 4], pool: [3, 6] }
    const range = expectedCounts[node.name]
    if (!range) {
      // JS 规则包注册的自定义函数（仅主人可导入，见 DiceRulePackManager）
      const custom = state.customFunctions?.[node.name]
      if (typeof custom !== "function") throw new DiceRuleExpressionError(`不支持的函数 ${node.name}`, node.pos, "unknown_function")
      const args = node.arguments.map(arg => evaluateNode(arg, context, state))
      try {
        const value = custom(args, { context, state })
        if (typeof value === "number") return safeNumber(value, node.pos, state.maxAbsValue)
        if (typeof value === "string" || typeof value === "boolean" || value === null) return value
        throw new Error("返回值必须是数字/字符串/布尔")
      } catch (error) {
        throw new DiceRuleExpressionError(`自定义函数 ${node.name} 执行失败：${error.message}`, node.pos, "custom_function_error")
      }
    }
    if (node.arguments.length < range[0] || node.arguments.length > range[1]) throw new DiceRuleExpressionError(`${node.name} 参数数量不正确`, node.pos, "invalid_argument_count")
    const args = node.arguments.map(arg => evaluateNode(arg, context, state))
    return callBuiltin(node.name, args, node, state)
  }
  throw new DiceRuleExpressionError(`未知表达式节点 ${node.type}`, node.pos, "unknown_node")
}

export function evaluateDiceRuleExpression(sourceOrAst, context = {}, options = {}) {
  const ast = typeof sourceOrAst === "string" ? parseDiceRuleExpression(sourceOrAst, options) : sourceOrAst
  const state = {
    diceSets: options.diceSets || {},
    rollStandard: options.rollStandard,
    random: typeof options.random === "function" ? options.random : secureDiceRandom,
    maxDiceCount: Math.max(1, Number(options.maxDiceCount) || 100),
    maxAbsValue: Math.max(1, Number(options.maxAbsValue) || DEFAULT_MAX_ABS_VALUE),
    customFunctions: options.customFunctions || null,
    diceCount: 0,
    traces: []
  }
  const value = evaluateNode(ast, context, state)
  if (typeof value === "number") safeNumber(value, ast.pos, state.maxAbsValue)
  return { value, traces: state.traces, diceCount: state.diceCount, ast }
}
import { secureDiceRandom } from "../../utils/diceRandom.js"
