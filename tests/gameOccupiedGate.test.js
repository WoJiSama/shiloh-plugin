import test from "node:test"
import assert from "node:assert/strict"

test("game session registry publishes and reads process-wide active groups", async () => {
  const registry = await import("../dist/backend/modules/games/infrastructure/gameSessionRegistry.js")
  assert.equal(registry.readActiveGameGroups().size, 0)
  const groups = new Set(["100"])
  registry.publishActiveGameGroups(() => groups)
  assert.equal(registry.readActiveGameGroups().has("100"), true)
  registry.publishActiveGameGroups(() => new Set())
  assert.equal(registry.readActiveGameGroups().size, 0)
  registry.publishActiveGameGroups(() => { throw new Error("boom") })
  assert.equal(registry.readActiveGameGroups().size, 0)
})

test("conversation prefilter silences the persona while a game occupies the group", async () => {
  const {createConversationPrefilter} = await import("../dist/backend/modules/conversation/infrastructure/conversationPrefilter.js")
  const {publishActiveGameGroups} = await import("../dist/backend/modules/games/infrastructure/gameSessionRegistry.js")
  const prefilter = createConversationPrefilter({bot: () => ({uin: "3094088525"}), resolvePersonaName: () => "希洛", logger: {warn() {}}})
  const host = {config: {}, getPersonaFor: () => null}
  const state = {}
  const event = {group_id: "100", user_id: "u1", msg: "希洛你好呀", message: [], bot: {uin: "3094088525"}}

  publishActiveGameGroups(() => new Set(["100"]))
  assert.deepEqual(prefilter.prefilterMessage(host, event, state), {kind: "game_occupied", reason: "game_in_progress"})

  publishActiveGameGroups(() => new Set(["999"]))
  const free = prefilter.prefilterMessage(host, event, state)
  assert.notEqual(free.kind, "game_occupied")

  publishActiveGameGroups(() => new Set())
})
