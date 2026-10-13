import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCachedGroupNames, collectBotGroupNames, mergeGroupNames } from '../groupNames.js'
import { readUserSettings } from '../configWriter.js'
import { createMediaRelayReport } from '../../dist/backend/modules/messaging/infrastructure/mediaRelayAdminReport.js'
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const report = createMediaRelayReport({
 pluginRoot, bot: () => globalThis.Bot, redis: () => globalThis.redis,
 logger: { info: message => globalThis.logger?.info?.(message), warn: message => globalThis.logger?.warn?.(message) },
 readSettings: readUserSettings,
 groupNames: () => mergeGroupNames(readCachedGroupNames(pluginRoot), collectBotGroupNames()),
 render: async (name, data) => { const { default: renderer } = await import('../../../../lib/renderer/loader.js'); return renderer.getRenderer().render(name, data) }
})
export const describeRelayError = report.describeRelayError
export const parseLoginState = report.parseLoginState
export const collectBotHealth = report.collectBotHealth
export const extractRelayFailures = report.extractRelayFailures
export const extractEventFailures = report.extractEventFailures
export const extractSendFailures = report.extractSendFailures
export const buildFailureRows = report.buildFailureRows
export const buildHealthReportView = report.buildHealthReportView
export const healthReportImageMessage = report.healthReportImageMessage
export const renderHealthReportCard = report.renderHealthReportCard
export const startMediaRelayAdminReport = report.startMediaRelayAdminReport
