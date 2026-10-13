import {createSemanticMemoryCommands} from '../dist/backend/modules/memory/infrastructure/semanticMemoryCommands.js'
import {getSemanticMemoryRuntime} from '../domains/semanticMemory/runtime.js'
import {buildVisibleFailureDetail} from '../utils/visibleFailure.js'
const commands=createSemanticMemoryCommands({PluginBase:plugin,getSemanticMemoryRuntime,buildVisibleFailureDetail,logger:globalThis.logger})
export const SemanticMemoryPlugin=commands.SemanticMemoryPlugin
export const resolveForgetTarget=commands.resolveForgetTarget
