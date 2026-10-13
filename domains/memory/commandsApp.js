import common from '../../../../lib/common/common.js'
import { createMemoryCommands } from '../../dist/backend/modules/memory/infrastructure/memoryCommands.js'
import { globalStyleLearnerManager } from './GlobalStyleLearnerManager.js'
import { personaFeedbackManager } from './PersonaFeedbackManager.js'
import { getSharedMemoryManager, getSharedConfig } from '../../core/runtime/sharedRuntime.js'
export const MemoryCommandsPlugin = createMemoryCommands({
  PluginBase: plugin,
  globalStyleLearnerManager,
  personaFeedbackManager,
  getSharedMemoryManager,
  getSharedConfig,
  logger: globalThis.logger,
  makeForwardMsg: common.makeForwardMsg
})
