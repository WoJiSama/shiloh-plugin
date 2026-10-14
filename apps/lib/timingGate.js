import { createTimingGate } from '../../dist/backend/modules/conversation/infrastructure/timingGate.js'
import { resolvePersonaName } from '../../utils/personaSource.js'
import { computeAddresseeSignal } from '../../utils/addresseeSignals.js'
import { buildPersonaTonePrompt } from '../../utils/personaTonePolicy.js'
import { getGroupTopicPrompt, getGroupSocialPrompt, detectAttentionHook } from '../../utils/groupContextState.js'
const runtime = createTimingGate({logger:globalThis.logger,bot:()=>globalThis.Bot || {},resolvePersonaName,computeAddresseeSignal,buildPersonaTonePrompt,getGroupTopicPrompt,getGroupSocialPrompt,detectAttentionHook})
export {formatAttentionHint} from '../../dist/backend/modules/conversation/infrastructure/timingGate.js'
export const runTimingGate = runtime.runTimingGate
