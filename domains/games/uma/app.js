import {createUmaRacePlugin} from '../../../dist/backend/modules/games/infrastructure/uma/app.js'
import {umaRaceManager} from './UmaRaceManager.js'
import {sendSmartReply} from '../../../utils/SmartReply.js'
export const UmaRacePlugin=createUmaRacePlugin(plugin,{umaRaceManager,sendSmartReply})
