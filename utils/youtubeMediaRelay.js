import {downloadYoutubeCoverImage as cover,buildYoutubeArchiveRelaySegments as build} from '../dist/backend/modules/media/infrastructure/youtubeMediaRelay.js'
export {YOUTUBE_ARCHIVE_VIDEO_MAX_BYTES,downloadYoutubeArchiveVideo,cleanupYoutubeArchiveRelayFiles} from '../dist/backend/modules/media/infrastructure/youtubeMediaRelay.js'
export const downloadYoutubeCoverImage=(url,options={})=>cover(url,{logger:globalThis.logger,...options})
export const buildYoutubeArchiveRelaySegments=(card,options={})=>build(card,{segmentApi:globalThis.segment,logger:globalThis.logger,...options})
