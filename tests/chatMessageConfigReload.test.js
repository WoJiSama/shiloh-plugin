import assert from "node:assert/strict"
import { test } from "node:test"
import moment from "moment"
import { createMessageManagerClass } from "../dist/backend/modules/messaging/application/recentMessages.js"
import {createHostSharedState} from "../dist/backend/modules/host/infrastructure/hostSharedState.js"
import { KeyedSerialQueue } from "../utils/messagePipeline/keyedSerialQueue.js"

// Execute the actual manager and shared-state reload functions, isolating the
// unrelated TRSS/media imports that are unavailable in a standalone checkout.
function createRuntime() {
  const stored = new Map()
  const writes = []
  const logger={error(){},warn(){},info(){}}
  const redis={async get(key){return stored.get(key)||null},async set(key,value,options){stored.set(key,value);writes.push({key,options})}}
  const MessageManager=createMessageManagerClass({
    redis,bot:{uin:3094088525,nickname:'bot'},logger,queue:new KeyedSerialQueue(),
    scheduleJob(){},getUrl:async()=>({headers:{}}),formatTime:time=>moment(time).format('YYYY-MM-DD HH:mm:ss'),parseTime:time=>Number(moment(time,'YYYY-MM-DD HH:mm:ss')),
    refreshTencentImageUrl:async url=>url,enrichBilibiliMessageSegments:async value=>value||[],enrichDouyinMessageSegments:async value=>value||[],
    formatBilibiliHistoryText:()=>'',formatBilibiliHistoryLinks:()=>'',formatDouyinHistoryText:()=>'',formatDouyinHistoryLinks:()=>''
  })
  class EmotionManager{constructor(){this.config={eventWeights:{}}}}
  class MemoryManager{updateConfig(){}}
  class ExpressionLearner{constructor(){this.config={}}}
  const snapshot={toolInstances:{},functions:[],functionMap:new Map(),toolSkills:[],customToolCount:0,builtInToolCount:0}
  const shared=createHostSharedState({cwd:'/unused',MessageManager,EmotionManager,MemoryManager,ExpressionLearner,logger,
    localToolRegistry:{getSnapshot:()=>snapshot,reload:async()=>snapshot},installRuntime(){},publishState(){},toolConfigHasName:()=>false,scheduleJob(){}})
  shared.initializeSharedState({groupMaxMessages:4,groupChatMemoryMinutes:60})
  return {
    get manager(){return shared.getState().messageManager},
    reload(config) { shared.initializeSharedState(config) },
    messages() { return JSON.parse(stored.get("ytbot:messages:group:9527") || "[]") },
    writes
  }
}

function message(id) {
  return {
    event_id: `event-${id}`,
    message_type: "group",
    group_id: 9527,
    message_id: id,
    time: 1784517000 + id,
    raw_message: `message-${id}`,
    message: [{ type: "text", text: `message-${id}` }],
    sender: { user_id: 10001, nickname: "user", role: "member" }
  }
}

test("chat history reload changes subsequent Redis writes on the existing manager", async () => {
  const runtime = createRuntime()
  const record = id => runtime.manager.recordMessage(message(id), {
    preEnrichedMessage: message(id).message,
    throwOnError: true
  })
  for (let id = 1; id <= 4; id++) await record(id)
  assert.equal(runtime.messages().length, 4)
  const originalManager = runtime.manager
  runtime.reload({ groupMaxMessages: 2, groupChatMemoryMinutes: 15 })
  await record(5)
  assert.equal(runtime.manager, originalManager, "reload must retain the live manager")
  assert.deepEqual(runtime.messages().map(item => item.message_id), [5, 4])
  assert.equal(runtime.writes.at(-1).options.EX, 15 * 60)

  runtime.reload({ groupMaxMessages: 3, groupChatMemoryMinutes: 30 })
  await record(6)
  await record(7)
  assert.deepEqual(runtime.messages().map(item => item.message_id), [7, 6, 5])
  assert.equal(runtime.writes.at(-1).options.EX, 30 * 60)
})
