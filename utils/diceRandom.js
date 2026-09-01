import crypto from "node:crypto"

const FLOAT_RANGE = 0x1_0000_0000
const MAX_RANDOM_INT_EXCLUSIVE = 2 ** 48

// Keep the same [0, 1) contract as Math.random for expression evaluators.
export function secureDiceRandom() {
  return crypto.randomInt(0, FLOAT_RANGE) / FLOAT_RANGE
}

export function secureDiceInt(sides) {
  const normalized = Math.trunc(Number(sides))
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized + 1 > MAX_RANDOM_INT_EXCLUSIVE) {
    throw new RangeError("骰子面数超出安全随机范围")
  }
  return crypto.randomInt(1, normalized + 1)
}
