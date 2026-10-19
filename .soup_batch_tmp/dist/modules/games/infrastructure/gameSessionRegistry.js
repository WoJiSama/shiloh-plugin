const REGISTRY_KEY = Symbol.for('shiloh-plugin.games.activeGameGroups');
export function publishActiveGameGroups(reader) {
    globalThis[REGISTRY_KEY] = reader;
}
export function readActiveGameGroups() {
    const reader = globalThis[REGISTRY_KEY];
    if (typeof reader !== 'function')
        return new Set();
    try {
        const value = reader();
        return value instanceof Set ? value : new Set();
    }
    catch {
        return new Set();
    }
}
//# sourceMappingURL=gameSessionRegistry.js.map