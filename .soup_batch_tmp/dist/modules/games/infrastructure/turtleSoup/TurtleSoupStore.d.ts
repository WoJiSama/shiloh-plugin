import type { TurtleSoupConfig, TurtleSoupPuzzle, TurtleSoupPuzzleFile, TurtleSoupPlay, TurtleSoupPlayFile, TurtleSoupSession, TurtleSoupSessionFile } from '../../../../contracts/turtleSoup.js';
export declare function readTurtleSoupConfig(cwd: string): TurtleSoupConfig;
export declare class TurtleSoupStore {
    readonly dataDir: string;
    private readonly puzzlesStore;
    private readonly playsStore;
    private readonly sessionsStore;
    constructor({ cwd, baseDir }?: {
        cwd?: string;
        baseDir?: string;
    });
    readPuzzles(): TurtleSoupPuzzleFile;
    writePuzzles(file: TurtleSoupPuzzleFile): Promise<void>;
    savePuzzle(puzzle: TurtleSoupPuzzle): Promise<void>;
    readPlays(): TurtleSoupPlayFile;
    writePlays(file: TurtleSoupPlayFile): Promise<void>;
    upsertPlay(play: TurtleSoupPlay): Promise<void>;
    readSessions(): TurtleSoupSessionFile;
    writeSessions(file: TurtleSoupSessionFile): Promise<void>;
    saveSession(session: TurtleSoupSession): Promise<void>;
    removeSession(groupId: string): Promise<void>;
}
