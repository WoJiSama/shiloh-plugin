import {createDeltaForceTool} from '../../dist/backend/modules/games/infrastructure/DeltaForceTool.js'
import {renderDeltaForceReport} from '../../domains/games/deltaforce/DeltaForceReportRenderer.js'
export const DeltaForceTool=createDeltaForceTool({renderReport:renderDeltaForceReport,logger:globalThis.logger||{}})
