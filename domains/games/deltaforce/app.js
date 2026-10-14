import {createDeltaForcePlugin} from '../../../dist/backend/modules/games/infrastructure/deltaForceApp.js'
import {renderDeltaForceReport} from './DeltaForceReportRenderer.js'
export const DeltaForcePlugin=createDeltaForcePlugin(plugin,{renderReport:renderDeltaForceReport,logger:globalThis.logger||{}})
