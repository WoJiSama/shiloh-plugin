import { test } from "node:test"
import assert from "node:assert/strict"

test("作品角色请求不挂真人头像参考", async () => {
  const { shouldSkipNicknameAvatarReference } = await import("../utils/avatarReferencePolicy.js")
  const cases = [
    ["希洛帮我画一张 蔚蓝档案里面的小鸟游星野穿着泳装的照片", "星野"],
    ["画一个原神的可莉", "可莉"],
    ["帮我画张赛马娘里的特别周", "特别周"],
    ["希洛画一个龙族里面的绘梨衣", "绘梨衣"],
    ["画个明日方舟的阿米娅", "阿米娅"],
    ["画一只fate里的saber", "saber"]
  ]
  for (const [text, nickname] of cases) {
    assert.equal(shouldSkipNicknameAvatarReference(text, nickname), true, text)
  }
})

test("昵称是长名片段时不挂真人头像", async () => {
  const { shouldSkipNicknameAvatarReference, isNicknamePartOfLongerName } = await import("../utils/avatarReferencePolicy.js")
  // 群友昵称"星野"出现在"小鸟游星野"里：前面是名字字段，不是独立称呼
  assert.equal(isNicknamePartOfLongerName("希洛帮我画一张小鸟游星野穿着泳装的照片", "星野"), true)
  assert.equal(shouldSkipNicknameAvatarReference("希洛帮我画一张小鸟游星野穿着泳装的照片", "星野"), true)
})

test("明确指群友本人的画图请求仍可挂头像", async () => {
  const { shouldSkipNicknameAvatarReference } = await import("../utils/avatarReferencePolicy.js")
  // 实际调用前文本已通过 removeBotAnchors 剥离机器人称呼，这里用剥离后的形态
  const cases = [
    ["画星野", "星野"],
    ["帮我画个星野", "星野"],
    ["把星野画成骑士", "星野"],
    ["画我们群的星野", "星野"]
  ]
  for (const [text, nickname] of cases) {
    assert.equal(shouldSkipNicknameAvatarReference(text, nickname), false, text)
  }
})
