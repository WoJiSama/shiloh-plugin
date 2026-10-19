export function deltaRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
export function deltaEvent(value) { const raw = deltaRecord(value); if (typeof raw.reply !== 'function')
    return null; const reply = raw.reply; return { original: value, msg: String(raw.msg || ''), reply: async (message) => Reflect.apply(reply, value, [message]) }; }
//# sourceMappingURL=deltaForceReport.js.map