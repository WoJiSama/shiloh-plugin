import { MessageManager } from '../utils/MessageManager.js'
import { messageArchiveManager } from '../utils/MessageArchiveManager.js'
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { buildBilibiliArchiveRelaySegments, cleanupBilibiliArchiveRelayFiles } from '../utils/bilibiliMediaRelay.js';
import { getInstalledMessagePipeline } from '../utils/messagePipeline/runtime.js';
import { BilibiliAuthManager } from '../utils/BilibiliAuthManager.js';
import { enrichBilibiliShare, extractBilibiliBvid, extractBilibiliEpisodeId } from '../utils/bilibiliMessage.js';
import { downloadOfficialMusicShare, extractNeteaseMusicShare, resolveNeteaseTextShare, scheduleMusicShareCleanup } from '../utils/musicShareRelay.js';
import { sendCompleteLocalFile } from '../utils/messagePipeline/deliveryGateway.js';
import { buildVisibleFailureDetail } from '../utils/visibleFailure.js';

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

function getArchiveForwardSnapshots(record = {}) {
    const context = Array.isArray(record.message)
        ? record.message.find(segment => segment?.type === 'forward_context')
        : null;
    return Array.isArray(context?.forward_nodes) ? context.forward_nodes : [];
}

function getForwardSegmentId(segment = {}) {
    return String(segment?.id || segment?.data?.id || segment?.resid || segment?.data?.resid || '').trim();
}

async function canReplayArchivedForward(group, id, cache) {
    if (!group?.getForwardMsg || !id) return true;
    if (cache.has(id)) return cache.get(id);
    const available = await group.getForwardMsg(id)
        .then(nodes => Array.isArray(nodes) ? nodes.length > 0 : Boolean(nodes))
        .catch(() => false);
    cache.set(id, available);
    return available;
}

async function buildArchiveForwardReplayNodes(record = {}, group = null) {
    const availability = new Map();
    const expand = async sourceNodes => {
        const output = [];
        for (const node of Array.isArray(sourceNodes) ? sourceNodes : []) {
            let message = Array.isArray(node?.message) ? [...node.message] : [];
            const expiredChildren = [];
            for (const nested of Array.isArray(node?.nested_forwards) ? node.nested_forwards : []) {
                const id = String(nested?.id || '').trim();
                if (!id) continue;
                if (await canReplayArchivedForward(group, id, availability)) {
                    if (!message.some(segment => getForwardSegmentId(segment) === id)) message.push({ type: 'forward', id });
                    continue;
                }
                message = message.filter(segment => getForwardSegmentId(segment) !== id);
                expiredChildren.push(...await expand(nested.nodes));
            }
            output.push({
                user_id: node?.user_id || record.user_id || record.sender?.user_id || Bot.uin,
                nickname: node?.nickname || '未知',
                time: node?.time || undefined,
                message: message.length ? message : ['[空消息]']
            }, ...expiredChildren);
        }
        return output;
    };
    const nodes = [];
    for (const root of getArchiveForwardSnapshots(record)) nodes.push(...await expand(root?.nodes));
    return nodes;
}

function formatArchiveForwardHeader(record = {}) {
    const time = String(record.time || '').replace(/^\d{4}-\d{2}-\d{2}\s+/, '');
    const name = record.sender?.card || record.sender?.nickname || String(record.user_id || '未知');
    return `${time || '未知时间'} ${name}：转发的合并聊天记录`;
}

function formatMusicFileSize(size = 0) {
    const bytes = Math.max(0, Number(size) || 0);
    return bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
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

function readMessageCacheOptions() {
    const root = process.cwd();
    const defaultPath = path.join(root, 'plugins/bl-chat-plugin/config_default/message.yaml');
    const userPath = path.join(root, 'plugins/bl-chat-plugin/config/message.yaml');
    const readSettings = file => {
        try {
            return fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, 'utf8'))?.pluginSettings || {}) : {};
        } catch (error) {
            logger.warn(`[MessageRecord] 读取近期消息 TTL 配置失败：${error.message}`);
            return {};
        }
    };
    const defaults = readSettings(defaultPath);
    const user = readSettings(userPath);
    return {
        cacheExpireMinutes: user.groupChatMemoryMinutes ?? defaults.groupChatMemoryMinutes ?? 60,
        cacheExpireDays: user.groupChatMemoryDays ?? defaults.groupChatMemoryDays
    };
}

export class MessageRecordPlugin extends plugin {
    constructor() {
        super({
            name: '消息记录',
            dsc: '记录群聊和私聊消息',
            event: 'message',
            priority: 500,
            task: {
                name: 'messageRecord',
                fnc: () => { },
                cron: ''
            },
            rule: [
                {
                    reg: '^#查看(群聊|私聊)记录\\s*(\\d+)?',
                    fnc: 'showHistory',
                    permission: 'master'
                },
                {
                    reg: '^#清除(群聊|私聊)记录',
                    fnc: 'clearHistory'
                },
                {
                    reg: '^#?(查|搜索)(聊天|群聊)记录[\\s\\S]*',
                    fnc: 'searchArchive'
                },
                {
                    reg: '^[.。]群聊天记录\\s+管理员(添加|删除)[\\s\\S]*',
                    fnc: 'manageArchiveAdmin'
                },
                {
                    reg: '^#?聊天记录管理员(添加|删除)[\\s\\S]*',
                    fnc: 'manageArchiveAdmin'
                },
                {
                    reg: '^[.。]群聊天记录[\\s\\S]*',
                    fnc: 'searchArchive'
                },
                {
                    reg: '^[.。#]消息管道状态(?:\\s+\\d{5,12})?\\s*$',
                    fnc: 'showMessagePipelineStatus',
                    permission: 'master'
                },
                { reg: '^[.。]B站授权(登录|状态|退出)\\s*$', fnc: 'bilibiliAuth', permission: 'master' },
                { reg: '^[.。]高清搬运白名单(?:\\s+(添加|删除|查看))?\\s*.*$', fnc: 'manageBilibiliQualityWhitelist', permission: 'master' },
                { reg: '^[.。]高清搬运(?:\\s+[\\s\\S]+)?$', fnc: 'relayBilibiliHighQuality' },
                { reg: '^[.。]音乐提取\\s*$', fnc: 'relayQuotedMusic', permission: 'master' },
                { reg: '^[\\s\\S]*$', fnc: 'relayGroupMusicShare' },
                {
                    reg: '^#全局方案(添加|删除)(白名单群组|Gemini密钥|触发前缀|过滤消息|Gemini工具列表|OpenAI工具列表|OneAPI工具列表|OneAPI密钥|GrokSSO|WorkosCursorToken|Gemini代理列表).*$',
                    fnc: 'modifyArrayConfig',
                    permission: 'master'
                },
            ]
        });
        this.configPath = './plugins/bl-chat-plugin/config/message.yaml';
        // 此插件与主聊天链路写入同一 Redis key，必须使用同一短期 TTL。
        this.messageManager = new MessageManager(readMessageCacheOptions());
        this.archiveManager = messageArchiveManager;
        this.bilibiliAuthManager = new BilibiliAuthManager();
        this.relayedMusicMessageIds = new Set();
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

    async relayQuotedMusic(e) {
        const replyId = e.reply_id || e.source?.message_id || e.source?.seq;
        if (!replyId) {
            await e.reply('请引用一条网易云音乐卡片后发送 .音乐提取');
            return true;
        }

        const bot = e.bot || Bot;
        let source;
        try {
            const response = await bot.sendApi('get_msg', { message_id: replyId });
            source = response?.data || response;
        } catch (error) {
            logger.warn(`[音乐提取] 读取引用消息失败: ${error.message}`);
            await e.reply(`没有读取到被引用的音乐卡片：${buildVisibleFailureDetail(error)}`);
            return true;
        }

        const share = extractNeteaseMusicShare(source) || await resolveNeteaseTextShare(source?.raw_message || source?.msg || '');
        if (!share) {
            await e.reply('引用消息不是可提取的网易云音乐卡片。');
            return true;
        }

        await this.sendMusicShare(e, share, { notifyFailure: true });
        return true;
    }

    async relayGroupMusicShare(e) {
        if (!e.group_id || String(e.user_id || '') === String(e.self_id || '')) return false;
        const messageId = String(e.message_id || '');
        if (messageId && this.relayedMusicMessageIds.has(messageId)) return false;
        const source = {
            message: e.message,
            raw_message: e.raw_message,
            msg: e.msg
        };
        const share = extractNeteaseMusicShare(source) || await resolveNeteaseTextShare([e.msg, e.raw_message].filter(Boolean).join('\n'));
        if (!share) return false;
        if (messageId) {
            this.relayedMusicMessageIds.add(messageId);
            setTimeout(() => this.relayedMusicMessageIds.delete(messageId), 10 * 60 * 1000).unref?.();
        }
        await this.sendMusicShare(e, share, { notifyFailure: false });
        return true;
    }

    async sendMusicShare(e, share, { notifyFailure = true } = {}) {
        let audio;
        try {
            audio = await downloadOfficialMusicShare(share);
        } catch (error) {
            logger.warn(`[音乐提取] ${share.title} 下载或发送失败: ${error.message}`);
            if (notifyFailure) {
                await e.reply(`音乐提取失败：${buildVisibleFailureDetail(error)}`);
            }
            return;
        }

        const record = globalThis.segment?.record
            ? globalThis.segment.record(audio.filePath)
            : { type: 'record', data: { file: audio.filePath } };
        try {
            await sendCompleteLocalFile(e, audio.filePath, {
                fileName: audio.fileName,
                maxBytes: 20 * 1024 * 1024,
                logger
            });
        } catch (error) {
            logger.warn(`[音乐提取] ${share.title} 可下载文件发送失败: ${error.message}`);
            try {
                await e.reply(record);
            } catch (recordError) {
                logger.warn(`[音乐提取] ${share.title} 试听音频发送失败: ${recordError.message}`);
            }
            try {
                await e.reply(`音乐已经提取出来了，但可下载文件发送失败：${buildVisibleFailureDetail(error)}`);
            } finally {
                scheduleMusicShareCleanup(audio.filePath);
            }
            return;
        }

        const sender = {
            user_id: e.self_id || globalThis.Bot?.uin || e.user_id,
            nickname: '希洛'
        };
        const intro = [
            '网易云音乐',
            `${share.title} - ${share.artist}`,
            `可下载文件：${audio.fileName}`,
            `文件大小：${formatMusicFileSize(audio.size)}`
        ].join('\n');
        try {
            if (e.group?.makeForwardMsg) {
                const forward = await e.group.makeForwardMsg([
                    { ...sender, message: intro }
                ]);
                await e.reply(forward);
            } else {
                await e.reply(intro);
            }
        } catch (error) {
            logger.warn(`[音乐提取] ${share.title} 信息合并转发失败: ${error.message}`);
            try {
                await e.reply(intro);
            } catch (fallbackError) {
                logger.warn(`[音乐提取] ${share.title} 信息文本发送失败: ${fallbackError.message}`);
            }
        }
        try {
            await e.reply(record);
        } catch (error) {
            logger.warn(`[音乐提取] ${share.title} 试听音频发送失败，完整文件已上传: ${error.message}`);
        } finally {
            scheduleMusicShareCleanup(audio.filePath);
        }
    }

    parseArchiveSearch(msg = "", e = {}) {
        const text = String(msg || "")
            .replace(/^[.。]群聊天记录\s*/, "")
            .replace(/^#?(查|搜索)(聊天|群聊)记录\s*/, "")
            .trim();
        const opts = {
            type: "group",
            groupId: e.group_id ? String(e.group_id) : "",
            limit: 30,
            around: 0
        };
        const pairs = [
            [/群(?:号)?[=:：]\s*(\d+)/, "groupId"],
            [/(?:qq|QQ|用户|用户QQ)[=:：]\s*(\d+)/, "qq"],
            [/(?:关键词|关键字|key|kw|keyword)[=:：]\s*("[^"]+"|'[^']+'|\S+)/, "keyword"],
            [/(?:正则|regex)[=:：]\s*("[^"]+"|'[^']+'|\S+)/, "regex"],
            [/(?:上下文|周围|context|around)[=:：]?\s*(\d+)/, "contextAround"],
            [/(?:前后|最近)[=:：]?\s*(\d+)/, "around"],
            [/(?:数量|条数|limit)[=:：]?\s*(\d+)/, "limit"],
            [/(?:消息|message_id|mid)[=:：]\s*(\d+)/, "messageId"]
        ];
        for (const [pattern, key] of pairs) {
            const match = text.match(pattern);
            if (match) opts[key] = String(match[1]).replace(/^["']|["']$/g, "");
        }
        const positionalGroup = text.match(/(?:^|\s)(\d{6,12})(?:\s|$)/);
        if (positionalGroup && !/qq|用户|消息|mid/i.test(text.slice(Math.max(0, positionalGroup.index - 8), positionalGroup.index))) {
            opts.groupId = positionalGroup[1];
        }
        if (!opts.keyword) {
            const keywordMatch = text.match(/(?:关键词|关键字)\s+(.+?)(?:\s+(?:前后|数量|条数|群|qq|QQ)[=:：]|\s*$)/);
            if (keywordMatch) opts.keyword = keywordMatch[1].trim();
        }
        opts.contextAround = Math.min(50, Math.max(0, Number(opts.contextAround) || 0));
        opts.around = Math.min(50, Math.max(0, Number(opts.around) || 0));
        if (opts.qq && opts.around && !opts.contextAround) {
            opts.limit = opts.limit === 30 ? opts.around : opts.limit;
            opts.around = 0;
        }
        if (opts.contextAround) opts.around = opts.contextAround;
        opts.limit = Math.min(100, Math.max(1, Number(opts.limit) || 30));
        if (!opts.qq && !opts.keyword && !opts.regex && !opts.messageId) {
            opts.limit = Math.min(opts.limit, 20);
        }
        return opts;
    }

    buildArchiveHelp(e = {}) {
        const groupHint = e.group_id ? `群=${e.group_id}` : "群=953676639";
        return [
            "用法：.群聊天记录 " + groupHint + " [QQ=123456] [key=关键词] [前后=10] [数量=30]",
            "字段：群=群号，QQ=用户QQ，key/关键词=搜索词，前后=最近条数，上下文=带出前后聊天，数量=最多返回条数",
            "管理：.群聊天记录 管理员添加 QQ号 / .群聊天记录 管理员删除 QQ号"
        ].join("\n");
    }

    async showMessagePipelineStatus(e) {
        const runtime = getInstalledMessagePipeline();
        if (!runtime?.store) {
            await e.reply(runtime?.unavailableReason
                ? `消息管道当前不可用：${runtime.unavailableReason}`
                : '消息管道尚未初始化或已关闭');
            return true;
        }
        const groupId = String(e.msg || '').match(/\b\d{5,12}\b/)?.[0] || '';
        try {
            const [allEvents, allDeliveries] = await Promise.all([
                runtime.store.list('event'),
                runtime.store.list('delivery')
            ]);
            const events = groupId
                ? allEvents.filter(job => String(job?.envelope?.groupId || '') === groupId)
                : allEvents;
            const deliveries = groupId
                ? allDeliveries.filter(job => String(job?.groupId || '') === groupId)
                : allDeliveries;
            const summarize = jobs => {
                const counts = new Map();
                for (const job of jobs) {
                    const state = String(job?.state || 'unknown');
                    counts.set(state, (counts.get(state) || 0) + 1);
                }
                return [...counts.entries()].sort().map(([state, count]) => `${state}=${count}`).join('，') || '无';
            };
            const recentProblems = [...events, ...deliveries]
                .filter(job => job?.lastError || job?.uncertain)
                .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
                .slice(0, 5);
            const lines = [
                `消息管道：${runtime.config?.enabled !== false && !runtime.pipeline?.stopped ? '运行中' : '已停止'}${groupId ? `（群 ${groupId}）` : ''}`,
                `事件：${summarize(events)}`,
                `媒体投递：${summarize(deliveries)}`
            ];
            if (recentProblems.length) {
                lines.push('最近异常：');
                for (const job of recentProblems) {
                    lines.push(`[${job.state}] group=${job.groupId || job.envelope?.groupId || 'private'} id=${job.id}${job.uncertain ? '（结果不确定，未自动重试）' : ''}\n${String(job.lastError || '发送结果不确定').slice(0, 180)}`);
                }
            }
            await e.reply(lines.join('\n'));
        } catch (error) {
            logger.error(`[MessagePipeline] 状态查询失败: ${error.stack || error.message}`);
            await e.reply(`消息管道状态查询失败：${buildVisibleFailureDetail(error)}`);
        }
        return true;
    }

    getBilibiliSegment(record = {}) {
        return Array.isArray(record.message)
            ? record.message.find(item => item?.type === 'bilibili') || null
            : null;
    }

    async buildArchiveForwardMessages(records = [], group = null) {
        const messages = [];
        const tempFiles = [];
        for (const record of records) {
            const forwardNodes = await buildArchiveForwardReplayNodes(record, group);
            if (forwardNodes.length) {
                messages.push({
                    user_id: record.user_id || record.sender?.user_id || Bot.uin,
                    nickname: record.sender?.card || record.sender?.nickname || String(record.user_id || "未知"),
                    message: [formatArchiveForwardHeader(record)]
                }, ...forwardNodes);
                continue;
            }
            const message = [this.archiveManager.formatRecord(record, { compact: true })];
            const bilibili = this.getBilibiliSegment(record);
            if (bilibili) {
                const relay = await buildBilibiliArchiveRelaySegments(bilibili, { logger });
                message.push(...relay.segments);
                tempFiles.push(...relay.tempFiles);
            }
            messages.push({
                user_id: record.user_id || record.sender?.user_id || Bot.uin,
                nickname: record.sender?.card || record.sender?.nickname || String(record.user_id || "未知"),
                message
            });
        }
        return { messages, tempFiles };
    }

    async searchArchive(e) {
        if (/^[.。]群聊天记录\s*$/i.test(String(e.msg || ""))) {
            await e.reply(this.buildArchiveHelp(e));
            return true;
        }
        const opts = this.parseArchiveSearch(e.msg, e);
        if (!opts.groupId) {
            await e.reply(this.buildArchiveHelp(e));
            return true;
        }
        if (!this.archiveManager.canQuery(e, opts.groupId)) {
            await e.reply("只有主人、该群群主或被授权的聊天记录管理员可以查询这个群的记录");
            return true;
        }
        try {
            const records = await this.archiveManager.query(opts);
            if (!records.length) {
                await e.reply("没有查到匹配的聊天记录");
                return true;
            }
            const title = [
                `聊天记录查询：群 ${opts.groupId}`,
                opts.qq ? `QQ=${opts.qq}` : "",
                opts.keyword ? `关键词=${opts.keyword}` : "",
                opts.regex ? `正则=${opts.regex}` : "",
                opts.contextAround ? `上下文=${opts.contextAround}` : "",
                `共 ${records.length} 条`
            ].filter(Boolean).join(" | ");
            logger.info(`[MessageArchive] ${title}`);
            const { messages: forwardMsgs, tempFiles } = await this.buildArchiveForwardMessages(records, e.group);
            try {
                const summary = e.group?.makeForwardMsg
                    ? await e.group.makeForwardMsg(forwardMsgs)
                    : forwardMsgs.map(item => Array.isArray(item.message) ? item.message.filter(part => typeof part === 'string').join('') : item.message).join("\n\n");
                await e.reply(summary);
            } finally {
                await cleanupBilibiliArchiveRelayFiles(tempFiles);
            }
        } catch (error) {
            logger.error(`[MessageArchive] 查询失败: ${error.stack || error.message}`);
            await e.reply(`查询失败：${buildVisibleFailureDetail(error)}`);
        }
        return true;
    }

    async manageArchiveAdmin(e) {
        const action = e.msg.includes("删除") ? "delete" : "add";
        const ids = [...String(e.msg || "").matchAll(/\b\d{5,12}\b/g)].map(match => match[0]);
        const groupId = e.group_id ? String(e.group_id) : ids.shift();
        const admins = ids.filter(id => id !== groupId);
        if (!groupId || !admins.length) {
            await e.reply("格式：#聊天记录管理员添加 QQ号（需在群内由群主/主人操作）");
            return true;
        }
        if (!this.archiveManager.canManageGroupAdmins(e, groupId)) {
            await e.reply("只有主人或该群群主可以配置本群聊天记录管理员");
            return true;
        }
        const config = await this.readConfig();
        if (!config) {
            await e.reply(`读取配置失败：${buildVisibleFailureDetail(this.lastConfigError)}`);
            return true;
        }
        const archive = config.pluginSettings.messageArchive ||= {};
        const list = Array.isArray(archive.groupAdmins) ? archive.groupAdmins : [];
        let item = list.find(entry => String(entry.groupId) === String(groupId));
        if (!item) {
            item = { groupId: String(groupId), admins: [] };
            list.push(item);
        }
        item.admins = Array.isArray(item.admins) ? item.admins.map(String) : [];
        if (action === "add") {
            for (const admin of admins) {
                if (!item.admins.includes(String(admin))) item.admins.push(String(admin));
            }
        } else {
            item.admins = item.admins.filter(admin => !admins.includes(String(admin)));
        }
        archive.groupAdmins = list.filter(entry => Array.isArray(entry.admins) && entry.admins.length);
        if (await this.saveConfig(config)) {
            await e.reply(`已${action === "add" ? "添加" : "删除"}本群聊天记录管理员：${admins.join("、")}`);
        } else {
            await e.reply(`保存配置失败：${buildVisibleFailureDetail(this.lastConfigError)}`);
        }
        return true;
    }

    async showHistory(e) {
        const type = e.msg.includes('群聊') ? 'group' : 'private';
        const match = e.msg.match(/(\d+)/);
        let id;

        if (match) {
            id = parseInt(match[1]);
        } else {
            id = type === 'group' ? e.group_id : e.user_id;
        }

        // 权限检查
        if (type === 'group' && !e.group) {
            e.reply('请在群聊中使用群聊记录查询功能');
            return;
        }

        try {
            const messages = await this.messageManager.getMessages(type, id, 20);

            if (!messages || messages.length === 0) {
                await e.reply('暂无消息记录');
                return;
            }

            const forwardMsgs = messages.map(msg => {
                let message;
                if (msg.content.includes('发送了一张图片')) {
                    const match = msg.content.match(/\[(https?:\/\/[^\]]+)\]/);
                    if (match) {
                        message = [
                            segment.image(match[1]),
                            '\n',
                            msg.time
                        ];
                    }
                } else {
                    message = [
                        msg.content,
                        '\n',
                        msg.time
                    ];
                }

                return {
                    user_id: msg.sender.user_id,
                    nickname: msg.sender.nickname,
                    message
                };
            });

            const Summary = type === 'group'
                ? await e.group.makeForwardMsg(forwardMsgs)
                : await e.friend.makeForwardMsg(forwardMsgs);

            await e.reply(Summary);

        } catch (error) {
            logger.error(`获取消息记录失败: ${error}`);
            await e.reply(`获取消息记录失败：${buildVisibleFailureDetail(error)}`);
        }
    }


    /**
     * 清除消息历史记录
     * @param {Object} e 事件对象
     */
    async clearHistory(e) {
        const type = e.msg.includes('群聊') ? 'group' : 'private';

        // if (!e.isMaster) {
        //     e.reply('只有主人才能清除消息记录哦~');
        //     return;
        // }

        const id = type === 'group' ? e.group_id : e.user_id;

        try {
            await this.messageManager.clearMessages(type, id);
            e.reply(`已清除${type === 'group' ? '群聊' : '私聊'}消息记录`);
        } catch (error) {
            logger.error(`清除消息记录失败: ${error}`);
            e.reply(`清除消息记录失败：${buildVisibleFailureDetail(error)}`);
        }
    }

    async modifyArrayConfig(e) {
        if (!e.isMaster) return false

        const msg = e.msg
        const isAdd = msg.includes('添加')
        const matches = msg.match(/^#全局方案(添加|删除)([\u4e00-\u9fa5a-zA-Z]+)\s*(.+)/)

        if (!matches) {
            e.reply('命令格式错误')
            return false
        }

        const [, action, type, valueStr] = matches
        const configKey = 'allowedGroups'

        const values = valueStr.split(/[,，]\s*/).filter(v => v.trim())

        if (values.length === 0) {
            e.reply('请提供要操作的值')
            return false
        }

        const config = await this.readConfig()
        if (!config) {
            e.reply(`读取配置失败：${buildVisibleFailureDetail(this.lastConfigError)}`)
            return false
        }

        try {
            if (!Array.isArray(config.pluginSettings[configKey])) {
                config.pluginSettings[configKey] = []
            }

            if (isAdd) {
                values.forEach(value => {
                    if (!config.pluginSettings[configKey].includes(value)) {
                        config.pluginSettings[configKey].push(value)
                    }
                })
            } else {
                config.pluginSettings[configKey] = config.pluginSettings[configKey].filter(
                    item => !values.includes(item)
                )
            }

            if (await this.saveConfig(config)) {
                e.reply(`批量${isAdd ? '添加' : '删除'}成功`)
            } else {
                e.reply(`保存配置失败：${buildVisibleFailureDetail(this.lastConfigError)}`)
            }
        } catch (error) {
            logger.error(`修改数组配置失败: ${error}`)
            e.reply(`操作失败：${buildVisibleFailureDetail(error)}`)
        }
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
