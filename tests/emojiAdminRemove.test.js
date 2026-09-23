import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EmojiPackManager } from "../domains/emoji/EmojiPackManager.js"

function makeManagerWithTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emoji-admin-"))
  const mgr = new EmojiPackManager()
  mgr.config = { ...mgr.config, enabled: true, dbPath: path.join(dir, "emoji.ndjson"), storeDir: path.join(dir, "files") }
  return { mgr, dir }
}

test("管理页:清单轻量投影,删除连文件一起删且幂等", async () => {
  const { mgr, dir } = makeManagerWithTemp()
  fs.mkdirSync(path.join(dir, "files"), { recursive: true })
  const itemA = { hash: "a".repeat(40), file: "files/a.png", tags: ["笑死", "吐槽"], useCases: ["接梗"], embedding: [0.1, 0.2], usedCount: 3, registeredAt: "2026-09-01T00:00:00Z" }
  const itemB = { hash: "b".repeat(40), file: "files/b.png", tags: ["无奈"], useCases: [] }
  await mgr.saveItems([itemA, itemB])
  fs.writeFileSync(path.join(dir, "files", "a.png"), "fake-a")
  fs.writeFileSync(path.join(dir, "files", "b.png"), "fake-b")

  const list = await mgr.listForAdmin()
  assert.equal(list.length, 2)
  assert.equal(list[0].tags.join(","), "笑死,吐槽")
  assert.ok(!("embedding" in list[0]), "embedding 大字段不出网")

  const removed = await mgr.removeItem(itemA.hash)
  assert.equal(removed.ok, true)
  assert.ok(!fs.existsSync(path.join(dir, "files", "a.png")), "记录删除时文件一起删")
  assert.equal(fs.existsSync(path.join(dir, "files", "b.png")), true, "其他文件保留")

  const after = await mgr.listForAdmin()
  assert.equal(after.length, 1)
  assert.equal(after[0].hash, itemB.hash)

  // 幂等与校验
  assert.equal((await mgr.removeItem(itemA.hash)).ok, false)
  assert.equal((await mgr.removeItem("../etc/passwd")).ok, false)

  fs.rmSync(dir, { recursive: true, force: true })
})


test("管理页:批量删除一次读写,清理全部文件", async () => {
  const { mgr, dir } = makeManagerWithTemp()
  fs.mkdirSync(path.join(dir, "files"), { recursive: true })
  const items = ["c", "d", "e"].map(ch => ({ hash: ch.repeat(40), file: "files/" + ch + ".png", tags: [ch] }))
  await mgr.saveItems(items)
  for (const it of items) fs.writeFileSync(path.join(dir, "files", path.basename(it.file)), "x")

  const result = await mgr.removeItems([items[0].hash, items[1].hash, "f".repeat(40)])
  assert.deepEqual(result, { removed: 2, missing: 1 })
  assert.equal((await mgr.loadItems()).length, 1)
  assert.equal(fs.existsSync(path.join(dir, "files", "c.png")), false)
  assert.equal(fs.existsSync(path.join(dir, "files", "d.png")), false)
  assert.equal(fs.existsSync(path.join(dir, "files", "e.png")), true)
  // 空入参直接返回
  assert.deepEqual(await mgr.removeItems([]), { removed: 0, missing: 0 })

  fs.rmSync(dir, { recursive: true, force: true })
})

test("入库标准:补充放行/拒绝追加进审查提示词", async () => {
  const { mgr, dir } = makeManagerWithTemp()
  mgr.config = { ...mgr.config, admissionExtraAllow: ["猫狗搞怪表情够夸张就放行"], admissionExtraReject: ["不要明星脸", ""] }
  const extra = mgr.admissionExtrasText()
  assert.match(extra, /站长补充放行/)
  assert.match(extra, /猫狗搞怪表情够夸张就放行/)
  assert.match(extra, /站长补充拒绝/)
  assert.match(extra, /不要明星脸/)
  assert.match(extra, /优先级最高/)
  // 空配置不追加任何段
  mgr.config = { ...mgr.config, admissionExtraAllow: [], admissionExtraReject: [] }
  assert.equal(mgr.admissionExtrasText(), "")
  fs.rmSync(dir, { recursive: true, force: true })
})
