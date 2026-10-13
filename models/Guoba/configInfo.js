import { schemas, getConfigData, setConfigData } from "./schemas/index.js"
import { createConfigPanel } from "../../dist/backend/modules/config/application/configPanel.js"
import { readUserSettings, applyFlatUpdates } from "../../utils/configWriter.js"
import { classifyConfigKind, probeProviders, summarizeProbes } from "../../utils/aiProviderProbe.js"
const panel = createConfigPanel({ readSettings: readUserSettings, applyUpdates: applyFlatUpdates, classifyKind: classifyConfigKind, probeProviders, summarizeProbes,
 logger: { info: message => globalThis.logger?.info?.(message), error: message => globalThis.logger?.error?.(message) } })
export const configInfo = { schemas, getConfigData, setConfigData, actions: { testAiProviders: panel.testAiProviders } }
