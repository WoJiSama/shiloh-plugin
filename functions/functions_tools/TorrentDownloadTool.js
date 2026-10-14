import {createTorrentDownloadTool} from '../../dist/backend/modules/media/infrastructure/TorrentDownloadTool.js'
import {sendCompleteLocalFile} from '../../utils/messagePipeline/deliveryGateway.js'
import {renderTorrentListCard,deleteTorrentCard} from '../../utils/torrentListCard.js'
const runtime=createTorrentDownloadTool({cwd:process.cwd(),bot:()=>globalThis.Bot,redis:()=>globalThis.redis||null,image:path=>globalThis.segment.image(path),logger:{info:message=>globalThis.logger?.info?.(message),warn:message=>globalThis.logger?.warn?.(message)},fileSender:sendCompleteLocalFile,cardRenderer:renderTorrentListCard,deleteTorrentCard})
export const TorrentDownloadTool=runtime.TorrentDownloadTool
export const runCommand=runtime.runCommand
