import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { test } from "node:test"
import { downloadOfficialMusicShare, extractNeteaseMusicShare, resolveNeteaseTextShare } from "../utils/musicShareRelay.js"

const card = {
  message: [{
    type: "json",
    data: JSON.stringify({
      meta: {
        music: {
          tag: "网易云音乐",
          title: "山鬼",
          desc: "赵景旭（Winky诗）",
          musicUrl: "http://music.163.com/song/media/outer/url?id=28496172&amp;userid=1"
        }
      }
    })
  }]
}

test("extracts an official Netease music card from a quoted message", () => {
  assert.deepEqual(extractNeteaseMusicShare(card), {
    title: "山鬼",
    artist: "赵景旭（Winky诗）",
    sourceUrl: "http://music.163.com/song/media/outer/url?id=28496172&userid=1"
  })
})

test("rejects music cards with an untrusted audio source", () => {
  assert.equal(extractNeteaseMusicShare({ message: [{ type: "json", data: JSON.stringify({ meta: { music: { tag: "网易云音乐", musicUrl: "https://example.test/song.mp3" } } }) }] }), null)
})

test("resolves a plain Netease DJ link to its official audio source", async () => {
  const share = await resolveNeteaseTextShare("https://music.163.com/dj?id=3724685239", {
    fetchImpl: async url => {
      assert.match(String(url), /api\/dj\/program\/detail\?id=3724685239/)
      return new Response(JSON.stringify({
        code: 200,
        program: {
          name: "节目标题",
          dj: { nickname: "主播" },
          mainSong: { id: 3407924797, name: "theme-1-沉沦者梦呓", artists: [{ name: "无玄_Dives" }] }
        }
      }), { status: 200 })
    }
  })
  assert.deepEqual(share, {
    title: "theme-1-沉沦者梦呓",
    artist: "无玄_Dives",
    sourceUrl: "https://music.163.com/song/media/outer/url?id=3407924797"
  })
})

test("downloads only audio returned by an official music redirect", async () => {
  const result = await downloadOfficialMusicShare({ title: "测试", artist: "歌手", sourceUrl: "https://music.163.com/song/media/outer/url?id=1" }, {
    tempDir: "/tmp/bl-chat-plugin-music-share-test",
    fetchImpl: async () => new Response(Buffer.from("audio"), {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": "5" }
    })
  })
  assert.equal(result.size, 5)
  assert.match(result.fileName, /^测试-歌手-/)
  await fs.unlink(result.filePath)
})

test("rejects a music redirect that leaves the official CDN", async () => {
  await assert.rejects(
    downloadOfficialMusicShare({ title: "测试", artist: "歌手", sourceUrl: "https://music.163.com/song/media/outer/url?id=1" }, {
      fetchImpl: async () => ({
        ok: true,
        url: "https://example.test/song.mp3",
        headers: new Headers({ "content-type": "audio/mpeg" }),
        body: Buffer.from("audio")
      })
    }),
    /非官方地址/
  )
})
