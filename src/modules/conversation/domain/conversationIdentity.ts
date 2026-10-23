export interface ConversationIdentity {self_id?:string|number|null|undefined;bot?:{uin?:string|number|null|undefined}}
/** Explicit event identity scopes bot-owned state; legacy callers retain their group-only namespace. */
export function smartConversationKey(groupId:string|number,event?:ConversationIdentity):string|number {
 const botId=event?.self_id ?? event?.bot?.uin
 // 私聊按用户隔离:此前 groupId 为空串,所有私聊用户共享一份会话状态互相串台
 if ((event as {message_type?:string} | undefined)?.message_type === "private") {
  const userId=String((event as {user_id?:string|number} | undefined)?.user_id ?? "")
  return botId === undefined || botId === null || botId === '' ? `private:${userId}` : `bot:${String(botId)}:private:${userId}`
 }
 return botId === undefined || botId === null || botId === '' ? groupId : `bot:${String(botId)}:group:${String(groupId)}`
}
