// B站高清搬运域（P3 从 apps/MessageManager.js 拆出）
import fs from "fs"
import YAML from "yaml"
import { buildBilibiliArchiveRelaySegments, cleanupBilibiliArchiveRelayFiles } from "../../../utils/bilibiliMediaRelay.js"
import { BilibiliAuthManager } from "../../../utils/BilibiliAuthManager.js"
import { enrichBilibiliShare, extractBilibiliBvid, extractBilibiliEpisodeId } from "../../../utils/bilibiliMessage.js"
import { buildVisibleFailureDetail } from "../../../utils/visibleFailure.js"

const BILIBILI_QUALITY_PRESETS = new Map([
    ['240P', 6], ['360P', 16], ['480P', 32], ['720P', 64], ['1080P', 80], ['1080P+', 112], ['4K', 120]
]);

function formatBilibiliQuality(quality, qualityOptions = []) {
    const number = Number(quality) || 0;
    return qualityOptions.find(item => Number(item?.quality) === number)?.label
        || [...BILIBILI_QUALITY_PRESETS.entries()].find(([, value]) => value === number)?.[0]
        || (number ? `qn=${number}` : '未知清晰度');
}

function parseBilibiliQuality(value = '') {
    const normalized = String(value || '').trim().toUpperCase();
    if (BILIBILI_QUALITY_PRESETS.has(normalized)) return BILIBILI_QUALITY_PRESETS.get(normalized);
    const quality = Number(normalized.replace(/^QN\s*=?\s*/i, ''));
    return Number.isInteger(quality) && quality > 0 && quality <= 127 ? quality : 0;
}

function parseBilibiliQualityRelayRequest(message = '') {
    const content = String(message || '').replace(/^[.。]高清搬运\s*/, '').trim();
    const match = content.match(/^(\S+)\s+(https?:\/\/\S+)$/i);
    if (!match) return null;
    const quality = parseBilibiliQuality(match[1]);
    if (!quality) return null;
    try {
        const url = new URL(match[2]);
        const host = url.hostname.toLowerCase();
        if (host !== 'b23.tv' && host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) return null;
        return { quality, url: url.toString() };
    } catch {
        return null;
    }
}

function extractMentionedUserIds(e = {}, message = '') {
    const ids = new Set();
    const append = value => {
        if (Array.isArray(value)) value.forEach(append);
        else if (/^\d{5,12}$/.test(String(value || ''))) ids.add(String(value));
    };
    append(e.at);
    for (const segment of Array.isArray(e.message) ? e.message : []) {
        if (segment?.type === 'at') append(segment?.qq ?? segment?.data?.qq);
    }
    for (const match of String(message || '').matchAll(/\b\d{5,12}\b/g)) append(match[0]);
    return [...ids].filter(id => id !== String(e.group_id || ''));
}

export class BilibiliRelayPlugin extends plugin {
  constructor() {
    super({
      name: "bl-chat-plugin B站高清搬运",
      dsc: ".B站授权 / .高清搬运白名单 / .高清搬运",
      event: "message",
      priority: 2000,
      rule: [
        { reg: "^[.。]B站授权(登录|状态|退出)\s*$", fnc: "bilibiliAuth", permission: "master" },
        { reg: "^[.。]高清搬运白名单(?:\s+(添加|删除|查看))?\s*.*$", fnc: "manageBilibiliQualityWhitelist", permission: "master" },
        { reg: "^[.。]高清搬运(?:\s+[\s\S]+)?$", fnc: "relayBilibiliHighQuality" }
      ]
    });
    this.configPath = './plugins/bl-chat-plugin/config/message.yaml';
    this.bilibiliAuthManager = new BilibiliAuthManager();
  }

    async bilibiliAuth(e) {
        const action = String(e.msg || '').match(/B站授权(登录|状态|退出)/)?.[1];
        if (action === '状态') {
            const status = this.bilibiliAuthManager.status();
            await e.reply(status.authorized ? 'B站高质量搬运账号已授权' : 'B站高质量搬运账号尚未授权');
            return true;
        }
        if (action === '退出') {
            this.bilibiliAuthManager.logout();
            await e.reply('已清除B站高质量搬运账号授权');
            return true;
        }
        try {
            const session = await this.bilibiliAuthManager.start();
            const bot = e.bot || Bot;
            await bot.sendApi('send_private_msg', { user_id: Number(e.user_id), message: [{ type: 'image', data: { file: session.image } }] });
            await e.reply(e.group_id ? 'B站登录二维码已私发给你，请在3分钟内扫码确认。' : '请在3分钟内扫码确认。');
            const timer = setInterval(async () => {
                try {
                    const result = await this.bilibiliAuthManager.poll();
                    if (result.state === 'waiting') return;
                    clearInterval(timer);
                    await bot.sendApi('send_private_msg', { user_id: Number(e.user_id), message: result.state === 'success' ? 'B站授权成功，可用于高质量搬运。' : 'B站二维码已失效，请重新发送 .B站授权登录' });
                } catch (error) { clearInterval(timer); logger.warn(`[B站授权] 轮询失败: ${error.message}`); }
            }, 3000);
            timer.unref?.();
        } catch (error) { await e.reply(`B站授权登录未启动：${buildVisibleFailureDetail(error)}`); }
        return true;
    }

    async manageBilibiliQualityWhitelist(e) {
        if (!e.isMaster) return false;
        const groupId = String(e.group_id || '');
        if (!groupId) {
            await e.reply('请在需要配置的群内管理高清搬运白名单');
            return true;
        }
        const action = String(e.msg || '').match(/高清搬运白名单\s*(添加|删除|查看)?/)?.[1] || '查看';
        const config = await this.readConfig();
        if (!config) {
            await e.reply(`读取高清搬运白名单配置失败：${buildVisibleFailureDetail(this.lastConfigError)}`);
            return true;
        }
        const settings = config.pluginSettings ||= {};
        const qualityRelay = settings.bilibiliQualityRelay ||= {};
        const whitelist = qualityRelay.highQualityWhitelist ||= {};
        const current = Array.isArray(whitelist[groupId]) ? whitelist[groupId].map(String) : [];
        if (action === '查看') {
            await e.reply(current.length
                ? `本群高清搬运白名单：${current.join('、')}\n主人始终可用。`
                : '本群高清搬运白名单为空；主人始终可用。');
            return true;
        }
        const users = extractMentionedUserIds(e, e.msg);
        if (!users.length) {
            await e.reply(`格式：.高清搬运白名单 ${action} @某人`);
            return true;
        }
        const next = action === '添加'
            ? [...new Set([...current, ...users])]
            : current.filter(userId => !users.includes(userId));
        if (next.length) whitelist[groupId] = next;
        else delete whitelist[groupId];
        if (!await this.saveConfig(config)) {
            await e.reply(`保存高清搬运白名单配置失败：${buildVisibleFailureDetail(this.lastConfigError)}`);
            return true;
        }
        await e.reply(`已${action}本群高清搬运白名单：${users.join('、')}`);
        return true;
    }

    async relayBilibiliHighQuality(e) {
        const request = parseBilibiliQualityRelayRequest(e.msg);
        if (!request) {
            await e.reply('格式：.高清搬运 720P B站链接\n可选：240P、360P、480P、720P、1080P、1080P+、4K，或 qn 数值。');
            return true;
        }
        const config = await this.readConfig();
        const qualityRelay = config?.pluginSettings?.bilibiliQualityRelay || {};
        if (qualityRelay.enabled === false || !this.bilibiliAuthManager.canUseHighQuality({
            isMaster: Boolean(e.isMaster),
            groupId: e.group_id,
            userId: e.user_id,
            whitelist: qualityRelay.highQualityWhitelist || {}
        })) {
            await e.reply('你没有本群 B站高清搬运权限。');
            return true;
        }
        if (!this.bilibiliAuthManager.status().authorized) {
            await e.reply('B站高质量搬运账号尚未授权；主人可发送 .B站授权登录 完成服务器扫码。');
            return true;
        }

        const initialCard = {
            type: 'bilibili',
            platform: 'bilibili',
            short_url: request.url,
            page_url: request.url,
            video_url: request.url,
            bvid: extractBilibiliBvid(request.url),
            ep_id: extractBilibiliEpisodeId(request.url),
            title: 'B站视频'
        };
        let card;
        try {
            card = await enrichBilibiliShare(initialCard, { timeoutMs: 10_000 });
        } catch (error) {
            logger.warn(`[B站高清搬运] 视频信息解析失败: ${error.message}`);
            await e.reply(`B站高清搬运没有拿到视频信息：${buildVisibleFailureDetail(error)}`);
            return true;
        }
        if (!card?.bvid && !card?.ep_id) {
            await e.reply('没有解析到可搬运的 B站视频或番剧集，请使用 b23.tv、BV 视频页或 ep 集链接。');
            return true;
        }
        if (Number(card.duration || 0) > 30 * 60) {
            await e.reply('该视频超过30分钟，高清搬运不会附带视频本体；已保留视频页面。');
            return true;
        }

        let relay;
        try {
            relay = await buildBilibiliArchiveRelaySegments(card, {
                logger,
                quality: request.quality,
                authCookie: this.bilibiliAuthManager.cookie(),
                segmentApi: globalThis.segment
            });
            const hasVideo = relay.segments.some(item => item?.type === 'video');
            if (!hasVideo) {
                await e.reply(`B站高清搬运未完成：${buildVisibleFailureDetail(relay.failureReason, { fallback: '没有拿到可下载的视频本体' })}。`);
                return true;
            }
            const requested = formatBilibiliQuality(request.quality, relay.qualityOptions);
            const actual = formatBilibiliQuality(relay.actualQuality || request.quality, relay.qualityOptions);
            const note = requested === actual ? `B站高清搬运：${actual}` : `B站高清搬运：请求 ${requested}，实际获得 ${actual}`;
            const message = [note, ...relay.segments];
            if (e.group?.makeForwardMsg) {
                const forward = await e.group.makeForwardMsg([{
                    user_id: e.self_id || globalThis.Bot?.uin || e.user_id,
                    nickname: '希洛',
                    message
                }]);
                await e.reply(forward);
            } else {
                await e.reply(message);
            }
        } catch (error) {
            logger.warn(`[B站高清搬运] 请求失败: ${error.message}`);
            await e.reply(`B站高清搬运本次请求失败，未发送不完整视频。原因：${buildVisibleFailureDetail(error)}`);
        } finally {
            await cleanupBilibiliArchiveRelayFiles(relay?.tempFiles || []);
        }
        return true;
    }

  async readConfig() {
    try {
      const file = fs.readFileSync(this.configPath, 'utf8')
      const config = YAML.parse(file)
      this.lastConfigError = null
      return config
    } catch (error) {
      logger.error(`读取配置文件失败: ${error}`)
      this.lastConfigError = error
      return null
    }
  }

  async saveConfig(config) {
    try {
      const yamlStr = YAML.stringify(config)
      fs.writeFileSync(this.configPath, yamlStr, 'utf8')
      this.lastConfigError = null
      return true
    } catch (error) {
      logger.error(`保存配置文件失败: ${error}`)
      this.lastConfigError = error
      return false
    }
  }
}
