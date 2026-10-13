import { test } from "node:test"
import assert from "node:assert/strict"
import { cleanImageGenerationAddress, compileImagePrompt } from "../utils/promptCompiler.js"
import { buildImageGenerationPrompt } from "../apps/lib/promptContext.js"
const names = ["希洛", "哈基米", "A+B"]
test("removes only leading bot addresses and drawing request wrappers", () => {
  for (const input of ["希洛画只小洛包", "希洛，帮我画一只小洛包", "@希洛 请画只小洛包"]) assert.equal(cleanImageGenerationAddress(input, names), "小洛包")
  assert.equal(cleanImageGenerationAddress("A+B画个包子", names), "包子")
  assert.equal(cleanImageGenerationAddress("希洛画一座城堡", names), "一座城堡")
  assert.equal(cleanImageGenerationAddress("希洛画两只小洛包", names), "两只小洛包")
  for (const input of ["画希洛", "希洛和小洛包坐在一起", "写上希洛", "画一只希洛猫"]) assert.equal(cleanImageGenerationAddress(input, names), input)
  assert.equal(cleanImageGenerationAddress('希洛画一只写着“希洛”的小洛包', names), '写着“希洛”的小洛包')
})
test("host compilation applies the configured persona name and preserves supplements", () => {
  const host = { config: { persona: { name: "希洛" }, triggerPrefixes: ["哈基米"] }, getQuotedPromptContextText: () => "", getRecentPromptContextText: () => "", getRecentDrawContextText: () => "" }
  const result = buildImageGenerationPrompt(host, { args: "希洛画只小洛包" })
  assert.match(result, /\n小洛包\n/)
  assert.doesNotMatch(result, /希洛/)
  assert.match(result, /未明确要求文字时不要额外添加文字/)
  const merged = buildImageGenerationPrompt(host, { e: { _mergedOriginalTexts: ["希洛画只小洛包", "换成下午，比例9:16"] } })
  assert.match(merged, /小洛包/); assert.match(merged, /下午，比例9:16/)
})
test("explicit lettering and image editing remain intact", () => {
  const result = compileImagePrompt({ task: "image_generation", userPrompt: '希洛画一只小洛包，写上“希洛”', botNames: names })
  assert.match(result, /小洛包，写上“希洛”/)
  const edit = compileImagePrompt({ task: "image_edit", userPrompt: "把希洛字样去掉", botNames: names })
  assert.match(edit, /把希洛字样去掉/)
})
