import fetch from 'node-fetch'
import {BilibiliVideoSummary as summarize} from '../../dist/backend/modules/media/infrastructure/BilibiliVideoSummary.js'
export const BilibiliVideoSummary=(sessdata,bvid)=>summarize(sessdata,bvid,fetch)
