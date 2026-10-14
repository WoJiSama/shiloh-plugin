import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {createGoogleImageAnalysisTool} from '../../dist/backend/modules/toolSupport/infrastructure/GoogleAnalysisTool.js'
import {getBase64Image,normalizeImageUrls} from '../../utils/fileUtils.js'
import {generateContextualProgressReply} from '../../utils/contextualProgressReply.js'
import {personaFeedbackManager} from '../../domains/memory/PersonaFeedbackManager.js'
export const GoogleImageAnalysisTool=createGoogleImageAnalysisTool({
 loadConfig:()=>YAML.parse(fs.readFileSync(path.join(process.cwd(),'plugins/shiloh-plugin/config/message.yaml'),'utf8')).pluginSettings,
 normalizeImageUrls,imageLoader:getBase64Image,progressReplyFactory:generateContextualProgressReply,
 guardReply:(...args)=>personaFeedbackManager.guardReply(...args),
 callApi:(action,params)=>(globalThis.Bot||globalThis.bot)?.sendApi?.(action,params),
 logger:{info:(...args)=>globalThis.logger?.info?.(...args),warn:(...args)=>(globalThis.logger||console).warn(...args)}
})
