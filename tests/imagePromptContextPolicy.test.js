import { test } from "node:test"
import assert from "node:assert/strict"

async function loadPlugin(t) {
  globalThis.plugin ||= class {}
  globalThis.logger ||= {
    info() {},
    warn() {},
    error() {},
    debug() {},
    mark() {}
  }
  try {
    const modulePath = process.env.IMAGE_PROMPT_PLUGIN_MODULE || "../apps/test.js"
    const { ExamplePlugin } = await import(modulePath)
    return Object.create(ExamplePlugin.prototype)
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return null
    }
    throw error
  }
}

test("final image prompt keeps merged visual supplements and drops an unrelated follow-up", async t => {
  const plugin = await loadPlugin(t)
  if (!plugin) return

  const prompt = plugin.buildImageGenerationPrompt({
    e: {
      _mergedOriginalTexts: [
        "希洛帮我画一个白发少女",
        "换成下午，比例9:16",
        "对了，明天开会吗"
      ]
    },
    args: "同一个人连续发了三条消息"
  })

  assert.match(prompt, /白发少女/)
  assert.match(prompt, /下午，比例9:16/)
  assert.doesNotMatch(prompt, /明天开会/)
})

test("continuing a drawing uses only the latest draw thread", async t => {
  const plugin = await loadPlugin(t)
  if (!plugin) return

  const prompt = plugin.buildImageGenerationPrompt({
    args: "继续上一张，换成下午",
    currentIntentText: "继续上一张，换成下午",
    groupUserMessages: [
      { role: "user", content: "[10:00] 用户: 希洛画一只黑猫" },
      { role: "assistant", content: "我先画一只黑猫。" },
      { role: "user", content: "[10:01] 用户: 火锅还是番茄锅好吃" },
      { role: "user", content: "[10:02] 用户: 希洛画一只白狗" },
      { role: "assistant", content: "这张白狗我继续画。" }
    ]
  })

  assert.match(prompt, /继续上一张，换成下午/)
  assert.match(prompt, /白狗/)
  assert.doesNotMatch(prompt, /黑猫/)
  assert.doesNotMatch(prompt, /火锅/)
})

test("explicitly drawing the conversation is allowed to use recent source messages", async t => {
  const plugin = await loadPlugin(t)
  if (!plugin) return

  const prompt = plugin.buildImageGenerationPrompt({
    args: "把上面的聊天画成四格漫画",
    currentIntentText: "把上面的聊天画成四格漫画",
    groupUserMessages: [
      { role: "user", content: "A说今晚一起去看烟花" },
      { role: "user", content: "B说才不是特意等你" }
    ]
  })

  assert.match(prompt, /今晚一起去看烟花/)
  assert.match(prompt, /才不是特意等你/)
})

test("an explicit quote does not also pull unrelated recent chat", async t => {
  const plugin = await loadPlugin(t)
  if (!plugin) return

  const prompt = plugin.buildImageGenerationPrompt({
    e: { _quotedPromptContext: { text: "白发金瞳、黑色长裙", senderName: "A" } },
    args: "按这个设定画一张",
    currentIntentText: "按这个设定画一张",
    groupUserMessages: [
      { role: "user", content: "刚才大家在讨论火锅和明天开会" }
    ]
  })

  assert.match(prompt, /白发金瞳、黑色长裙/)
  assert.doesNotMatch(prompt, /火锅/)
  assert.doesNotMatch(prompt, /明天开会/)
})

test("executing a quoted draw request keeps its image-generation intent", async t => {
  const plugin = await loadPlugin(t)
  if (!plugin) return

  const resolved = plugin.resolveContextualDrawGeneration({
    e: { _quotedPromptContext: { text: "希洛，生成一张白发少女的插画", senderName: "A" } },
    args: "执行一次上面的内容",
    currentIntentText: "执行一次上面的内容",
    userContent: "[回复 A 的消息: 希洛，生成一张白发少女的插画]"
  })

  assert.equal(resolved?.reason, "draw_context_continuation")
  assert.match(resolved?.prompt || "", /白发少女/)
})
