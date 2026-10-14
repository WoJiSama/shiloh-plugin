import {createPixivSearch} from '../dist/backend/modules/media/infrastructure/pixivSearch.js'
import {getSharedBrowser,scheduleSharedBrowserClose} from './sharedBrowser.js'
export const pixivSearchRuntime=createPixivSearch({getRedis:()=>globalThis.redis,getSharedBrowser,scheduleSharedBrowserClose,logger:{warn:(...args)=>globalThis.logger?.warn?.(...args)}})
export const {PIXIV_SEARCH_SESSION_TTL_MS,PIXIV_SEARCH_ORDERS,normalizePixivSearchItem,searchPixivArtworks,expandPixivKeywordAliases,resolvePixivArtistFromItems,listPixivArtistRecentWorks,savePixivSearchSession,loadPixivSearchSession,hasRecentPixivSearch,touchPixivSearchSession,resolvePixivDownloadTarget,renderPixivListCard,cleanupPixivListCard}=pixivSearchRuntime
