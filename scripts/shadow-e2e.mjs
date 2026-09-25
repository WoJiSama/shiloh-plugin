#!/usr/bin/env node
// 影子机器人 E2E 回归工具:伪装成第二个 OneBotv11 客户端连进 Yunzai,
// 按场景注入消息,整条真实管线跑通;回复只落在本连接,不污染真实群。
//
// 用法(服务器上,yunzai 根目录运行):
//   node plugins/shiloh-plugin/scripts/shadow-e2e.mjs --list
//   node plugins/shiloh-plugin/scripts/shadow-e2e.mjs --scenario avatar-draw
//   node plugins/shiloh-plugin/scripts/shadow-e2e.mjs --scenario douyin-note --group 981339693
//
// 说明:
// - 影子 Bot 条目会在 Yunzai 内残留到下次重启,跑完建议 systemctl restart trss-yunzai
// - 场景里的画图/搜索是真实调用,消耗额度;抖音场景需真实短链
// - 产出图片保存到 /tmp/shadow-e2e-out/
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

const require = createRequire(import.meta.url)
const WebSocket = require("ws")

const args = process.argv.slice(2)
const flag = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : ""
}
const SCENARIOS = {
  "avatar-draw": {
    describe: "双人恶魔/天使头像画图(语义分类→references→参考图生成)",
    build: () => ({
      group: 981339693,
      sender: 925640859,
      members: [925640859, 3188163302, 853103024],
      message: { text: " 希洛帮我生成一张图片,左边恶魔右边天使,分别是", ats: [3188163302, 853103024] },
      expect: { kind: "image-or-text", timeoutMs: 120000 }
    })
  },
  "avatar-quote-style": {
    describe: "引用图+回复自带@+点名风格(编号对齐+回复@不误挂)",
    build: () => ({
      group: 981339693,
      sender: 925640859,
      members: [925640859, 853103024],
      replyTo: { userId: 853103024, images: ["https://p3-sign.douyinpic.com/quote-style-demo.webp"] },
      message: { text: " 希洛保留原图的设计风格和感觉,画一张", ats: [853103024], suffix: " 风格的图", atInBody: true },
      expect: { kind: "image", timeoutMs: 120000 }
    })
  },
  "douyin-note": {
    describe: "抖音图文搬运(真实短链→图集解析→合并转发)",
    build: () => ({
      group: 981339693,
      sender: 925640859,
      members: [925640859],
      message: { text: " 复制打开抖音,看看图文作品 https://v.douyin.com/-fMWqt9n384/ 分享" },
      expect: { kind: "forward-with-images", timeoutMs: 60000 }
    })
  },
  "knowledge-markdown": {
    describe: "知识问答(含markdown的回复应转卡面而非裸文本)",
    build: () => ({
      group: 981339693,
      sender: 925640859,
      members: [925640859],
      message: { text: " 希洛,Coc7里面的临时疯狂规则是什么" },
      expect: { kind: "image-or-text", timeoutMs: 120000 }
    })
  }
}

function usage() {
  console.log("场景列表:")
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    console.log(`  ${name.padEnd(20)} ${scenario.describe}`)
  }
}

async function runScenario(name) {
  const scenario = SCENARIOS[name]
  if (!scenario) {
    console.error(`未知场景: ${name}(--list 查看全部)`)
    process.exit(1)
  }
  const config = scenario.build()
  const groupId = Number(flag("group") || config.group)
  const selfId = 999999999
  const outDir = "/tmp/shadow-e2e-out"
  fs.mkdirSync(outDir, { recursive: true })

  const ws = new WebSocket("ws://127.0.0.1:2536/OneBotv11")
  const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
  const send = obj => ws.send(JSON.stringify(obj))
  const replyApi = (echo, data) => send({ status: "ok", retcode: 0, data, echo, message: "" })
  const memberList = (config.members || [config.sender]).map(qq => ({
    user_id: qq, nickname: `测试成员${String(qq).slice(-2)}`, card: `影子成员${String(qq).slice(-4)}`, role: "member"
  }))

  const sends = []
  let imageCount = 0
  let forwardCount = 0
  const startedAt = Date.now()

  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = sends.find(predicate)
      if (hit) return hit
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    return null
  }

  ws.on("message", raw => {
    let data
    try { data = JSON.parse(raw) } catch { return }
    if (data.echo === undefined || !data.action) return
    switch (data.action) {
      case "get_group_member_list": return replyApi(data.echo, memberList)
      case "get_group_list": return replyApi(data.echo, [{ group_id: groupId, group_name: "影子E2E群", member_count: memberList.length, max_member_count: 500 }])
      case "get_group_info": return replyApi(data.echo, { group_id: groupId, group_name: "影子E2E群", member_count: memberList.length, max_member_count: 500 })
      case "get_login_info": return replyApi(data.echo, { user_id: selfId, nickname: "希洛" })
      case "get_msg": return replyApi(data.echo, {
        message_id: 1444852582, real_id: 1444852582,
        sender: { user_id: config.replyTo?.userId || memberList[0].user_id, nickname: memberList[0].nickname, card: memberList[0].card },
        message: (config.replyTo?.images || []).map(url => ({ type: "image", data: { url, file: "quoted.jpg" } })),
        raw_message: "[CQ:image,file=quoted.jpg]"
      })
      case "send_group_forward":
      case "send_group_forward_msg": {
        const nodes = data.params?.messages || data.params?.nodes || []
        forwardCount++
        sends.push({ kind: "forward", nodes, at: Date.now() })
        log(`>>> 合并转发 nodes=${nodes.length}`)
        return replyApi(data.echo, { message_id: Date.now() })
      }
      case "send_group_msg":
      case "send_msg": {
        const parts = data.params?.message || []
        for (const part of (Array.isArray(parts) ? parts : [parts])) {
          if (part?.type === "image" && String(part.data?.file || "").startsWith("base64://") && imageCount < 3) {
            const file = path.join(outDir, `${name}-${imageCount}.png`)
            fs.writeFileSync(file, Buffer.from(String(part.data.file).replace(/^base64:\/\//, ""), "base64"))
            imageCount++
            log(`>>> 图片已保存 ${file}`)
          }
        }
        sends.push({ kind: "message", parts, at: Date.now() })
        const text = (Array.isArray(parts) ? parts : [parts]).filter(p => p?.type === "text").map(p => p.data?.text || "").join("").trim()
        if (text) log(`>>> 文本: ${text.slice(0, 100)}`)
        return replyApi(data.echo, { message_id: Date.now() })
      }
      default: return replyApi(data.echo, null)
    }
  })

  await new Promise((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  send({ post_type: "meta_event", meta_event_type: "lifecycle", sub_type: "connect", self_id: selfId, time: Math.floor(Date.now() / 1000) })
  await new Promise(resolve => setTimeout(resolve, 1200))

  // 组装消息事件
  const messageId = Date.now() % 1000000
  const message = []
  const rawParts = []
  if (config.replyTo) {
    message.push({ type: "reply", data: { id: "1444852582" } })
    rawParts.push("[CQ:reply,id=1444852582]")
    message.push({ type: "at", data: { qq: String(config.replyTo.userId) } })
    rawParts.push(`[CQ:at,qq=${config.replyTo.userId}]`)
  }
  message.push({ type: "text", data: { text: config.message.text } })
  rawParts.push(config.message.text)
  for (const qq of config.message.ats || []) {
    message.push({ type: "at", data: { qq: String(qq) } })
    rawParts.push(`[CQ:at,qq=${qq}]`)
    if (!config.message.atInBody) message.push({ type: "text", data: { text: " " } }), rawParts.push(" ")
  }
  if (config.message.suffix) {
    message.push({ type: "text", data: { text: config.message.suffix } })
    rawParts.push(config.message.suffix)
  }
  send({
    post_type: "message", message_type: "group", sub_type: "normal",
    message_id: messageId, user_id: config.sender, group_id: groupId, self_id: selfId,
    time: Math.floor(Date.now() / 1000),
    sender: memberList.find(m => m.user_id === config.sender) || memberList[0],
    message, raw_message: rawParts.join("")
  })
  log(`已注入场景 [${name}],等待管线...`)

  const expect = config.expect
  const result = await waitFor(send => {
    if (expect.kind === "image") return send.kind === "message" && send.parts.some?.(p => p?.type === "image")
    if (expect.kind === "forward-with-images") {
      return send.kind === "forward" && send.nodes.some(n => JSON.stringify(n).includes("image"))
    }
    if (expect.kind === "image-or-text") {
      return send.kind === "forward" || (send.kind === "message" && send.parts.some?.(p => p?.type === "image" || (p?.data?.text || "").trim().length > 5))
    }
    return Boolean(send)
  }, expect.timeoutMs)

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  if (result) {
    console.log(`\n✅ [${name}] PASS (${elapsed}s, 消息${sends.length}条, 图${imageCount}张, 转发${forwardCount}条)`)
  } else {
    console.log(`\n❌ [${name}] FAIL (${elapsed}s 内未收到期望输出; 共消息${sends.length}条)`)
  }
  ws.close()
  process.exit(result ? 0 : 1)
}

const scenarioName = flag("scenario")
if (!scenarioName || args.includes("--list") || args.includes("-h") || args.includes("--help")) {
  usage()
  process.exit(0)
}
runScenario(scenarioName).catch(error => {
  console.error("E2E 异常:", error.message)
  process.exit(1)
})
