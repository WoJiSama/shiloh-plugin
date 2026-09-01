import { test } from "node:test"
import assert from "node:assert/strict"
import {
  collectForwardContext,
  formatGroupContextImagePrompt,
  resolveGroupContextAssets
} from "../utils/groupContextResolver.js"

function image(url) {
  return { type: "image", url }
}

test("collects current, quoted and nested forward images in stable source order", async () => {
  const forwardPayloads = {
    root: [
      {
        sender: { user_id: 30001, card: "转发甲" },
        message: [
          { type: "text", text: "第一层" },
          image("https://img.example/forward-1.jpg"),
          { type: "video", data: { url: "https://video.example/forward.mp4" } },
          { type: "forward", id: "nested" }
        ]
      }
    ],
    nested: [
      {
        sender: { user_id: 30002, nickname: "转发乙" },
        message: [
          { type: "text", text: "第二层" },
          image("https://img.example/forward-2.jpg")
        ]
      }
    ]
  }
  const group = {
    async getForwardMsg(id) {
      return forwardPayloads[id] || []
    }
  }
  const reply = {
    sender: { user_id: 20001, card: "被引用的人" },
    message: [
      image("https://img.example/reply-1.jpg"),
      image("https://img.example/reply-2.jpg")
    ]
  }
  const e = {
    user_id: 10001,
    sender: { card: "当前用户" },
    message: [
      image("https://img.example/current.jpg"),
      { type: "forward", id: "root" }
    ]
  }

  const context = await resolveGroupContextAssets({ e, group, reply })

  assert.equal(context.replyTargetUserId, "20001")
  assert.deepEqual(context.images.map(item => item.source), [
    "https://img.example/current.jpg",
    "https://img.example/reply-1.jpg",
    "https://img.example/reply-2.jpg",
    "https://img.example/forward-1.jpg",
    "https://img.example/forward-2.jpg"
  ])
  assert.match(context.forwardText, /转发甲: 第一层\[图片\]/)
  assert.match(context.forwardText, /转发乙: 第二层\[图片\]/)
  assert.match(formatGroupContextImagePrompt(context.images), /第5张：合并转发中 转发乙/)
  assert.deepEqual(context.videos.map(item => item.source), ["https://video.example/forward.mp4"])

  const root = context.forwardNodes[0]
  assert.equal(root.id, "root")
  assert.equal(root.nodes[0].nickname, "转发甲")
  assert.equal(root.nodes[0].user_id, "30001")
  assert.deepEqual(root.nodes[0].message[1], image("https://img.example/forward-1.jpg"))
  assert.equal(root.nodes[0].nested_forwards[0].id, "nested")
  assert.equal(root.nodes[0].nested_forwards[0].nodes[0].nickname, "转发乙")
  assert.deepEqual(root.nodes[0].nested_forwards[0].nodes[0].message[1], image("https://img.example/forward-2.jpg"))
})

test("deduplicates repeated forwarded images and stops recursive loops", async () => {
  const group = {
    async getForwardMsg(id) {
      if (id === "loop") {
        return [{ sender: { nickname: "循环" }, message: [image("https://img.example/same.jpg"), { type: "forward", id: "loop" }] }]
      }
      return []
    }
  }

  const result = await collectForwardContext(group, [{ type: "forward", id: "loop" }])

  assert.deepEqual(result.images.map(item => item.source), ["https://img.example/same.jpg"])
  assert.deepEqual(result.forwardIds, ["loop"])
  assert.equal(result.forwardNodes[0].nodes[0].nested_forwards[0].nodes.length, 0)
})

test("supports adapter data fields and ignores inaccessible image filenames", async () => {
  const context = await resolveGroupContextAssets({
    e: {
      message: [
        { type: "image", data: { url: "https://img.example/data-url.png" } },
        { type: "image", file: "local-cache-name.jpg" }
      ]
    }
  })

  assert.deepEqual(context.images.map(item => item.source), ["https://img.example/data-url.png"])
})

test("deduplicates QQ image URL variants by stable fileid", async () => {
  const fileid = "AQAQ-example-file-id"
  const context = await resolveGroupContextAssets({
    e: {
      message: [
        image(`https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=${fileid}&spec=0&rkey=first`),
        image(`https://multimedia.nt.qq.com.cn/download?fileid=${fileid}&spec=720&rkey=second`)
      ]
    }
  })

  assert.equal(context.images.length, 1)
  assert.equal(context.images[0].fileId, fileid)
  assert.doesNotMatch(formatGroupContextImagePrompt(context.images), /第2张/)
})

test("preserves Excel file names and file ids for downstream workbook tools", async () => {
  const context = await resolveGroupContextAssets({
    e: {
      user_id: 10001,
      message: [{ type: "file", data: { name: "预算.xlsx", file_id: "file-123" } }]
    }
  })

  assert.equal(context.files.length, 1)
  assert.equal(context.files[0].fileName, "预算.xlsx")
  assert.equal(context.files[0].fileId, "file-123")
})
