import {createXiaohongshuBrowserResolver} from '../dist/backend/modules/media/infrastructure/xiaohongshuBrowserResolver.js'
import {getSharedBrowser,scheduleSharedBrowserClose} from './sharedBrowser.js'
export {extractFromDomPayload} from '../dist/backend/modules/media/infrastructure/xiaohongshuBrowserResolver.js'
const runtime=createXiaohongshuBrowserResolver({getSharedBrowser,scheduleSharedBrowserClose,logger:globalThis.logger})
export const resolveXiaohongshuShareViaBrowser=runtime.resolveXiaohongshuShareViaBrowser
