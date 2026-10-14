import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {createVideoAnalysisTool} from '../../dist/backend/modules/toolSupport/infrastructure/VideoAnalysisTool.js'
export const VideoAnalysisTool=createVideoAnalysisTool({
 loadConfig:()=>{try{return YAML.parse(fs.readFileSync(path.join(process.cwd(),'plugins/shiloh-plugin/config/message.yaml'),'utf8'))?.pluginSettings}catch{return {}}},
 getBot:id=>{const bot=globalThis.Bot||globalThis.bot;return String(bot?.uin)===String(id)?bot:bot?.[id]||null},env:process.env,
 logger:{info:(...args)=>globalThis.logger?.info?.(...args),debug:(...args)=>globalThis.logger?.debug?.(...args),error:(...args)=>globalThis.logger?.error?.(...args)}
})
