import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import {
  clearPixivMetadataCache,
  enrichPixivShare,
  extractPixivShareFromText,
  isTrustedPixivImageUrl
} from "../utils/pixivMessage.js"
import { buildPixivArchiveRelaySegments, cleanupPixivArchiveRelayFiles } from "../utils/pixivMediaRelay.js"

test("recognizes Pixiv artwork links and only trusts pximg image hosts", () => {
  assert.equal(extractPixivShareFromText("https://www.pixiv.net/artworks/12345678").artwork_id, "12345678")
  assert.equal(extractPixivShareFromText("https://evil.example/artworks/12345678"), null)
  assert.equal(isTrustedPixivImageUrl("https://i.pximg.net/img-master/img.jpg"), true)
  assert.equal(isTrustedPixivImageUrl("https://pximg.net.evil.example/image.jpg"), false)
})

test("enriches Pixiv metadata and retains only trusted image pages", async () => {
  clearPixivMetadataCache()
  const fetchImpl = async url => new Response(JSON.stringify(url.endsWith("/pages")
    ? { error: false, body: [{ urls: { regular: "https://i.pximg.net/img-master/one.jpg" }, width: 100, height: 200 }, { urls: { regular: "https://evil.example/two.jpg" } }] }
    : { error: false, body: { title: "art", userName: "artist", userId: "9", description: "description", pageCount: 2, tags: { tags: [{ tag: "original" }] }, viewCount: 10, likeCount: 4, bookmarkCount: 2, commentCount: 1, width: 100, height: 200, xRestrict: 0 } }), { status: 200, headers: { "content-type": "application/json" } })
  const card = await enrichPixivShare(extractPixivShareFromText("https://www.pixiv.net/artworks/12345678"), { fetchImpl })
  assert.equal(card.metadata_status, "resolved")
  assert.equal(card.author, "artist")
  assert.equal(card.pages.length, 1)
  assert.deepEqual(card.tags, ["original"])
})

test("Pixiv relay downloads bounded images and skips restricted works by default", async () => {
  const imageUrl = "https://i.pximg.net/img-master/one.jpg"
  const relay = await buildPixivArchiveRelaySegments({ type: "pixiv", artwork_id: "123", page_count: 1, pages: [{ page: 0, image_url: imageUrl }] }, {
    segmentApi: { image: file => ({ type: "image", file }) },
    pixivRelay: { fetchImpl: async () => new Response(Buffer.from("image bytes"), { status: 200, headers: { "content-length": "11" } }) }
  })
  assert.equal(relay.segments.some(item => item?.type === "image"), true)
  assert.equal(relay.tempFiles.length, 1)
  const image = relay.segments.find(item => item?.type === "image")
  assert.equal(fs.existsSync(image.file), true)
  await cleanupPixivArchiveRelayFiles(relay.tempFiles)
  assert.equal(fs.existsSync(image.file), false)

  const restricted = await buildPixivArchiveRelaySegments({ type: "pixiv", x_restrict: 1, pages: [{ page: 0, image_url: imageUrl }] })
  assert.match(restricted.segments.join(""), /受限内容/)
})

