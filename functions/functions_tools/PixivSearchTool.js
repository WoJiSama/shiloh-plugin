import {createPixivSearchTool} from '../../dist/backend/modules/toolSupport/infrastructure/PixivSearchTool.js'
import {pixivSearchRuntime} from '../../utils/pixivSearch.js'
export const PixivSearchTool=createPixivSearchTool({search:pixivSearchRuntime,image:path=>globalThis.segment.image(path)})
