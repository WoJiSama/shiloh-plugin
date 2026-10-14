export type ChatIdentity = string | number | null | undefined
export interface ChatMember {user_id?:ChatIdentity;card?:string;nickname?:string;role?:string;title?:string}
export interface RecentChatMessage {userId?:ChatIdentity;text?:string;at?:number}
export interface MessageSegment {type?:string;text?:string;qq?:unknown;user_id?:unknown;id?:unknown;uin?:unknown;uid?:unknown;sender_id?:unknown;sender?:{user_id?:unknown;qq?:unknown};data?:{qq?:unknown;user_id?:unknown;id?:unknown;uin?:unknown;uid?:unknown;sender_id?:unknown;sender?:{user_id?:unknown;qq?:unknown}}}
export interface MentionEvent {at?:unknown;at_user?:unknown;message?:MessageSegment[];msg?:string;bot?:{uin?:ChatIdentity};self_id?:ChatIdentity;atBot?:boolean;atme?:boolean;atMe?:boolean;isAt?:boolean}
export interface QuoteEvent {source?:MessageSegment;reply?:MessageSegment|((...args:unknown[])=>unknown);replyMessage?:MessageSegment;quoted?:MessageSegment;quote?:MessageSegment;message?:MessageSegment[]}
