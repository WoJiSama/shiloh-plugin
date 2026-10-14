import {downloadBilibiliArchiveVideo as download,buildBilibiliArchiveRelaySegments as build} from '../dist/backend/modules/media/infrastructure/bilibiliMediaRelay.js'
export {BILIBILI_ARCHIVE_VIDEO_MAX_BYTES,cleanupBilibiliArchiveRelayFiles} from '../dist/backend/modules/media/infrastructure/bilibiliMediaRelay.js'
export const downloadBilibiliArchiveVideo=(resource,options={})=>download(resource,{logger:globalThis.logger,...options})
export const buildBilibiliArchiveRelaySegments=(card,options={})=>build(card,{segmentApi:globalThis.segment,logger:globalThis.logger,...options})
