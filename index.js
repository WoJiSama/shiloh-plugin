import fs from "node:fs";
import path from "path";
import config from "./model/config.js";
import { installMessagePipeline } from "./utils/messagePipeline/runtime.js";
import { collectPluginExports } from "./utils/pluginExportLoader.js";
if (!global.segment) {
    global.segment = (await import("oicq")).segment
}
// 加载名称
const packageJsonPath = path.join('./plugins', 'bl-chat-plugin', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const pluginName = packageJson.name;
// 初始化输出
logger.info(logger.yellow(`（bl-chat-plugin）初始化`));

const files = fs.readdirSync(`./plugins/${pluginName}/apps`).filter(file => file.endsWith(".js"));

let ret = [];

files.forEach(file => {
    ret.push(import(`./apps/${file}`));
});

ret = await Promise.allSettled(ret);

let apps = {};
for (let i in files) {
    let name = files[i].replace(".js", "");

    if (ret[i].status !== "fulfilled") {
        logger.error(`载入插件错误：${logger.red(name)}`);
        logger.error(ret[i].reason);
        continue;
    }
    const pluginExports = collectPluginExports(ret[i].value, plugin);
    if (!pluginExports.length) {
        logger.error(`载入插件错误：${logger.red(name)} 没有找到有效的 plugin 导出`);
        continue;
    }
    for (const item of pluginExports) {
        const key = pluginExports.length === 1 ? name : `${name}:${item.exportName}`;
        apps[key] = item.PluginClass;
    }
}
let emojiCollector = null;
try {
    emojiCollector = (await import("./domains/emoji/EmojiPackManager.js")).emojiPackManager;
} catch (error) {
    logger.warn(`[MessagePipeline] 表情包自动收集模块不可用，核心消息管道继续启动：${error.message}`);
}
installMessagePipeline({
    bot: globalThis.Bot,
    redis: globalThis.redis,
    logger: globalThis.logger,
    pluginSettings: config.getConfig("message")?.pluginSettings || {},
    emojiCollector
});
export { apps };
