import { createConfigRepository } from './configRepository.js';
import fs from "fs";
import path from "path";
import YAML from "yaml";
// 配置内核：默认值深合并、用户层落盘、文件变更热更新。
// 从 apps/test.js 的 initConfig/ensureConfigFiles/mergeConfig 迁出（P3），
// 变更回调通过 onChange 注入，内核不依赖任何插件实例。
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
export function mergeDeepConfig(defaults: Record<string, unknown>, user: unknown = {}): Record<string, unknown> {
    const supplied = record(user);
    const merged = { ...defaults, ...supplied };
    for (const key of Object.keys(defaults)) {
        const base = defaults[key], override = supplied[key];
        if (isRecord(base) && isRecord(override))
            merged[key] = mergeDeepConfig(base, override);
    }
    return merged;
}
interface StoreOptions {
    pluginRoot?: string;
    configFiles?: string[];
    mainFile?: string;
    settingsKey?: string;
    onChange?: ((settings: Record<string, unknown>) => unknown) | null;
    logger?: {
        error?(message: string): void;
        info?(message: string): void;
        mark?(message: string): void;
    };
    watchImpl?: ((file: string, callback: (filePath: string) => void) => unknown) | null;
}
export function createConfigStore({ pluginRoot, configFiles = ["message.yaml"], mainFile = "message.yaml", settingsKey = "pluginSettings", onChange = null, logger = {}, watchImpl = null }: StoreOptions = {}) {
    const root = String(pluginRoot || "");
    const configDir = path.join(root, "config");
    const configDefaultDir = path.join(root, "config_default");
    const mainConfigPath = path.join(configDir, mainFile);
    const mainDefaultPath = path.join(configDefaultDir, mainFile);
    let watcher: unknown = null;
    let watching = false;
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    function ensureFiles() {
        if (!fs.existsSync(configDefaultDir)) {
            logger?.error?.(`[配置] 默认配置目录不存在: ${configDefaultDir}`);
            return false;
        }
        if (!fs.existsSync(configDir))
            fs.mkdirSync(configDir, { recursive: true });
        for (const fileName of configFiles) {
            const configPath = path.join(configDir, fileName);
            if (!fs.existsSync(configPath) && fs.existsSync(path.join(configDefaultDir, fileName))) {
                createConfigRepository({ file: configPath, defaultFile: path.join(configDefaultDir, fileName) }).update(() => { });
                logger?.info?.(`[配置] 已从 config_default 复制配置文件: ${fileName}`);
            }
        }
        return true;
    }
    function readYaml(file: string): Record<string, unknown> {
        const parsed: unknown = YAML.parse(fs.readFileSync(file, "utf8"));
        return record(parsed);
    }
    function load() {
        ensureFiles();
        try {
            if (!fs.existsSync(mainDefaultPath)) {
                logger?.error?.(`[配置] 默认配置文件不存在: ${mainDefaultPath}`);
                return { settings: {}, merged: {} };
            }
            const repository = createConfigRepository({ file: mainConfigPath, defaultFile: mainDefaultPath, settingsKey });
            const defaults = readYaml(mainDefaultPath);
            const snapshot = repository.update(doc => {
                const addMissing = (values: Record<string, unknown>, prefix: string[] = []) => {
                    for (const [key, value] of Object.entries(values || {})) {
                        const keys = [...prefix, key];
                        if (!doc.hasIn(keys))
                            doc.setIn(keys, value);
                        else if (value && typeof value === 'object' && !Array.isArray(value) && YAML.isMap(doc.getIn(keys)))
                            addMissing(value as Record<string, unknown>, keys);
                    }
                };
                addMissing(defaults);
            });
            const parsed: unknown = snapshot.document.toJS();
            const merged = record(parsed);
            return { settings: record(merged[settingsKey]), merged };
        }
        catch (err) {
            logger?.error?.(`[配置] 加载配置文件失败: ${err}`);
            return { settings: {}, merged: {} };
        }
    }
    function startWatch() {
        if (watching || !watchImpl)
            return;
        watching = true;
        watcher = watchImpl(mainConfigPath, async () => {
            if (!watching)
                return;
            clearTimeout(reloadTimer);
            reloadTimer = setTimeout(async () => {
                if (!watching)
                    return;
                try {
                    const { settings } = load();
                    await onChange?.(settings);
                    logger?.mark?.(`[bl-chat-plugin][热更新] ${mainFile} 配置已重新加载`);
                }
                catch (err) {
                    logger?.error?.(`[bl-chat-plugin][热更新] 重新加载配置失败: ${err}`);
                }
            }, 500);
        });
    }
    function stopWatch() {
        watching = false;
        clearTimeout(reloadTimer);
        reloadTimer = undefined;
        if (watcher && typeof watcher === 'object' && 'close' in watcher && typeof watcher.close === 'function')
            watcher.close();
        watcher = null;
    }
    return { load, startWatch, stopWatch, ensureFiles, paths: { configDir, configDefaultDir, mainConfigPath, mainDefaultPath } };
}
