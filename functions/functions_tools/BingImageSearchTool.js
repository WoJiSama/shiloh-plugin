import {createBingImageSearchTool} from '../../dist/backend/modules/content/infrastructure/BingImageSearchTool.js'
export const {BingImageSearchTool}=createBingImageSearchTool({image:url=>globalThis.segment.image(url),sendForward:async(event,nodes)=>event.bot.adapter.sendGroupForwardMsg(event,nodes)})
