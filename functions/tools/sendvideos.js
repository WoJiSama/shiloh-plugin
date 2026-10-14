import {bilibiliParser} from './bilibilivideoanalysis.js'
import {createSendVideos} from '../../dist/backend/modules/media/infrastructure/sendvideos.js'
export const sendvideos=createSendVideos({parse:bilibiliParser,video:file=>globalThis.segment.video(file),log:message=>console.log(message)})
