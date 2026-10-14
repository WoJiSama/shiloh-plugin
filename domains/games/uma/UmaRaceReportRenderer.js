import puppeteer from '../../../../../lib/puppeteer/puppeteer.js'
import UmaRaceReport from './model/UmaRaceReport.js'
import {createUmaRaceReportRenderer} from '../../../dist/backend/modules/games/infrastructure/uma/UmaRaceReportRenderer.js'
export {buildUmaRaceReportView} from '../../../dist/backend/modules/games/infrastructure/uma/UmaRaceReportRenderer.js'
export const renderUmaRaceReport=createUmaRaceReportRenderer(puppeteer,UmaRaceReport)
