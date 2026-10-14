export interface DedupeToolRun {groupId?:string|number;userId?:string|number;messageId?:unknown;toolName:string;startedAt:number}
export const lastIncomingMsgAt = new Map<string|number,number>()
export const activeDedupeToolRuns = new Map<string,DedupeToolRun>()
export const LOCAL_EMOJI_TOOL_NAME = 'sendLocalEmojiTool'

export {smartConversationKey} from './conversationIdentity.js'
