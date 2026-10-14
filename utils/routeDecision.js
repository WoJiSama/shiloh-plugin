import {createRouteDecision} from '../dist/backend/modules/conversation/application/routeDecision.js'
import {resolveDeterministicToolIntent} from './toolIntentManifests.js'
import {resolveNaturalDeltaForceToolCall} from './deltaForceIntent.js'
const api=createRouteDecision({resolveDeterministicToolIntent,resolveNaturalDeltaForceToolCall})
export const {ROUTE_RULES,resolveToolRoute}=api
