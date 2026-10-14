import type { MessageCacheOptions } from '../modules/messaging/domain/messageCacheTtl.js'
export interface Segment { type: string; url?: string; fid?: string; text?: string; size?: number; name?: string; id?: string | number; qq?: string | number; title?: string; [field: string]: unknown }
export interface Sender { user_id?: string | number | undefined; nickname?: string | undefined; card?: string; role?: string | undefined; title?: string | undefined; level?: unknown; identity?: string }
export interface MessageEvent {
 self_id?: string | number; message_type?: string; message?: Segment[]; raw_message?: string; sender?: Sender; time: number
 event_id?: unknown; message_id?: unknown; source?: unknown; group_id?: string | number; group_name?: string
 group?: {getFileUrl(fid: string): Promise<string>}; friend?: {getFileUrl(fid: string): Promise<string>}
}
export interface StoredMessage { time: string; sender: Sender; content: string; event_id?: unknown; message_id?: unknown; group_name?: string | null | undefined; [field:string]:unknown }
export interface RecentOptions extends MessageCacheOptions { privateMaxMessages?: number; groupMaxMessages?: number; messageMaxLength?: number; preEnrichedMessage?: Segment[]; throwOnError?: boolean }
export interface RecentMessagePorts {
 redis: {get(key: string): Promise<string | null>; set(key: string, value: string, options: {EX: number}): Promise<unknown>; del(...keys: string[]): Promise<unknown>; keys(pattern: string): Promise<string[]>; scanIterator?(options: {MATCH:string;COUNT:number}): AsyncIterable<string | string[]>; scan?(cursor: string, ...args: (string|number)[]): Promise<[string|number,string[]]>}
 bot: { uin?: string | number | undefined; nickname?: string | undefined }
 logger: {info(message: string): void; warn(message: string): void; error(message: string): void}
 queue: {run<T>(key: string, work: () => Promise<T>): Promise<T>}
 scheduleJob(cron: string, callback: () => Promise<void>): unknown
 getUrl(url: string): Promise<{headers: Record<string,string | undefined>}>
 formatTime(time: number): string; parseTime(time: string): number
 refreshTencentImageUrl(url: string, fid?: string): Promise<string>
 enrichBilibiliMessageSegments(message?: Segment[], raw?: string): Promise<Segment[]>
 enrichDouyinMessageSegments(message?: Segment[], raw?: string): Promise<Segment[]>
 formatBilibiliHistoryText(segment: Segment): string; formatBilibiliHistoryLinks(segment: Segment): string
 formatDouyinHistoryText(segment: Segment): string; formatDouyinHistoryLinks(segment: Segment): string
}
