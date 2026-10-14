import {createBotFederation} from '../dist/backend/modules/platform/domain/botFederation.js'
const api=createBotFederation({botId:()=>globalThis.Bot?.uin,now:()=>Date.now()})
export const {markBotOnline,onlineBotList,isResponsibleBot,isFederationSibling,assertSoleResponsible}=api
