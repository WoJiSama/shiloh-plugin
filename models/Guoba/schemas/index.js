import { readUserSettings, applyFlatUpdates } from "../../../utils/configWriter.js"
import { createConfigPanel } from "../../../dist/backend/modules/config/application/configPanel.js"
import { classifyConfigKind, probeProviders, summarizeProbes } from "../../../utils/aiProviderProbe.js"
export { schemas } from "../../../dist/backend/modules/config/domain/schemas/guoba/index.js"
const panel = createConfigPanel({ readSettings: readUserSettings, applyUpdates: applyFlatUpdates, classifyKind: classifyConfigKind, probeProviders, summarizeProbes })
export const getConfigData = panel.getConfigData
export const setConfigData = panel.setConfigData
