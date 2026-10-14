import { isExplicitAdminCollectionMentionRequest } from "../../utils/mentionRoleRouting.js"
import { selectToolIntentCandidates } from "../../utils/toolIntentManifests.js"
import { buildToolSkillCatalog, normalizeToolSkillParams } from "../../utils/toolSkills.js"
import { fetchWithTimeout } from "../../utils/modelGateway.js"
import { resolvePersonaName } from "../../utils/personaSource.js"
import { hasSemanticPlannerCandidate, shouldRunSemanticToolPlanner } from "../../utils/semanticToolPolicy.js"
import { resolveMemberAvatarReferences } from "./avatarReference.js"
import {createSemanticToolIntent} from "../../dist/backend/modules/tools/infrastructure/semanticToolIntent.js"
const semantic = createSemanticToolIntent({logger:{warn: message=>globalThis.logger?.warn?.(message),info:message=>globalThis.logger?.info?.(message)},isExplicitAdminCollectionMentionRequest,selectToolIntentCandidates,normalizeToolSkillParams,resolveMemberAvatarReferences,buildToolSkillCatalog,resolvePersonaName,hasSemanticPlannerCandidate,shouldRunSemanticToolPlanner,fetchWithTimeout})
export const shouldUseSemanticToolIntent=semantic.shouldUseSemanticToolIntent
export const normalizeToolDecision=semantic.normalizeToolDecision
export const buildAnnotatedClassifierText=semantic.buildAnnotatedClassifierText
export const extractJsonObject=semantic.extractJsonObject
export const classifySemanticToolIntent=semantic.classifySemanticToolIntent
export const buildToolCallFromDecision=semantic.buildToolCallFromDecision
export const buildMissingToolCommitmentCall=semantic.buildMissingToolCommitmentCall
