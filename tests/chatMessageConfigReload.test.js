import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"
import { test } from "node:test"
import moment from "moment"
import { createMessageManagerClass } from "../dist/backend/modules/messaging/application/recentMessages.js"
import { resolveMessageCacheTtlSeconds } from "../utils/messageCacheTtl.js"
import { KeyedSerialQueue } from "../utils/messagePipeline/keyedSerialQueue.js"

// Execute the actual manager and shared-state reload functions, isolating the
// unrelated TRSS/media imports that are unavailable in a standalone checkout.
function createRuntime() {
  const stored = new Map()
  const writes = []
  const context = vm.createContext({
    moment,
    resolveMessageCacheTtlSeconds,
    recentMessageWriteQueue: new KeyedSerialQueue(),
    Bot: { uin: 3094088525, nickname: "bot" },
    logger: { error() {}, warn() {} },
    redis: {
      async get(key) { return stored.get(key) || null },
      async set(key, value, options) {
        stored.set(key, value)
        writes.push({ key, options })
      }
    },
    refreshLocalTools: async () => {},
    installSemanticMemoryRuntime() {},
    installMidtermMemoryRuntime() {},
    messageArchiveManager: {},
    setSharedRuntime() {},
    buildMemoryConfig: config => config.memorySystem || {},
    applyToolRegistrySnapshot: state => state
  })
  context.MessageManager = createMessageManagerClass({
    redis: context.redis, bot: context.Bot, logger: context.logger, queue: new KeyedSerialQueue(),
    scheduleJob() {}, getUrl: async () => ({headers:{}}), formatTime: time => moment(time).format('YYYY-MM-DD HH:mm:ss'), parseTime: time => Number(moment(time, 'YYYY-MM-DD HH:mm:ss')),
    refreshTencentImageUrl: async url => url, enrichBilibiliMessageSegments: async value => value || [], enrichDouyinMessageSegments: async value => value || [],
    formatBilibiliHistoryText: () => '', formatBilibiliHistoryLinks: () => '', formatDouyinHistoryText: () => '', formatDouyinHistoryLinks: () => ''
  })
  vm.runInContext(`
    const manager = new MessageManager({ groupMaxMessages: 4, cacheExpireMinutes: 60 });
    let sharedState = {
      messageManager: manager,
      emotionManager: { config: { eventWeights: {} } },
      memoryManager: { updateConfig() {} },
      expressionLearner: { config: {} },
      knowledgeSearcher: null
    };
    globalThis.manager = manager;
  `, context)
  const pluginSource = fs.readFileSync(new URL("../apps/test.js", import.meta.url), "utf8")
  for (const name of ["getMessageCacheOptions", "initializeSharedState"]) {
    const match = pluginSource.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))
    assert.ok(match, `${name} runtime function must exist`)
    vm.runInContext(match[0], context)
  }
  return {
    manager: context.manager,
    reload(config) { context.config = config; vm.runInContext("initializeSharedState(config)", context) },
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
