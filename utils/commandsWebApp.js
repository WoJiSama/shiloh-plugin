import chokidar from 'chokidar'
import {createCommandsWebApp} from '../dist/backend/modules/platform/infrastructure/console/commandsWebApp.js'
import {deckManager} from '../domains/dice/DeckManager.js'
import {diceManager} from '../domains/dice/DiceManager.js'
import {emojiPackManager} from '../domains/emoji/EmojiPackManager.js'
import {readUserSettings,applyFlatUpdates} from './configWriter.js'
import {ensureGuobaJumpLink,watchGuobaJumpLink} from './guobaJumpLink.js'
import {checkGuobaLoginToken} from './guobaLoginTrust.js'
import {collectBotGroupNames,collectBotIdentities} from './groupNames.js'
const app = createCommandsWebApp({
  app:()=>globalThis.Bot?.express,
  deckManager,diceManager,emojiPackManager,readUserSettings,applyFlatUpdates,
  ensureGuobaJumpLink,watchGuobaJumpLink,checkGuobaLoginToken,collectBotGroupNames,collectBotIdentities,
  watch:(file,callback)=>chokidar.watch(file).on('all',callback),
  registerObserveWebApp:async (...args)=>(await import('./observeWebApp.js')).registerObserveWebApp(...args),
  registerSemanticMemoryWebApp:async (...args)=>(await import('./semanticMemoryWebApp.js')).registerSemanticMemoryWebApp(...args),
  registerQzoneWebApp:async (...args)=>(await import('./qzoneWebApp.js')).registerQzoneWebApp(...args)
})
export function registerCommandsWebApp(pluginRoot = process.cwd(), {logger = globalThis.logger} = {}) {
  return app.registerCommandsWebApp(pluginRoot, {logger})
}
