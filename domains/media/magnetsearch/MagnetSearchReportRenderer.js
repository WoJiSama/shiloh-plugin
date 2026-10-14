import puppeteer from '../../../../../lib/puppeteer/puppeteer.js'
import MagnetSearchReport from './model/MagnetSearchReport.js'
import {createMagnetSearchReportRenderer} from '../../../dist/backend/modules/media/infrastructure/MagnetSearchReportRenderer.js'
export {buildMagnetSearchReportView} from '../../../dist/backend/modules/media/infrastructure/MagnetSearchReportRenderer.js'
export const {renderMagnetSearchReport}=createMagnetSearchReportRenderer(puppeteer,MagnetSearchReport)
