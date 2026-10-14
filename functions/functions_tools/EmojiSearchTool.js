import {createEmojiSearchTool} from '../../dist/backend/modules/content/infrastructure/EmojiSearchTool.js'
export const {EmojiSearchTool}=createEmojiSearchTool({image:url=>globalThis.segment.image(url),sendImages:async(event,images)=>event.reply(images)})
