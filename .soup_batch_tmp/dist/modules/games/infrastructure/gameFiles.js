// 小游戏模块共用的文件基建:目录保障、带写入链的原子JSON读写(pluginSettings 读取)。
// 抽象尺度:只放无游戏语义的通用件,赛马娘现有代码暂不迁移,待海龟汤跑通后再收敛。
import fs from "fs";
import path from "path";
import YAML from "yaml";
export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
// 同一文件的写操作串行化(写入链),临时文件+rename 保证崩溃不产生半截文件。
export function createAtomicJsonStore(filePath) {
    let writeChain = Promise.resolve();
    const enqueue = (task) => {
        const next = writeChain.catch(() => { }).then(task);
        writeChain = next.catch(() => { });
        return next;
    };
    return {
        filePath,
        exists: () => fs.existsSync(filePath),
        readText: () => (fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null),
        write: data => enqueue(async () => {
            ensureDir(path.dirname(filePath));
            const tmp = `${filePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
            fs.renameSync(tmp, filePath);
        })
    };
}
export function readPluginSettings(cwd) {
    const userPath = path.join(cwd, "plugins/shiloh-plugin/config/message.yaml");
    const defaultPath = path.join(cwd, "plugins/shiloh-plugin/config_default/message.yaml");
    const configPath = fs.existsSync(userPath) ? userPath : defaultPath;
    if (!fs.existsSync(configPath))
        return {};
    try {
        return record(YAML.parse(fs.readFileSync(configPath, "utf8")).pluginSettings);
    }
    catch {
        return {};
    }
}
export function resolveDataDir(cwd, baseDir) {
    return path.isAbsolute(baseDir) ? baseDir : path.join(cwd, "plugins/shiloh-plugin", baseDir);
}
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const safeNumber = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const safeText = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
export function decodeMiniGamesSettings(settings) {
    const raw = record(record(settings).miniGames);
    return { enabled: raw.enabled !== false, turtleSoup: record(raw.turtleSoup) };
}
//# sourceMappingURL=gameFiles.js.map