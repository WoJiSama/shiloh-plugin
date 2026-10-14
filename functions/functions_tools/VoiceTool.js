import {createVoiceTool} from '../../dist/backend/modules/media/infrastructure/VoiceTool.js'
import {pluginBridge} from '../../utils/pluginBridge.js'
import {personaFeedbackManager} from '../../domains/memory/PersonaFeedbackManager.js'
export const VoiceTool=createVoiceTool({getBridge:()=>pluginBridge.instance,guardReply:(...args)=>personaFeedbackManager.guardReply(...args),record:path=>globalThis.segment.record(path)})
