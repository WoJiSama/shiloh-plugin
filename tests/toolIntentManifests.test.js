import test from "node:test"
import assert from "node:assert/strict"
import {
  buildToolIntentDisclosure,
  resolveDeterministicToolIntent,
  resolveToolRequestMergeMs,
  selectToolIntentCandidates
} from "../utils/toolIntentManifests.js"
import {
  classifyEmojiToolExposure,
  filterToolsForEmojiExposure,
  resolveForcedReactionEmoji,
  shouldExposeEmojiToolForMessage
} from "../utils/emojiToolPolicy.js"

test("selects delta force manifest for natural delta force requests", () => {
  const available = ["searchInformationTool", "deltaForceTool", "bananaTool"]
  const candidates = selectToolIntentCandidates(
    "希洛发一下今天的三角洲的改枪码，我要和277有关的",
    available
  )
  assert.deepEqual(candidates, ["deltaForceTool"])

  const disclosure = buildToolIntentDisclosure(candidates)
  assert.match(disclosure, /operation=solution_list/)
  assert.match(disclosure, /keyword/)
  assert.match(disclosure, /277/)
  assert.match(disclosure, /名字有 非洲/)
  assert.match(disclosure, /"keyword":"非洲"/)
})

test("does not disclose unavailable or unrelated tool manifests", () => {
  assert.deepEqual(
    selectToolIntentCandidates("希洛发一下三角洲今日密码", ["searchInformationTool"]),
    []
  )
  assert.deepEqual(
    selectToolIntentCandidates("希洛帮我画一张猫", ["deltaForceTool", "bananaTool"]),
    []
  )
})

test("selects common tool manifests from natural language", () => {
  assert.deepEqual(
    selectToolIntentCandidates("半小时后提醒我收菜", ["reminderTool", "searchInformationTool"]),
    ["reminderTool"]
  )
  assert.match(buildToolIntentDisclosure(["reminderTool"]), /action=create/)

  assert.deepEqual(
    selectToolIntentCandidates("来首周杰伦的歌", ["searchMusicTool", "searchInformationTool"]),
    ["searchMusicTool"]
  )
  assert.match(buildToolIntentDisclosure(["searchMusicTool"]), /isArtistOnly=true/)

  assert.deepEqual(
    selectToolIntentCandidates("把这段内容整理成思维导图", ["aiMindMapTool", "textImageTool"]),
    ["aiMindMapTool"]
  )

  assert.deepEqual(
    selectToolIntentCandidates("查一下预算表这个 tab 的 C12，公式和值都给我", ["excelWorkbookTool", "searchInformationTool"]),
    ["excelWorkbookTool"]
  )
  assert.match(buildToolIntentDisclosure(["excelWorkbookTool"]), /operation=read_cell/)
  assert.deepEqual(
    selectToolIntentCandidates("群文件里有哪些 Excel", ["excelWorkbookTool", "searchInformationTool"]),
    ["excelWorkbookTool"]
  )
  assert.deepEqual(
    selectToolIntentCandidates("看附近的单元格，有没有一个是尚虹叙开头的", ["excelWorkbookTool", "searchInformationTool"]),
    ["excelWorkbookTool"]
  )
  assert.match(buildToolIntentDisclosure(["excelWorkbookTool"]), /matchMode=starts_with/)

  assert.deepEqual(
    selectToolIntentCandidates(
      "查一下 Modrinth 1.21.1 Fabric 下载量前五的优化模组",
      ["modrinthTool", "searchInformationTool"]
    ),
    ["modrinthTool"]
  )
  assert.deepEqual(
    selectToolIntentCandidates(
      "希洛告诉我mc排行榜前10的冒险模组",
      ["modrinthTool", "searchInformationTool"]
    ),
    ["modrinthTool"]
  )
  assert.deepEqual(
    selectToolIntentCandidates(
      "希洛告诉我名字里面带有 nrg 的mc模组",
      ["modrinthTool", "searchInformationTool"]
    ),
    ["modrinthTool"]
  )
  assert.match(buildToolIntentDisclosure(["modrinthTool"]), /中文翻译（希洛）/)
  assert.deepEqual(
    selectToolIntentCandidates(
      "看看 https://modrinth.com/mod/sodium 这个 Modrinth 模组下载量排名",
      ["modrinthTool", "webParserTool", "searchInformationTool"]
    ),
    ["modrinthTool"]
  )
  assert.deepEqual(
    selectToolIntentCandidates(
      "帮我看看 https://modrinth.com/mod/sodium 这个 Modrinth 链接",
      ["modrinthTool", "webParserTool"]
    ),
    ["webParserTool"]
  )
})

test("uses deterministic fast paths only when one safe tool has complete parameters", () => {
  assert.deepEqual(
    resolveDeterministicToolIntent(
      "magnet:?xt=urn:btih:AF4B684892182408E4AE9DF0C8FFE9E49CCBF171",
      ["torrentDownloadTool"]
    ),
    {
      intent: "tool",
      toolName: "torrentDownloadTool",
      params: { magnet: "magnet:?xt=urn:btih:AF4B684892182408E4AE9DF0C8FFE9E49CCBF171" },
      reason: "deterministic_manifest"
    }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent("下载第2个, 3", ["torrentDownloadTool"]),
    {
      intent: "tool",
      toolName: "torrentDownloadTool",
      params: { selection: [2, 3] },
      reason: "deterministic_manifest"
    }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent(
      "查一下 Modrinth 1.21.1 Fabric 下载量前五的优化模组",
      ["modrinthTool", "searchInformationTool"]
    ),
    {
      intent: "tool",
      toolName: "modrinthTool",
      params: { sort: "downloads", limit: 5, gameVersion: "1.21.1", loader: "fabric", category: "optimization", query: "" },
      reason: "deterministic_manifest"
    }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent(
      "希洛告诉我mc排行榜前10的冒险模组",
      ["modrinthTool", "searchInformationTool"]
    ),
    {
      intent: "tool",
      toolName: "modrinthTool",
      params: { sort: "downloads", limit: 10, gameVersion: "", loader: "", category: "adventure", query: "" },
      reason: "deterministic_manifest"
    }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent(
      "希洛告诉我名字里面带有 nrg 的mc模组",
      ["modrinthTool", "searchInformationTool"]
    ),
    {
      intent: "tool",
      toolName: "modrinthTool",
      params: { sort: "relevance", limit: 5, gameVersion: "", loader: "", category: "", query: "nrg" },
      reason: "deterministic_manifest"
    }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent(
      "，Modrinth 下载量前十",
      ["modrinthTool", "sendLocalEmojiTool"]
    ),
    {
      intent: "tool",
      toolName: "modrinthTool",
      params: { sort: "downloads", limit: 10, gameVersion: "", loader: "", category: "", query: "" },
      reason: "deterministic_manifest"
    }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent(
      "希洛，Modrinth 最近更新的魔法模组前五",
      ["modrinthTool", "sendLocalEmojiTool"]
    ),
    {
      intent: "tool",
      toolName: "modrinthTool",
      params: { sort: "updated", limit: 5, gameVersion: "", loader: "", category: "magic", query: "" },
      reason: "deterministic_manifest"
    }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent(
      "希洛，告诉我Modrinth 最近更新的魔法模组前五",
      ["modrinthTool", "sendLocalEmojiTool"]
    )?.params,
    { sort: "updated", limit: 5, gameVersion: "", loader: "", category: "magic", query: "" }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent("读取预算表这个 tab 的 C12", ["excelWorkbookTool"], { hasExcelContext: true }),
    {
      intent: "tool",
      toolName: "excelWorkbookTool",
      params: { operation: "read_cell", sheetName: "预算表", cell: "C12" },
      reason: "deterministic_manifest"
    }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent("看看 https://github.com/openai/openai-node 这个仓库", ["githubRepoTool", "webParserTool"]),
    {
      intent: "tool",
      toolName: "githubRepoTool",
      params: { repoUrl: "https://github.com/openai/openai-node" },
      reason: "deterministic_manifest"
    }
  )
  assert.equal(resolveDeterministicToolIntent("禁言小明一分钟", ["jinyanTool"]), null)
  assert.equal(resolveDeterministicToolIntent("看附近有没有尚虹叙开头的单元格", ["excelWorkbookTool"], { hasExcelContext: true }), null)
})

test("shortens only deterministic tool merge windows", () => {
  assert.equal(resolveToolRequestMergeMs("查一下 Modrinth 热门模组前五", ["modrinthTool"], { defaultMs: 3000, fastMs: 600 }), 600)
  assert.equal(resolveToolRequestMergeMs("帮我画一只猫", ["bananaTool"], { defaultMs: 3000, fastMs: 600 }), 3000)
  assert.equal(resolveToolRequestMergeMs("禁言小明一分钟", ["jinyanTool"], { defaultMs: 3000, fastMs: 600 }), 3000)
})

test("prefers specific manifests over generic search or web parsing", () => {
  assert.deepEqual(
    selectToolIntentCandidates(
      "查一下三角洲今日密码",
      ["deltaForceTool", "searchInformationTool"]
    ),
    ["deltaForceTool"]
  )

  assert.deepEqual(
    selectToolIntentCandidates(
      "看看 https://github.com/user/repo 这个仓库",
      ["githubRepoTool", "webParserTool", "searchInformationTool"]
    ),
    ["githubRepoTool"]
  )

  assert.deepEqual(
    selectToolIntentCandidates(
      "帮我总结 https://example.com 这个页面",
      ["githubRepoTool", "webParserTool", "searchInformationTool"]
    ),
    ["webParserTool"]
  )
})

test("exposes the local emoji tool for explicit requests and ordinary short conversations", () => {
  const available = ["sendLocalEmojiTool", "searchInformationTool", "jinyanTool"]

  for (const text of ["来个无语表情包", "笑死我了", "这也太离谱了", "抱抱我", "早啊", "今天又下雨了", "你看他俩"]) {
    assert.notEqual(classifyEmojiToolExposure(text), "none", text)
    assert.equal(shouldExposeEmojiToolForMessage(text), true, text)
    assert.deepEqual(selectToolIntentCandidates(text, available), ["sendLocalEmojiTool"], text)
  }
  const disclosure = buildToolIntentDisclosure(["sendLocalEmojiTool"])
  assert.match(disclosure, /不调用=纯文字/)
  assert.match(disclosure, /tags 按相关度/)
})

test("casual emoji exposure only keeps sendLocalEmojiTool", () => {
  const tools = ["sendLocalEmojiTool", "searchInformationTool", "jinyanTool"].map(name => ({
    type: "function",
    function: { name }
  }))

  assert.deepEqual(
    filterToolsForEmojiExposure(tools, "绷不住了哈哈哈哈"),
    [tools[0]]
  )
  assert.deepEqual(filterToolsForEmojiExposure(tools, "普通聊天"), [tools[0]])
})

test("forces emoji-only replies for high-confidence short reactions", () => {
  assert.deepEqual(resolveForcedReactionEmoji("绷不住了哈哈哈哈"), {
    tags: ["笑死", "吐槽"],
    useCases: ["接梗吐槽"],
    replies: ["哈哈哈哈哈", "笑死我了", "这也太逗了"]
  })
  assert.deepEqual(resolveForcedReactionEmoji("这也太离谱了"), {
    tags: ["无语", "震惊", "吐槽"],
    useCases: ["无言以对", "看到离谱"],
    replies: ["不是吧", "这什么操作", "我直接看傻"]
  })
  assert.deepEqual(resolveForcedReactionEmoji("抱抱我"), {
    tags: ["安慰", "委屈"],
    useCases: ["安慰对方", "接梗摸头"],
    replies: ["摸摸", "抱一下", "来，安慰你"]
  })
  assert.equal(resolveForcedReactionEmoji("查一下这个离谱新闻"), null)
  assert.equal(resolveForcedReactionEmoji("你觉得这个方案是不是很离谱"), null)
  assert.equal(resolveForcedReactionEmoji("今天又下雨了"), null)
})

test("does not proactively expose emoji tool for serious or operational requests", () => {
  const cases = [
    "这个接口为什么报错，太无语了",
    "查一下这个离谱新闻",
    "禁言他，太无语了",
    "帮我分析这段代码，写得太离谱了",
    "网上搜一个无语表情包",
    "如何安慰一下失恋的朋友",
    "给我点20个赞",
    "戳一下小明",
    "用语音说晚安"
  ]

  for (const text of cases) {
    assert.equal(classifyEmojiToolExposure(text), "none", text)
    assert.doesNotMatch(selectToolIntentCandidates(text, ["sendLocalEmojiTool"]).join(","), /sendLocalEmojiTool/, text)
  }
  assert.deepEqual(
    selectToolIntentCandidates("查一下这个离谱新闻", ["sendLocalEmojiTool", "searchInformationTool"]),
    ["searchInformationTool"]
  )
  assert.deepEqual(
    selectToolIntentCandidates("网上搜一个无语表情包", ["sendLocalEmojiTool", "emojiSearchTool"]),
    ["emojiSearchTool"]
  )
})

test("ordinary emoji availability does not hide sibling operational tools", () => {
  const cases = [
    ["三角洲今日密码", "deltaForceTool"],
    ["半小时后提醒我收菜", "reminderTool"],
    ["来首周杰伦的歌", "searchMusicTool"],
    ["用语音说晚安", "voiceTool"],
    ["网上搜一个无语表情包", "emojiSearchTool"],
    ["查一下今天的天气", "searchInformationTool"],
    ["总结 https://example.com", "webParserTool"],
    ["看看 https://github.com/user/repo", "githubRepoTool"],
    ["整理成思维导图", "aiMindMapTool"],
    ["把这段代码转成图片", "textImageTool"],
    ["戳一下小明", "pokeTool"],
    ["给我点20个赞", "likeTool"],
    ["把我的群名片改成小明", "changeCardTool"],
    ["禁言小明一分钟", "jinyanTool"],
    ["查一下 Excel 预算表的 C12", "excelWorkbookTool"]
    ,["查一下 Modrinth 热门模组前五", "modrinthTool"]
  ]

  for (const [text, toolName] of cases) {
    assert.equal(classifyEmojiToolExposure(text), "none", text)
    assert.ok(selectToolIntentCandidates(text, [toolName, "sendLocalEmojiTool"]).includes(toolName), text)
  }
})

test("explicit emoji requests still override serious-context suppression", () => {
  const text = "这个报错先别分析，给我发个无语表情包"
  assert.equal(classifyEmojiToolExposure(text), "explicit")
  assert.deepEqual(
    selectToolIntentCandidates(text, ["sendLocalEmojiTool", "searchInformationTool"]),
    ["sendLocalEmojiTool"]
  )
})

test("hides the emoji tool for major life events and questions that need a real answer", () => {
  for (const text of [
    "你觉得这个方案是不是很离谱",
    "我该不该辞职，烦死了",
    "我今天被裁员了，心里很难受",
    "朋友去世了，我不知道该怎么办"
  ]) {
    assert.equal(classifyEmojiToolExposure(text), "none", text)
  }
})
