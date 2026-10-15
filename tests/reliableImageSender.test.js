import { test } from "node:test"
import assert from "node:assert/strict"
import { isMessageSendFailed, resolveImageBuffer, sendImageReliably } from "../utils/reliableImageSender.js"

test("downloads remote images before sending them", async () => {
  const imageBytes = Buffer.from("image-content")
  const buffer = await resolveImageBuffer("https://example.com/image.png", {
    fetchImpl: async () => new Response(imageBytes, { headers: { "content-type": "image/png" } })
  })
  assert.deepEqual(buffer, imageBytes)
})

test("rejects non-image remote responses", async () => {
  await assert.rejects(
    resolveImageBuffer("https://example.com/error", {
      fetchImpl: async () => new Response("error", { headers: { "content-type": "text/plain" } })
    }),
    /返回类型/
  )
})

test("treats NapCat retcode failures as send failures", () => {
  assert.equal(isMessageSendFailed({ status: "failed", retcode: 1200 }), true)
  assert.equal(isMessageSendFailed({ status: "ok", retcode: 0 }), false)
})

test("sends a downloaded Buffer and rejects failed replies", async () => {
  const previousSegment = globalThis.segment
  globalThis.segment = { image: file => ({ type: "image", file }) }
  try {
    let sentFile = null
    await assert.rejects(
      sendImageReliably({ reply: async message => {
        sentFile = message[0].file
        return { status: "failed", retcode: 1200, message: "Error" }
      } }, "base64://aW1hZ2U="),
      /Error/
    )
    assert.ok(Buffer.isBuffer(sentFile))
  } finally {
    globalThis.segment = previousSegment
  }
})

test('unknown send receipt is rejected without retry', async () => {
 let sends = 0
 await assert.rejects(sendImageReliably({reply:async()=>{sends++;return undefined}},Buffer.from('image'),{buildMessage:buffer=>buffer}),/发送结果未确认/)
 assert.equal(sends,1)
})
test('image download rejects oversized response and preserves metadata decoding', async()=>{
 await assert.rejects(resolveImageBuffer('https://example.com/image',{maxBytes:2,fetchImpl:async()=>new Response(Buffer.from('large'),{headers:{'content-type':'image/png'}})}),/图片过大/)
 const {getImageBufferMetadata}=await import('../utils/reliableImageSender.js')
 assert.equal(await getImageBufferMetadata(Buffer.from('invalid')),null)
 const {default:sharp}=await import('sharp')
 const png=await sharp({create:{width:9,height:16,channels:3,background:'#fff'}}).png().toBuffer()
 assert.deepEqual(await getImageBufferMetadata(png),{width:9,height:16,format:'png',orientation:'portrait'})
})
