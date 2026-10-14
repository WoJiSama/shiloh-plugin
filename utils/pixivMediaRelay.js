import {buildPixivArchiveRelaySegments as build} from '../dist/backend/modules/media/infrastructure/pixivMediaRelay.js'
export * from '../dist/backend/modules/media/infrastructure/pixivMediaRelay.js'
export const buildPixivArchiveRelaySegments=(card,options={})=>build(card,{segmentApi:globalThis.segment,...options})
