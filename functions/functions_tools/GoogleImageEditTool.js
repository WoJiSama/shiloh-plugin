import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {createGoogleImageEditTool} from '../../dist/backend/modules/toolSupport/infrastructure/GoogleImageEditTool.js'
import {getBase64Image,normalizeImageUrls} from '../../utils/fileUtils.js'
import {sendImageReliably} from '../../utils/reliableImageSender.js'
import mimeTypes from 'mime-types'
import {generateContextualProgressReply} from '../../utils/contextualProgressReply.js'
import {personaFeedbackManager} from '../../domains/memory/PersonaFeedbackManager.js'
import {pluginBridge} from '../../utils/pluginBridge.js'
export const GoogleImageEditTool=createGoogleImageEditTool({
 loadConfig:()=>YAML.parse(fs.readFileSync(path.join(process.cwd(),'plugins/shiloh-plugin/config/message.yaml'),'utf8')).pluginSettings,
 normalizeImageUrls,imageLoader:getBase64Image,progressReplyFactory:generateContextualProgressReply,
 guardReply:(...args)=>personaFeedbackManager.guardReply(...args),
 callApi:(action,params)=>(globalThis.Bot||globalThis.bot)?.sendApi?.(action,params),
 getRedis:()=>globalThis.redis||null,
 getBridge:()=>pluginBridge.instance,
 getBot:id=>{const bot=globalThis.Bot||globalThis.bot;if(!id||String(bot?.uin)===String(id))return bot||null;return bot?.[id]||null},
 sendImageReliably,mimeTypes,
 logger:{info:(...args)=>(globalThis.logger||console).info(...args),warn:(...args)=>(globalThis.logger||console).warn(...args)}
})
