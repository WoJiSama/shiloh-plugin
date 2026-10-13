import { createPipelineForwardResolver } from '../../dist/backend/adapters/pipelineForwardContext.js'
import { MessageManager } from "../MessageManager.js"
import { messageArchiveManager } from "../MessageArchiveManager.js"
import { setPixivFetchProxy } from "../pixivMessage.js"
import { DeliveryGateway } from "./deliveryGateway.js"
import { MediaOutbox } from "./mediaOutbox.js"
import { MediaArtifactStore } from "./mediaArtifactStore.js"
import { MessagePipeline } from "./messagePipeline.js"
import { startMediaRelayAdminReport } from "./mediaRelayAdminReport.js"
import { getMissingRedisJobCapabilities, RedisJobStore } from "./redisJobStore.js"
import { createStatsEmitterFromSettings } from "../messageStats.js"
import { BilibiliAuthManager } from "../BilibiliAuthManager.js"
import { collectForwardContext, extractForwardIdsFromSegments } from "../groupContextResolver.js"

import { createPipelineRuntime } from '../../dist/backend/modules/messaging/infrastructure/runtime.js'
export { DEFAULT_MESSAGE_PIPELINE_CONFIG, normalizeMessagePipelineConfig } from '../../dist/backend/modules/messaging/infrastructure/runtime.js'
const RUNTIME_KEY = Symbol.for('shiloh-plugin.message-pipeline.runtime')
const resolvePipelineForwardContext = createPipelineForwardResolver({getBot: () => globalThis.Bot, extractForwardIdsFromSegments, collectForwardContext})
const runtime = createPipelineRuntime({
 getBot: () => globalThis.Bot, getRedis: () => globalThis.redis, getLogger: () => globalThis.logger,
 getInstalled: () => globalThis[RUNTIME_KEY] || null, setInstalled: value => { globalThis[RUNTIME_KEY] = value },
 setPixivFetchProxy, getMissingRedisJobCapabilities,
 createJobStore: options => new RedisJobStore(options), createStats: createStatsEmitterFromSettings,
 createGateway: options => new DeliveryGateway(options), createArtifactStore: options => new MediaArtifactStore(options),
 createOutbox: options => new MediaOutbox(options), createRecent: options => new MessageManager(options),
 createPipeline: options => new MessagePipeline(options), startAdminReport: startMediaRelayAdminReport,
 archiveManager: messageArchiveManager, getBilibiliAuthCookie: () => new BilibiliAuthManager().cookie(),
 resolveForwardContext: resolvePipelineForwardContext
})
export const createMessagePipelineRuntime = runtime.createMessagePipelineRuntime
export const installMessagePipeline = runtime.installMessagePipeline
export const getInstalledMessagePipeline = runtime.getInstalledMessagePipeline
