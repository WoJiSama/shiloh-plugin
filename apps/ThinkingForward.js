import {handleThinkingForwardCommand} from '../utils/thinkingForwardSettings.js'
import {createThinkingForwardPlugin} from '../dist/backend/modules/host/infrastructure/ThinkingForward.js'
export const ThinkingForwardPlugin=createThinkingForwardPlugin(plugin,handleThinkingForwardCommand)
