import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isAiConversationEnabled } from "../utils/aiConversationGate.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("plugin master switch treats false-like values as off", () => {
  assert.equal(isAiConversationEnabled({ enabled: true }), true)
  assert.equal(isAiConversationEnabled({ enabled: false }), false)
  assert.equal(isAiConversationEnabled({ enabled: "false" }), false)
  assert.equal(isAiConversationEnabled({ enabled: "off" }), false)
  assert.equal(isAiConversationEnabled({ enabled: 0 }), false)
  assert.equal(isAiConversationEnabled({}), false)
  assert.equal(isAiConversationEnabled(null), false)
})

test("AI conversation entries re-check the master switch", () => {
  // 主链路已拆 apps/lib(P 重构):守卫随方法迁走,聚合两个新家断言
  const libDir = path.join(root, "apps/lib")
  const joined = [path.join(root, "apps/test.js"),
    ...fs.readdirSync(libDir).filter(f => f.endsWith(".js")).map(f => path.join(libDir, f))]
    .map(file => fs.readFileSync(file, "utf8")).join("\n")
  for (const marker of [
    "async handleRandomReplySmart(e) {", // 类内委托仍在
    "async handleToolInner(e) {", // 类内委托仍在
  ]) {
    assert.ok(joined.includes(marker.replaceAll("\\n", "\n")), `missing guard: ${marker.split("\n")[0]}`)
  }
})

test("compiled smart and repeat entry guards reject disabled hosts before using any downstream port", async () => {
 const {createSmartConversation}=await import('../dist/backend/modules/conversation/application/smartConversation.js')
 const {createStrictConversation}=await import('../dist/backend/modules/conversation/infrastructure/strictConversation.js')
 const host={config:{enabled:false}}
 assert.equal(await createSmartConversation({}).handleRandomReplySmart(host,{}),false)
 assert.equal(await createStrictConversation({}).joinRepeat(host,{},null,'text'),false)
})

test("compiled proactive scheduling rejects disabled configuration before accessing anchor or queue",async()=>{
 const {createConversationScheduling}=await import('../dist/backend/modules/conversation/infrastructure/conversationScheduling.js')
 const runtime=createConversationScheduling({logger:{info(){}}})
 assert.deepEqual(await runtime.enqueueProactiveTask({config:{enabled:false}},7,'hello'),{ok:false,error:'plugin_disabled'})
})

test("compiled chat turn rejects disabled configuration before downstream execution",async()=>{
 const {createChatTurn}=await import('../dist/backend/modules/tools/infrastructure/chatTurn.js')
 assert.equal(await createChatTurn({isAiConversationEnabled}).handleToolInner({config:{enabled:false}},{}),false)
})
