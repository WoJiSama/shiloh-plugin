import {createMagnetSearchPlugin} from '../../../dist/backend/modules/media/infrastructure/MagnetSearchPlugin.js'
import {renderMagnetSearchReport} from './MagnetSearchReportRenderer.js'
export const MagnetSearchPlugin=createMagnetSearchPlugin(globalThis.plugin,{renderMagnetSearchReport,logger:{warn:(...args)=>globalThis.logger?.warn?.(...args)}})
