export function pixivRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
export function pixivText(value) { return typeof value === 'string' ? value : ''; }
//# sourceMappingURL=pixiv.js.map