export declare function ensureDir(dir: string): void;
export interface AtomicJsonStore {
    readonly filePath: string;
    exists(): boolean;
    readText(): string | null;
    write(data: unknown): Promise<void>;
}
export declare function createAtomicJsonStore(filePath: string): AtomicJsonStore;
export declare function readPluginSettings(cwd: string): Record<string, unknown>;
export declare function resolveDataDir(cwd: string, baseDir: string): string;
export declare function decodeMiniGamesSettings(settings: Record<string, unknown>): {
    enabled: boolean;
    turtleSoup: Record<string, unknown>;
};
