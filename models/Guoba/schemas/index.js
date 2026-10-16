import { readUserSettings, applyFlatUpdates } from "../../../utils/configWriter.js"
import { createConfigPanel } from "../../../dist/backend/modules/config/application/configPanel.js"
import { schemas } from "../../../dist/backend/modules/config/domain/schemas/guoba/index.js"

export { schemas }
const panel = createConfigPanel({ schemas, readSettings: readUserSettings, applyUpdates: applyFlatUpdates })
export const getConfigData = panel.getConfigData
export const setConfigData = panel.setConfigData
