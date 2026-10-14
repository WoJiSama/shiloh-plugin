import puppeteer from "../../../../../lib/puppeteer/puppeteer.js"
import DeltaForceReport from "./model/DeltaForceReport.js"
import {createDeltaForceReportRenderer} from '../../../dist/backend/modules/games/infrastructure/DeltaForceReportRenderer.js'
export {buildDeltaForceReportView} from '../../../dist/backend/modules/games/infrastructure/DeltaForceReportRenderer.js'
export const {renderDeltaForceReport}=createDeltaForceReportRenderer(puppeteer,DeltaForceReport)
