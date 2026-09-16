const DEFAULT_MAX_NUMBER = 10
const DEFAULT_OPERATORS = ["add", "sub"]

export function normalizeQuestionMaxNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_MAX_NUMBER
  return Math.max(1, Math.min(100, Math.floor(number)))
}

export function normalizeQuestionOperators(value) {
  const rawList = Array.isArray(value) ? value : String(value || "").split(/[,，\s]+/)
  const operators = rawList
    .map(item => String(item || "").trim().toLowerCase())
    .map(item => {
      if (["add", "addition", "+", "加", "加法"].includes(item)) return "add"
      if (["sub", "subtract", "subtraction", "-", "减", "减法"].includes(item)) return "sub"
      return ""
    })
    .filter(Boolean)

  return [...new Set(operators)].length ? [...new Set(operators)] : [...DEFAULT_OPERATORS]
}

function randomInt(maxInclusive, random = Math.random) {
  return Math.floor(random() * (maxInclusive + 1))
}

export function generateMathQuestion(config = {}, random = Math.random) {
  const maxNumber = normalizeQuestionMaxNumber(config.questionMaxNumber ?? config.maxNumber)
  const operators = normalizeQuestionOperators(config.questionOperators ?? config.operators)
  const op = operators[Math.floor(random() * operators.length)] || "add"

  if (op === "sub") {
    const a = randomInt(maxNumber, random)
    const b = randomInt(a, random)
    return { question: `${a} - ${b} = ?`, answer: String(a - b), operator: "sub" }
  }

  const a = randomInt(maxNumber, random)
  const b = randomInt(maxNumber - a, random)
  return { question: `${a} + ${b} = ?`, answer: String(a + b), operator: "add" }
}
