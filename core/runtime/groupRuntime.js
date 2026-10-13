// Legacy composition boundary: keep platform context outside the typed application.
import { createLegacyGroupRuntime } from '../../dist/backend/adapters/legacyRuntime.js'
import { peekGroupTopicState, peekGroupSocialState } from '../../utils/groupContextState.js'
const runtime = createLegacyGroupRuntime({
  peekTopic: peekGroupTopicState,
  peekSocial: peekGroupSocialState,
  logger: { warn(message) { globalThis.logger?.warn?.(message) } }
})
export const getSmartRuntimeState = runtime.getSmartRuntimeState
export const deleteSmartRuntimeState = runtime.deleteSmartRuntimeState
export const smartRuntimeGroupIds = runtime.smartRuntimeGroupIds
export const hasSmartRuntimeState = runtime.hasSmartRuntimeState
export const smartRuntimeSize = runtime.smartRuntimeSize
export const getGroupRuntime = runtime.getGroupRuntime
export const resetGroupRuntimeForTests = runtime.resetGroupRuntimeForTests
export const registerGroupRuntimeProviders = runtime.registerGroupRuntimeProviders
export const registerRuntimeSweep = runtime.registerRuntimeSweep
export const unregisterRuntimeSweep = runtime.unregisterRuntimeSweep
export const listRuntimeSweeps = runtime.listRuntimeSweeps
export const runRuntimeSweeps = runtime.runRuntimeSweeps
