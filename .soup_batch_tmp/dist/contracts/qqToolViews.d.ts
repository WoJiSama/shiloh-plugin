export declare const qqViewRecord: (value: unknown) => Record<string, unknown>;
export interface QqViewMember {
    user_id: string;
    card: string;
    nickname: string;
    role: string;
}
export interface QqViewGroup {
    getMemberMap?(): Promise<Map<string, QqViewMember>>;
    sendMsg?(message: unknown): Promise<unknown>;
}
export interface QqViewBot {
    uin: string;
    sendApi?(action: string, params: Record<string, unknown>): Promise<unknown>;
    pickGroup?(id: string | number): Promise<QqViewGroup>;
}
export interface QqViewEvent {
    raw: unknown;
    group_id: string;
    user_id: string;
    source: Record<string, unknown>;
    reply_id: unknown;
    img: unknown;
    bot: QqViewBot | null;
    group: QqViewGroup | null;
    reply?: (message: unknown) => Promise<unknown>;
}
export declare function qqViewGroup(value: unknown): QqViewGroup | null;
export declare function qqViewBot(value: unknown): QqViewBot | null;
export declare function qqViewEvent(value: unknown): QqViewEvent;
export interface QqViewPorts {
    getBot?(): unknown;
}
export declare function callQqViewApi(event: QqViewEvent, ports: QqViewPorts, action: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function qqViewApiSucceeded(response: Record<string, unknown>): boolean;
