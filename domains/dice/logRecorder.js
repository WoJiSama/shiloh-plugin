import {diceManager} from './DiceManager.js'
import {createDiceLogRecorder} from '../../dist/backend/modules/dice/infrastructure/logRecorder.js'
export const DiceLogRecorder=createDiceLogRecorder(globalThis.plugin,{recordLogMessage:event=>diceManager.recordLogMessage(event),warn:message=>globalThis.logger?.warn?.(message)})
