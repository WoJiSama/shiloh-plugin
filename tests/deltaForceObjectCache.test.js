import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import { DeltaForceObjectCache, normalizeDeltaForceObjects } from "../domains/games/deltaforce/DeltaForceObjectCache.js"

test("normalizeDeltaForceObjects supports common object list shapes", () => {
  assert.deepEqual(
    normalizeDeltaForceObjects({
      data: {
        list: [
          { objectID: 1001, objectName: "军用电台" },
          { objectId: "1002", name: "处理器" }
        ]
      }
    }).map(item => ({ objectID: item.objectID, objectName: item.objectName })),
    [
      { objectID: "1001", objectName: "军用电台" },
      { objectID: "1002", objectName: "处理器" }
    ]
  )
})

test("DeltaForceObjectCache refreshes, persists, and resolves names", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-object-cache-"))
  const cachePath = path.join(dir, "objects.json")
  const cache = new DeltaForceObjectCache({ cachePath, logger: null })

  await cache.refresh({
    getObjectList: async () => ({
      data: {
        list: [
          { objectID: 1001, objectName: "军用电台" },
          { objectID: 1002, objectName: "处理器" }
        ]
      }
    })
  }, { force: true })

  assert.equal(cache.size, 2)
  assert.equal(cache.getName(1001), "军用电台")
  assert.ok(fs.existsSync(cachePath))

  const restored = new DeltaForceObjectCache({ cachePath, logger: null })
  assert.equal(restored.getName("1002"), "处理器")
})
