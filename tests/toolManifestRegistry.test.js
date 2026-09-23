import assert from "node:assert/strict"
import { test } from "node:test"
import {
  getAllRegisteredIntentManifests,
  isBackgroundTerminalTool,
  isTerminalTool,
  registerToolManifest,
  registerToolManifests,
  resetToolManifestRegistry
} from "../utils/toolManifestRegistry.js"

test("manifest 声明 terminal 后终态集合立即可见,重置后恢复默认", () => {
  resetToolManifestRegistry()
  assert.equal(isTerminalTool("sendLocalEmojiTool"), true, "legacy 默认终态保留")
  assert.equal(isTerminalTool("someNewTool"), false)
  registerToolManifest({ name: "someNewTool", terminal: true, background: true })
  assert.equal(isTerminalTool("someNewTool"), true, "注册后即终态,无需改 messageIntent")
  assert.equal(isBackgroundTerminalTool("someNewTool"), true)
  resetToolManifestRegistry()
  assert.equal(isTerminalTool("someNewTool"), false, "重置后恢复")
})

test("manifest 的触发词/披露/确定性解析器进入意图清单合并视图", async () => {
  resetToolManifestRegistry()
  const resolver = text => ({ value: text })
  registerToolManifest({
    name: "demoTool",
    triggers: [/demo/i],
    disclosure: "DEMO RULES",
    deterministicResolver: resolver
  })
  const registered = getAllRegisteredIntentManifests()
  assert.equal(registered.demoTool.disclosure, "DEMO RULES")
  assert.equal(registered.demoTool.deterministicResolver, resolver)
  assert.deepEqual(registered.demoTool.triggers, [/demo/i])

  // toolIntentManifests 的合并视图能看到注册清单
  const { selectToolIntentCandidates, buildToolIntentDisclosure } = await import("../utils/toolIntentManifests.js")
  assert.deepEqual(selectToolIntentCandidates("来个demo", ["demoTool"]), ["demoTool"])
  assert.match(buildToolIntentDisclosure(["demoTool"]), /DEMO RULES/)
  resetToolManifestRegistry()
  assert.deepEqual(selectToolIntentCandidates("来个demo", ["demoTool"]), [], "重置后注册清单不再参与候选")
})

test("Pixiv 的 manifest 声明完整(终态/触发词/披露/下载解析器)", async () => {
  const { PIXIV_SEARCH_TOOL_MANIFEST, PIXIV_DOWNLOAD_TOOL_MANIFEST } = await import("../utils/pixivIntent.js")
  registerToolManifests([PIXIV_SEARCH_TOOL_MANIFEST, PIXIV_DOWNLOAD_TOOL_MANIFEST])
  assert.equal(isTerminalTool("pixivSearchTool"), true)
  assert.equal(isTerminalTool("pixivDownloadTool"), true)
  assert.ok(PIXIV_SEARCH_TOOL_MANIFEST.triggers.length >= 3)
  assert.match(PIXIV_SEARCH_TOOL_MANIFEST.disclosure, /必应图搜的分工/)
  assert.equal(typeof PIXIV_DOWNLOAD_TOOL_MANIFEST.deterministicResolver, "function")
  assert.deepEqual(PIXIV_DOWNLOAD_TOOL_MANIFEST.deterministicResolver("下载 2"), { target: "2" })
  resetToolManifestRegistry()
})
