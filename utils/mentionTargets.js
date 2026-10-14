import { messageMentionsUser as mentions } from '../dist/backend/modules/conversation/domain/mentionTargets.js'
export { getMentionTargetId, collectMentionTargetIds, replaceCqMentions, stripCqMentions } from '../dist/backend/modules/conversation/domain/mentionTargets.js'
export const messageMentionsUser = (event = {}, userId = '') => mentions({...event, self_id:event.self_id ?? globalThis.Bot?.uin}, userId)
