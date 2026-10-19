// 海龟汤数据存取:puzzles/plays/sessions 三份JSON,读走严格解码,写走原子落盘。
import path from "path";
import { createAtomicJsonStore, decodeMiniGamesSettings, ensureDir, readPluginSettings, resolveDataDir } from '../gameFiles.js';
import { decodeTurtleSoupPlayFile, decodeTurtleSoupPuzzleFile, decodeTurtleSoupSessionFile, emptyTurtleSoupPlayFile, emptyTurtleSoupPuzzleFile, emptyTurtleSoupSessionFile } from '../../domain/turtleSoup/turtleSoupSchema.js';
const DEFAULT_CONTENT_POLICY = "题材保持本格推理趣味,可以悬疑惊悚,但避免直白血腥、猎奇虐待细节与涉政内容";
const safeNumber = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const safeText = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
export function readTurtleSoupConfig(cwd) {
    const { turtleSoup } = decodeMiniGamesSettings(readPluginSettings(cwd));
    return {
        enabled: turtleSoup.enabled !== false,
        minPlayers: Math.floor(safeNumber(turtleSoup.minPlayers, 1, 1, 50)),
        joinWindowMinutes: Math.floor(safeNumber(turtleSoup.joinWindowMinutes, 5, 1, 60)),
        idleTimeoutMinutes: Math.floor(safeNumber(turtleSoup.idleTimeoutMinutes, 5, 1, 240)),
        guessCooldownSeconds: Math.floor(safeNumber(turtleSoup.guessCooldownSeconds, 30, 0, 3600)),
        similarityHitThreshold: safeNumber(turtleSoup.similarityHitThreshold, 0.9, 0.5, 1),
        similarityMissThreshold: safeNumber(turtleSoup.similarityMissThreshold, 0, 0, 0.9),
        freshPoolTarget: Math.floor(safeNumber(turtleSoup.freshPoolTarget, 2, 1, 50)),
        generationModel: safeText(turtleSoup.generationModel, ""),
        ratingWindowMinutes: Math.floor(safeNumber(turtleSoup.ratingWindowMinutes, 5, 1, 120)),
        maxHints: Math.floor(safeNumber(turtleSoup.maxHints, 3, 0, 10)),
        recapEveryQuestions: Math.floor(safeNumber(turtleSoup.recapEveryQuestions, 10, 0, 100)),
        chooseWindowSeconds: Math.floor(safeNumber(turtleSoup.chooseWindowSeconds, 60, 10, 300)),
        contentPolicy: safeText(turtleSoup.contentPolicy, DEFAULT_CONTENT_POLICY),
        baseDir: safeText(turtleSoup.baseDir, "data/turtle_soup")
    };
}
export class TurtleSoupStore {
    dataDir;
    puzzlesStore;
    playsStore;
    sessionsStore;
    constructor({ cwd = process.cwd(), baseDir = "data/turtle_soup" } = {}) {
        this.dataDir = resolveDataDir(cwd, baseDir);
        ensureDir(this.dataDir);
        this.puzzlesStore = createAtomicJsonStore(path.join(this.dataDir, "puzzles.json"));
        this.playsStore = createAtomicJsonStore(path.join(this.dataDir, "plays.json"));
        this.sessionsStore = createAtomicJsonStore(path.join(this.dataDir, "sessions.json"));
    }
    readPuzzles() {
        const text = this.puzzlesStore.readText();
        if (text === null)
            return emptyTurtleSoupPuzzleFile();
        return decodeTurtleSoupPuzzleFile(JSON.parse(text));
    }
    async writePuzzles(file) { await this.puzzlesStore.write(file); }
    savePuzzle(puzzle) {
        const file = this.readPuzzles();
        const index = file.puzzles.findIndex(item => item.id === puzzle.id);
        if (index >= 0)
            file.puzzles[index] = puzzle;
        else
            file.puzzles.push(puzzle);
        return this.writePuzzles(file);
    }
    readPlays() {
        const text = this.playsStore.readText();
        if (text === null)
            return emptyTurtleSoupPlayFile();
        return decodeTurtleSoupPlayFile(JSON.parse(text));
    }
    async writePlays(file) { await this.playsStore.write(file); }
    upsertPlay(play) {
        const file = this.readPlays();
        const index = file.plays.findIndex(item => item.playId === play.playId);
        if (index >= 0)
            file.plays[index] = play;
        else
            file.plays.push(play);
        return this.writePlays(file);
    }
    readSessions() {
        const text = this.sessionsStore.readText();
        if (text === null)
            return emptyTurtleSoupSessionFile();
        return decodeTurtleSoupSessionFile(JSON.parse(text));
    }
    async writeSessions(file) { await this.sessionsStore.write(file); }
    saveSession(session) {
        const file = this.readSessions();
        file.sessions[session.groupId] = session;
        return this.writeSessions(file);
    }
    removeSession(groupId) {
        const file = this.readSessions();
        if (!(groupId in file.sessions))
            return Promise.resolve();
        delete file.sessions[groupId];
        return this.writeSessions(file);
    }
}
//# sourceMappingURL=TurtleSoupStore.js.map