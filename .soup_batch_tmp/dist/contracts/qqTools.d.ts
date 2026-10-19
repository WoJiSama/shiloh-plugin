import type { MentionEvent } from './chatEvent.js';
export interface QqMember {
    user_id: number;
    card?: string;
    nickname?: string;
    role?: string;
    shutup_time?: number;
}
export interface QqToolGroup {
    name?: string;
    group_id?: string | number;
    getMemberMap(): Promise<Map<number, QqMember>>;
    muteMember(id: number, time: number): Promise<unknown>;
    muteAll(time: number): Promise<unknown>;
    sendMsg(message: string): Promise<unknown>;
}
export interface QqToolBot {
    uin: number;
    nickname?: string;
    sendApi(action: string, params: Record<string, unknown>): Promise<unknown>;
    pickGroup(id: string | number): QqToolGroup;
    pickFriend?(id: number): {
        thumbUp?(times: number): Promise<unknown>;
    };
}
export interface QqToolEvent extends MentionEvent {
    group_id?: string | number;
    bot?: QqToolBot;
    group?: QqToolGroup;
    user_id?: string | number;
    sender?: {
        user_id?: string | number;
        role?: string;
    };
    reply_id?: string | number;
    source?: {
        message_id?: string | number;
        seq?: string | number;
    };
    getReply?(): Promise<unknown>;
}
export interface QqToolPorts {
    getBot(): QqToolBot | undefined;
}
export type PbValue = number | string | PbObject | PbValue[] | undefined | null;
export interface PbObject {
    [tag: number]: PbValue;
}
