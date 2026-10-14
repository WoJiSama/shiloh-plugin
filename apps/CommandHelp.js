import {registerCommandsWebApp} from '../utils/commandsWebApp.js'
import {createCommandHelp} from '../dist/backend/modules/host/infrastructure/CommandHelp.js'
export const CommandHelp=createCommandHelp(plugin,{registerCommandsWebApp,logger:globalThis.logger})
