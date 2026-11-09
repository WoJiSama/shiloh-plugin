import {createRouteDecision} from '../dist/backend/modules/conversation/application/routeDecision.js'
import {resolveDeterministicToolIntent} from './toolIntentManifests.js'
// naturalDeltaForce 路由规则已退役(2026-11 路由手术):语义判定权归规划器/主模型,不再注入正则兜底。
const api=createRouteDecision({resolveDeterministicToolIntent})
export const {ROUTE_RULES,resolveToolRoute}=api
