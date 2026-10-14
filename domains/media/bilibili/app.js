import {createBilibiliRelayPlugin} from '../../../dist/backend/modules/media/infrastructure/BilibiliRelayPlugin.js'
import {assertSoleResponsible} from '../../../utils/botFederation.js'
import {BilibiliAuthManager} from '../../../utils/BilibiliAuthManager.js'
export const BilibiliRelayPlugin=createBilibiliRelayPlugin(globalThis.plugin,{
 assertSoleResponsible,BilibiliAuthManager,getBot:e=>{const bot=globalThis.Bot||globalThis.bot;if(e.bot)return e.bot;if(String(bot?.uin)===String(e.self_id))return bot;return bot?.[e.self_id]||null},segmentApi:globalThis.segment,
 logger:{warn:(...args)=>globalThis.logger?.warn?.(...args),error:(...args)=>globalThis.logger?.error?.(...args)}
})
