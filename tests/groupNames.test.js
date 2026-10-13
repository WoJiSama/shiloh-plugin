import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { collectBotGroupNames, collectBotIdentities, readCachedGroupNames, mergeGroupNames } from "../utils/groupNames.js"

test("group names come from every bot membership cache without depending on today's activity", () => {
  const directory = collectBotGroupNames({
    bots: {
      first: { gl: new Map([[100001, { group_name: " 活跃群 " }], [200002, { group_name: "安静群" }]]) },
      second: { gl: new Map([[100001, { group_name: "" }], [300003, { group_id: 300003, group_name: "另一账号的群" }]]) }
    },
    gl: new Map([[400004, { name: "聚合列表补充" }]])
  })
  assert.deepEqual(directory, [
    { id: "100001", name: "活跃群" }, { id: "200002", name: "安静群" },
    { id: "300003", name: "另一账号的群" }, { id: "400004", name: "聚合列表补充" }
  ])
})

test("both historical cache locations survive malformed files and live blank names never erase a cached name", t => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "group-names-"))
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }))
  const plugin = path.join(runtime, "plugins", "shiloh-plugin")
  for (const dir of [runtime, plugin]) fs.mkdirSync(path.join(dir, "data"), { recursive: true })
  fs.writeFileSync(path.join(plugin, "data/group_names.json"), JSON.stringify({ "100001": "旧群名", "200002": "离线群", bad: "invalid", "300003": {} }))
  fs.writeFileSync(path.join(runtime, "data/group_names.json"), JSON.stringify({ "100001": "消息缓存群名", "400004": "主目录群" }))
  const cache = readCachedGroupNames(plugin)
  assert.deepEqual([...cache], [["100001", "消息缓存群名"], ["200002", "离线群"], ["400004", "主目录群"]])
  const merged = mergeGroupNames(cache, [{ id: "100001", name: "最新群名" }, { id: "200002", name: " " }, { id: "x", name: "invalid" }])
  assert.equal(merged.get("100001"), "最新群名")
  assert.equal(merged.get("200002"), "离线群")
  assert.equal(cache.get("100001"), "消息缓存群名")
  fs.writeFileSync(path.join(runtime, "data/group_names.json"), "malformed")
  assert.equal(readCachedGroupNames(plugin).get("100001"), "旧群名")
})

test("missing bot state and malformed upstream metadata leave a usable name map", () => {
  assert.deepEqual(collectBotGroupNames({}), [])
  assert.deepEqual([...mergeGroupNames(new Map([["100001", "缓存群"]]), {})], [["100001", "缓存群"]])
})


test("bot nicknames match the full account ID and tolerate missing login information", () => {
  assert.deepEqual(collectBotIdentities({ bots: {
    100001: { uin: 100001, nickname: " 机器人甲 " },
    200002: { self_id: "200002", info: { nickname: "机器人乙" } },
    300003: { nickname: "300003" }, invalid: { nickname: "忽略" },
    400004: { nickname: null }
  } }), [{ id: "100001", name: "机器人甲" }, { id: "200002", name: "机器人乙" }, { id: "300003", name: "" }, { id: "400004", name: "" }])
  assert.deepEqual(collectBotIdentities({}), [])
})
