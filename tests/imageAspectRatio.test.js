import { test } from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import {
  applyImageAspectRatioToConfigs,
  resolveImageAspectRatioIntent,
  resolveImageProviderSize
} from "../utils/imageAspectRatio.js"
import { getImageBufferMetadata } from "../utils/reliableImageSender.js"

test("extracts numeric and natural-language image aspect ratio intent", () => {
  assert.equal(resolveImageAspectRatioIntent("比例9:16").orientation, "portrait")
  assert.equal(resolveImageAspectRatioIntent("做成横版收藏海报").orientation, "landscape")
  assert.equal(resolveImageAspectRatioIntent("使用正方形构图").orientation, "square")
  assert.equal(resolveImageAspectRatioIntent("没有指定画布方向"), null)
  assert.equal(resolveImageAspectRatioIntent("画面里的时钟显示12:30"), null)
  assert.equal(resolveImageAspectRatioIntent("画面里的时钟显示12:30，使用横版构图").orientation, "landscape")
})

test("treats pixel expressions as aspect ratios instead of exact dimensions", () => {
  const portrait = resolveImageAspectRatioIntent("请输出 1024×1536 的图片")
  const square = resolveImageAspectRatioIntent("尺寸1024*1024")

  assert.equal(portrait.orientation, "portrait")
  assert.equal(portrait.width, 1024)
  assert.equal(portrait.height, 1536)
  assert.equal(square.orientation, "square")
})

test("explicit tool aspectRatio has priority over prose fallback", () => {
  const intent = resolveImageAspectRatioIntent("做成横版", "9:16")
  assert.equal(intent.orientation, "portrait")
  assert.equal(intent.source, "tool_parameter")
})

test("maps GPT image providers to their supported orientation sizes", () => {
  const config = { model: "gpt-image-2", size: "1024x1024" }
  assert.equal(resolveImageProviderSize(config, resolveImageAspectRatioIntent("9:16")), "1024x1536")
  assert.equal(resolveImageProviderSize(config, resolveImageAspectRatioIntent("16:9")), "1536x1024")
  assert.equal(resolveImageProviderSize(config, resolveImageAspectRatioIntent("1:1")), "1024x1024")
})

test("uses provider-specific mappings independently for fallback channels", () => {
  const configs = applyImageAspectRatioToConfigs([
    {
      name: "first",
      model: "custom-image",
      size: "1024x1024",
      portraitSize: "768x1344"
    },
    {
      name: "second",
      model: "gpt-image-2",
      size: "1024x1024"
    }
  ], resolveImageAspectRatioIntent("竖版"), { operation: "generate" })

  assert.deepEqual(configs.map(item => item.size), ["768x1344", "1024x1536"])
})

test("does not inherit a square generation size for unspecified image editing", () => {
  const config = { model: "gpt-image-2", size: "1024x1024" }
  assert.equal(resolveImageProviderSize(config, null, { operation: "edit" }), "")
  assert.equal(resolveImageProviderSize({ ...config, autoSize: "auto" }, null, { operation: "edit" }), "auto")
  assert.equal(resolveImageProviderSize({ ...config, defaultEditSize: "1024x1024" }, null, { operation: "edit" }), "1024x1024")
})

test("keeps neutral resolution tokens but omits incompatible fixed canvases", () => {
  const portrait = resolveImageAspectRatioIntent("竖版")
  assert.equal(resolveImageProviderSize({ model: "custom", size: "2K" }, portrait), "2K")
  assert.equal(resolveImageProviderSize({ model: "custom", size: "1024x1024" }, portrait), "")
})

test("reads actual output dimensions from image bytes", async () => {
  const buffer = await sharp({
    create: { width: 12, height: 20, channels: 4, background: "#ffffff" }
  }).png().toBuffer()
  assert.deepEqual(await getImageBufferMetadata(buffer), {
    width: 12,
    height: 20,
    format: "png",
    orientation: "portrait"
  })
  assert.equal(await getImageBufferMetadata(Buffer.from("not-an-image")), null)
})
