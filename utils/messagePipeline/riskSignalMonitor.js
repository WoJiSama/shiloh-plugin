import { readUserSettings } from '../configWriter.js'
import { createLegacyRiskMonitor } from '../../dist/backend/adapters/riskSignalMonitor.js'
const api = createLegacyRiskMonitor({ getBot: () => globalThis.Bot, getLogger: () => globalThis.logger, getRuntime: () => globalThis[Symbol.for('shiloh-plugin.message-pipeline.runtime')], getSettings: readUserSettings })
export const createRiskSignalMonitor = api.createRiskSignalMonitor
export const matchRiskResponse = api.matchRiskResponse
export const defaultMonitor = api.defaultMonitor
export const installRiskSignalNoticeListener = api.installRiskSignalNoticeListener
export default defaultMonitor
