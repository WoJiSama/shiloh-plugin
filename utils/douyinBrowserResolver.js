import {createDouyinBrowserResolver} from '../dist/backend/modules/media/infrastructure/douyinBrowserResolver.js'
import {getSharedBrowser,scheduleSharedBrowserClose} from './sharedBrowser.js'
export {extractPlayUrlFromJson,extractNoteImagesFromJson,extractDouyinMusicFromJson} from '../dist/backend/modules/media/infrastructure/douyinBrowserResolver.js'
const runtime=createDouyinBrowserResolver({getSharedBrowser,scheduleSharedBrowserClose,logger:globalThis.logger})
export const resolveDouyinShareViaBrowser=runtime.resolveDouyinShareViaBrowser
