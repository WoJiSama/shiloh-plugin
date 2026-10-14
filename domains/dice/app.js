import {createDicePlugin} from '../../dist/backend/modules/dice/infrastructure/app.js'
import {diceManager} from './DiceManager.js'
import {deckManager} from './DeckManager.js'
import {sendSmartReply} from '../../utils/SmartReply.js'
import {fileURLToPath} from 'node:url'
export const DicePlugin=createDicePlugin(plugin,{diceManager,deckManager,sendSmartReply,pluginRoot:fileURLToPath(new URL('../../',import.meta.url)),logger:globalThis.logger||{},fallbackBot:globalThis.Bot})
