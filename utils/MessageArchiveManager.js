import { getMentionTargetId } from "./mentionTargets.js"
import { safeTruncateUnicode } from "./unicodeText.js"
import { enrichBilibiliMessageSegments, formatBilibiliHistoryLinks, formatBilibiliHistoryText } from "./bilibiliMessage.js"
import { enrichDouyinMessageSegments, formatDouyinHistoryLinks, formatDouyinHistoryText } from "./douyinMessage.js"
import { enrichYoutubeMessageSegments, formatYoutubeHistoryLinks, formatYoutubeHistoryText } from "./youtubeMessage.js"
import { enrichPixivMessageSegments, formatPixivHistoryLinks, formatPixivHistoryText } from "./pixivMessage.js"
import { qqFaceText } from "./qqFaceTable.js"
import { KeyedSerialQueue } from "./messagePipeline/keyedSerialQueue.js"

import { createArchiveManagerClass } from '../dist/backend/modules/messaging/infrastructure/messageArchive.js'
export const MessageArchiveManager = createArchiveManagerClass({
 getMentionTargetId, safeTruncateUnicode,
 enrichBilibiliMessageSegments, enrichDouyinMessageSegments, enrichYoutubeMessageSegments, enrichPixivMessageSegments,
 formatBilibiliHistoryLinks, formatBilibiliHistoryText, formatDouyinHistoryLinks, formatDouyinHistoryText,
 formatYoutubeHistoryLinks, formatYoutubeHistoryText, formatPixivHistoryLinks, formatPixivHistoryText, qqFaceText,
 queue: new KeyedSerialQueue(), defaultLogger: globalThis.logger, defaultRedis: globalThis.redis
})
export const messageArchiveManager = new MessageArchiveManager()
