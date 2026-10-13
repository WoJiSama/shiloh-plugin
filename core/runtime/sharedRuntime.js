// Compatibility entry: command/config capabilities are projected by the typed adapter.
import { createLegacySharedRuntime } from '../../dist/backend/adapters/sharedRuntime.js'
const runtime = createLegacySharedRuntime()
export const setSharedRuntime = runtime.setSharedRuntime
export const getSharedRuntime = runtime.getSharedRuntime
export const getSharedMemoryManager = runtime.getSharedMemoryManager
export const getSharedConfig = runtime.getSharedConfig
