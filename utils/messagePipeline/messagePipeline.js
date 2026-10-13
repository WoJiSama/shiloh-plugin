import { enrichBilibiliMessageSegments, extractBilibiliShareFromSegment, extractBilibiliShareFromText } from "../bilibiliMessage.js"
import { enrichDouyinMessageSegments, extractDouyinShareFromText } from "../douyinMessage.js"
import { enrichYoutubeMessageSegments, extractYoutubeShareFromText } from "../youtubeMessage.js"
import { enrichPixivMessageSegments, extractPixivShareFromText } from "../pixivMessage.js"
import { createEventEnvelope, envelopeToRuntimeEvent, isEnvelopeFromBot } from "./eventEnvelope.js"
import { isResponsibleBot, isFederationSibling, markBotOnline, onlineBotList } from "../botFederation.js"

import { createMessagePipelineClass } from '../../dist/backend/modules/messaging/infrastructure/messagePipeline.js'
const TypedMessagePipeline = createMessagePipelineClass({
  enrichBilibili: enrichBilibiliMessageSegments, enrichDouyin: enrichDouyinMessageSegments,
  enrichYoutube: enrichYoutubeMessageSegments, enrichPixiv: enrichPixivMessageSegments,
  extractBilibiliShareFromSegment, extractBilibiliShareFromText, extractDouyinShareFromText,
  extractYoutubeShareFromText, extractPixivShareFromText, createEventEnvelope,
  isResponsibleBot, isFederationSibling, markBotOnline, onlineBotList
})
export class MessagePipeline extends TypedMessagePipeline {
  constructor(options = {}) { super({ logger: globalThis.logger, ...options }) }
}
