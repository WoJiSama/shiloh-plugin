export interface ConversationIdentity {self_id?:string|number|null|undefined;bot?:{uin?:string|number|null|undefined}}
/** Explicit event identity scopes bot-owned state; legacy callers retain their group-only namespace. */
export function smartConversationKey(groupId:string|number,event?:ConversationIdentity):string|number {
 const botId=event?.self_id ?? event?.bot?.uin
 return botId === undefined || botId === null || botId === '' ? groupId : `bot:${String(botId)}:group:${String(groupId)}`
}
