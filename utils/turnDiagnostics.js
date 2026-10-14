import { createTurnDiagnostics } from "../dist/backend/modules/conversation/domain/turnDiagnostics.js"
import {getOutputGuardStats} from "./outputGuardPipeline.js"
export const {recordTurnDiagnostics,getRecentTurns,clearTurnDiagnostics,formatTurnDiagnosticsText}=createTurnDiagnostics(getOutputGuardStats)
