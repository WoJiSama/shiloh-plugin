export function adminRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
export function adminError(value) { return value instanceof Error ? value.message : String(value); }
export function requireAdminBot(ports, event) { const bot = event?.bot || ports.getBot(); if (!bot)
    throw new Error('机器人未连接'); return bot; }
export function decodeAdminEvent(value) { const raw = adminRecord(value); const event = {}; for (const key of ['group_id', 'user_id', 'self_id', 'message_id', 'seq']) {
    const id = raw[key];
    if (typeof id === 'string' || typeof id === 'number')
        event[key] = id;
} for (const key of ['msg', 'raw_message', 'nickname', 'card', 'sub_type']) {
    if (typeof raw[key] === 'string')
        event[key] = raw[key];
} if (Array.isArray(raw.message))
    event.message = raw.message; const sender = adminRecord(raw.sender); event.sender = {}; for (const key of ['nickname', 'card', 'role']) {
    if (typeof sender[key] === 'string')
        event.sender[key] = sender[key];
} if (typeof sender.user_id === 'string' || typeof sender.user_id === 'number')
    event.sender.user_id = sender.user_id; if (sender.level !== undefined)
    event.sender.level = sender.level; return event; }
//# sourceMappingURL=groupAdmin.js.map