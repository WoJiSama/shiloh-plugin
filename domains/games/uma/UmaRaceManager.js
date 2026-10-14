import {createUmaRaceManager} from '../../../dist/backend/modules/games/infrastructure/uma/UmaRaceManager.js'
import {sendSmartReply} from '../../../utils/SmartReply.js'
export const {UmaRaceManager}=createUmaRaceManager({sendSmartReply,renderReport:async(event,report)=>(await import('./UmaRaceReportRenderer.js')).renderUmaRaceReport(event,report)})
export const umaRaceManager=new UmaRaceManager({logger:globalThis.logger})
