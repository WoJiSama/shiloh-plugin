import {createSendLocalEmojiTool} from '../../dist/backend/modules/content/infrastructure/SendLocalEmojiTool.js'
import {emojiPackManager} from '../../domains/emoji/EmojiPackManager.js'
import {pluginBridge} from '../../utils/pluginBridge.js'
export const {SendLocalEmojiTool}=createSendLocalEmojiTool({manager:emojiPackManager,image:file=>globalThis.segment.image(file),rhythmConfig:()=>pluginBridge.instance?.config?.replyRhythm||{},sendText:async(event,text)=>{if(!pluginBridge.instance?.sendSegmentedMessage)return event.reply(text);const messageId=await pluginBridge.instance.sendSegmentedMessage(event,text,0);return {message_id:messageId}}})
