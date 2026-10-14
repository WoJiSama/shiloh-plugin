import {createPixivDownloadTool} from '../../dist/backend/modules/toolSupport/infrastructure/PixivDownloadTool.js'
import {pixivSearchRuntime} from '../../utils/pixivSearch.js'
export const PixivDownloadTool=createPixivDownloadTool({search:pixivSearchRuntime,image:path=>globalThis.segment.image(path)})
