import { createVideoThumbnail, isForwardResourceFailure } from "./videoThumbnail.js"
import { buildBilibiliArchiveRelaySegments, cleanupBilibiliArchiveRelayFiles } from "../bilibiliMediaRelay.js"
import { enrichBilibiliShare, formatBilibiliHistoryLinks, formatBilibiliHistoryText } from "../bilibiliMessage.js"
import { buildDouyinArchiveRelaySegments, cleanupDouyinArchiveRelayFiles } from "../douyinMediaRelay.js"
import { enrichDouyinShare, formatDouyinHistoryLinks, formatDouyinHistoryText } from "../douyinMessage.js"
import { buildYoutubeArchiveRelaySegments, cleanupYoutubeArchiveRelayFiles } from "../youtubeMediaRelay.js"
import { enrichYoutubeShare, formatYoutubeHistoryLinks, formatYoutubeHistoryText } from "../youtubeMessage.js"
import { buildPixivArchiveRelaySegments, cleanupPixivArchiveRelayFiles } from "../pixivMediaRelay.js"
import { enrichPixivShare, formatPixivHistoryLinks, formatPixivHistoryText } from "../pixivMessage.js"
import { buildXiaohongshuRelaySegments, cleanupXiaohongshuRelayFiles } from "../xiaohongshuMediaRelay.js"
import { enrichXiaohongshuShare, formatXiaohongshuHistoryLinks, formatXiaohongshuHistoryText } from "../xiaohongshuMessage.js"
import { inlineForwardLocalFileSegment, inlineForwardVideoSegment } from "./deliveryGateway.js"
import { createMediaOutboxClass } from '../../dist/backend/modules/messaging/infrastructure/mediaOutbox.js'
export const MediaOutbox = createMediaOutboxClass({
 logger: globalThis.logger,
 botIdentity: botId => ({ uin: globalThis.Bot?.uin, nickname: globalThis.Bot?.bots?.[botId]?.nickname || globalThis.Bot?.nickname }),
 isForwardResourceFailure, inlineForwardLocalFileSegment, inlineForwardVideoSegment,
 defaults: { enrichBilibili: enrichBilibiliShare, enrichDouyin: enrichDouyinShare, enrichYoutube: enrichYoutubeShare, enrichPixiv: enrichPixivShare, enrichXiaohongshu: enrichXiaohongshuShare, buildBilibili: buildBilibiliArchiveRelaySegments, buildDouyin: buildDouyinArchiveRelaySegments, buildYoutube: buildYoutubeArchiveRelaySegments, buildPixiv: buildPixivArchiveRelaySegments, buildXiaohongshu: buildXiaohongshuRelaySegments, prepareThumbnail: createVideoThumbnail },
 platforms: {
 bilibili: { cleanup: cleanupBilibiliArchiveRelayFiles, formatText: formatBilibiliHistoryText, formatLinks: formatBilibiliHistoryLinks },
 douyin: { cleanup: cleanupDouyinArchiveRelayFiles, formatText: formatDouyinHistoryText, formatLinks: formatDouyinHistoryLinks },
 youtube: { cleanup: cleanupYoutubeArchiveRelayFiles, formatText: formatYoutubeHistoryText, formatLinks: formatYoutubeHistoryLinks },
 pixiv: { cleanup: cleanupPixivArchiveRelayFiles, formatText: formatPixivHistoryText, formatLinks: formatPixivHistoryLinks },
 xiaohongshu: { cleanup: cleanupXiaohongshuRelayFiles, formatText: formatXiaohongshuHistoryText, formatLinks: formatXiaohongshuHistoryLinks },
 }
})
