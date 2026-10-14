import { BUILTIN_TOOL_MANIFESTS } from "./builtinToolManifests.js"
import { initializeBuiltinToolManifests } from "../dist/backend/modules/tools/domain/toolManifestRegistry.js"
initializeBuiltinToolManifests(BUILTIN_TOOL_MANIFESTS)
export { registerToolManifest, registerToolManifests, isTerminalTool, getTerminalToolSet, isBackgroundTerminalTool, getBackgroundTerminalToolSet, getRegisteredIntentManifest, getAllRegisteredIntentManifests, resetToolManifestRegistry } from "../dist/backend/modules/tools/domain/toolManifestRegistry.js"
