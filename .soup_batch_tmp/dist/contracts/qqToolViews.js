export const qqViewRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
export function qqViewGroup(value) { const raw = qqViewRecord(value); if (!value || typeof value !== 'object')
    return null; const group = {}; const get = raw.getMemberMap, send = raw.sendMsg; if (typeof get === 'function')
    group.getMemberMap = async () => { const result = await Reflect.apply(get, value, []); const members = new Map(); const values = result instanceof Map ? [...result.values()] : Array.isArray(result) ? result : Object.values(qqViewRecord(result)); for (const value of values) {
        const r = qqViewRecord(value);
        if (typeof r.user_id !== 'string' && typeof r.user_id !== 'number')
            continue;
        const id = String(r.user_id);
        members.set(id, { user_id: id, card: String(r.card || ''), nickname: String(r.nickname || ''), role: String(r.role || '') });
    } return members; }; if (typeof send === 'function')
    group.sendMsg = async (message) => Reflect.apply(send, value, [message]); return group; }
export function qqViewBot(value) { const raw = qqViewRecord(value); if (!value || typeof value !== 'object')
    return null; const bot = { uin: String(raw.uin || '') }; const send = raw.sendApi, pick = raw.pickGroup; if (typeof send === 'function')
    bot.sendApi = async (action, params) => Reflect.apply(send, value, [action, params]); if (typeof pick === 'function')
    bot.pickGroup = async (id) => qqViewGroup(await Reflect.apply(pick, value, [id])) || {}; return bot; }
export function qqViewEvent(value) { const raw = qqViewRecord(value); const e = { raw: value, group_id: String(raw.group_id || ''), user_id: String(raw.user_id || ''), source: qqViewRecord(raw.source), reply_id: raw.reply_id, img: raw.img, bot: qqViewBot(raw.bot), group: qqViewGroup(raw.group) }; const reply = raw.reply; if (typeof reply === 'function')
    e.reply = async (message) => Reflect.apply(reply, value, [message]); return e; }
export async function callQqViewApi(event, ports, action, params = {}) { const bot = event.bot || qqViewBot(ports.getBot?.()); if (!bot?.sendApi)
    throw new Error('找不到OneBotv11 API调用接口'); return qqViewRecord(await bot.sendApi(action, params)); }
export function qqViewApiSucceeded(response) { if (response.status === 'failed' || (response.retcode !== undefined && Number(response.retcode) !== 0))
    return false; return response.status === 'ok' || response.retcode === 0; }
//# sourceMappingURL=qqToolViews.js.map