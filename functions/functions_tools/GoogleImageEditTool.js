import { AbstractTool } from './AbstractTool.js';
import { getBase64Image, normalizeImageUrls } from '../../utils/fileUtils.js';
import { dependencies } from "../../dependence/dependencies.js";
import fs from "fs";
import YAML from "yaml";
import path from "path";
import { serializeMultipartFormData } from "../../utils/multipartFormData.js";
import { sendImageReliably } from "../../utils/reliableImageSender.js";
import { extractImageResult } from "../../utils/imageResult.js";
import { randomUUID } from "crypto";
import {
    generateImageEditWithFallbacks,
    matchesImageProvider,
    normalizeImageProviderParameter,
    resolveRequestedImageProvider,
    resolveImageEditConfigs,
    selectImageConfigsByProvider,
    shouldRetryWithoutUrlResponseFormat,
    toImageEditUrl
} from "../../utils/imageGenerationFallback.js";
import { generateContextualProgressReply } from "../../utils/contextualProgressReply.js";
import { personaFeedbackManager } from "../../domains/memory/PersonaFeedbackManager.js";
import { reserveProgressReply } from "../../utils/progressReplyBudget.js";

const { mimeTypes, FormData } = dependencies;
const DEFAULT_CHAT_IMAGE_EDIT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_IMAGE_EDIT_URL = 'https://api.openai.com/v1/images/edits';
const IMAGE_EDIT_TIMEOUT_MS = 240000;
const IMAGE_EDIT_JOB_PREFIX = "ytbot:image_edit_job:";
const IMAGE_EDIT_JOB_TTL_SECONDS = 24 * 60 * 60;
export class GoogleImageEditTool extends AbstractTool {
    constructor({
        progressFetchImpl = globalThis.fetch,
        progressReplyFactory = generateContextualProgressReply
    } = {}) {
        super();
        this.recoveringJobIds = new Set();
        this.name = 'googleImageEditTool';
        this.description = '使用已配置的图片编辑渠道处理用户提供的图片或群友头像；仅修改用户明确要求的内容。';
        this.parameters = {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: '用户对图片的处理需求，例如"将图片转为黑白""把这张图的人物换一件衣服"'
                },
                images: {
                    type: 'array',
                    description: '用户提供的图片链接数组，需保留原始URL完整性。QQ头像格式："https://q1.qlogo.cn/g?b=qq&nk=用户QQ号&s=640"',
                    items: { type: 'string' }
                },
                provider: {
                    type: 'string',
                    description: '仅当用户明确指定图片渠道或模型名称时填写，例如 Grok；未指定时不要填写'
                },
                progressText: {
                    type: 'string',
                    description: '可选：结合当前编辑要求生成一句自然开场；不能编造已经看见的图片细节或声称已经完成'
                }
            },
            required: ['prompt', 'images'],
            additionalProperties: false
        };
        this.progressFetchImpl = progressFetchImpl;
        this.progressReplyFactory = progressReplyFactory;
    }

    async func(opts, e) {
        const config = this.loadConfig();
        const requestedProvider = this.resolveRequestedProvider(config, opts, e);
        const { provider: _untrustedProvider, ...baseOpts } = opts || {};
        const effectiveOpts = requestedProvider ? { ...baseOpts, provider: requestedProvider } : baseOpts;
        const job = this.createDurableJob(effectiveOpts, e);
        await this.persistDurableJob(job);
        try {
            return await this.performImageEdit(effectiveOpts, e);
        } finally {
            await this.removeDurableJob(job.id);
        }
    }

    async performImageEdit(opts, e, options = {}) {
        const STREAM = false;
        let progressController = null;

        try {
            const config = this.loadConfig();
            const { prompt } = opts;
            const requestedProvider = this.resolveRequestedProvider(config, opts, e);
            const rawImages = this.normalizeArray(opts.images);

            if (!rawImages.length) {
                return { error: '未检测到有效的图片链接' };
            }

            const { imageEditApiUrl, imageEditApiKey, imageEditApiModel } = config.imageEditAiConfig || {};
            const apiUrl = imageEditApiUrl || DEFAULT_CHAT_IMAGE_EDIT_URL;
            const apiKey = imageEditApiKey || 'sk-xxxxxx';
            const model = imageEditApiModel || "gemini-3-pro-image-preview";
            this.validateRequestedImageEditProvider(config, apiUrl, requestedProvider);

            if (!options.skipProgressNotice) {
                progressController = new AbortController();
                void Promise.resolve(this.sendProgress(e, {
                    config,
                    opts,
                    signal: progressController.signal
                })).catch(error => this.logWarn(`[图片编辑] 进度生成或发送异常: ${error?.message || error}`));
            }

            // 处理图片URL
            const images = await normalizeImageUrls(rawImages);

            if (!images.length) {
                return { error: '未检测到有效的图片链接' };
            }

            // 调用API
            const imageUrl = await this.generateConfiguredImageEdit(config, {
                apiUrl,
                apiKey,
                model,
                prompt,
                images,
                stream: STREAM,
                provider: requestedProvider
            });
            const processedUrl = this.extractImageUrl(imageUrl);

            if (processedUrl) {
                await sendImageReliably(e, processedUrl);
                return '图片编辑成功';
            }
            return { error: '图片编辑失败: 未接收到有效图片' };

        } catch (error) {
            console.error('图片编辑失败:', error);
            return { error: `图片编辑失败: ${error.message}` };
        } finally {
            progressController?.abort?.();
        }
    }

    createDurableJob(opts, e = {}) {
        const groupId = e.group_id || "";
        const userId = e.user_id || e.sender?.user_id || "";
        const messageId = e.message_id || randomUUID();
        return {
            id: `${groupId || "private"}:${userId || "unknown"}:${messageId}:${randomUUID().slice(0, 8)}`,
            opts: {
                prompt: String(opts?.prompt || ""),
                images: this.normalizeArray(opts?.images),
                ...(opts?.provider ? { provider: String(opts.provider) } : {})
            },
            groupId: String(groupId || ""),
            userId: String(userId || ""),
            messageId: String(messageId || ""),
            messageType: e.message_type || (groupId ? "group" : "private"),
            selfId: String(e.self_id || ""),
            sender: {
                user_id: userId ? Number(userId) : undefined,
                nickname: e.sender?.nickname || e.nickname || "",
                card: e.sender?.card || ""
            },
            createdAt: Date.now()
        };
    }

    getRedis() {
        return globalThis.redis || (typeof redis !== "undefined" ? redis : null);
    }

    async persistDurableJob(job) {
        const store = this.getRedis();
        if (!store || !job?.id) return;
        await store.set(`${IMAGE_EDIT_JOB_PREFIX}${job.id}`, JSON.stringify(job), { EX: IMAGE_EDIT_JOB_TTL_SECONDS });
    }

    async removeDurableJob(jobId) {
        const store = this.getRedis();
        if (store && jobId) await store.del(`${IMAGE_EDIT_JOB_PREFIX}${jobId}`);
    }

    async scanDurableJobKeys() {
        const store = this.getRedis();
        if (!store) return [];
        const pattern = `${IMAGE_EDIT_JOB_PREFIX}*`;
        if (typeof store.scanIterator === "function") {
            const keys = [];
            for await (const key of store.scanIterator({ MATCH: pattern, COUNT: 100 })) {
                if (Array.isArray(key)) keys.push(...key); else keys.push(key);
            }
            return keys;
        }
        return typeof store.keys === "function" ? await store.keys(pattern) : [];
    }

    buildRecoveredEvent(record = {}) {
        const bot = globalThis.Bot || (typeof Bot !== "undefined" ? Bot : null);
        const groupId = Number(record.groupId || 0) || null;
        const userId = Number(record.userId || 0) || 0;
        const event = {
            group_id: groupId,
            user_id: userId,
            sender: { ...(record.sender || {}), user_id: userId },
            message_id: record.messageId || "",
            message_type: record.messageType || (groupId ? "group" : "private"),
            self_id: record.selfId || bot?.uin || "",
            bot
        };
        event.reply = async message => {
            if (groupId) return await bot.pickGroup(groupId).sendMsg(message);
            return await bot.pickFriend(userId).sendMsg(message);
        };
        return event;
    }

    async recoverDurableJobs() {
        const keys = await this.scanDurableJobKeys();
        if (!keys.length) return;
        this.logInfo(`[图片编辑恢复] 发现 ${keys.length} 个未完成任务`);
        for (const key of keys) {
            const raw = await this.getRedis().get(key);
            if (!raw) continue;
            let record;
            try { record = JSON.parse(raw); } catch { await this.getRedis().del(key); continue; }
            if (!record?.id || this.recoveringJobIds.has(record.id)) continue;
            this.recoveringJobIds.add(record.id);
            const event = this.buildRecoveredEvent(record);
            try {
                await event.reply("刚刚我这边重启了一下，不过这张图的修改要求还记着。我继续处理，完成后直接发出来。");
                await this.performImageEdit(record.opts || {}, event, { skipProgressNotice: true });
            } catch (error) {
                this.logError(`[图片编辑恢复] 恢复任务失败 id=${record.id}:`, error);
            } finally {
                await this.removeDurableJob(record.id);
                this.recoveringJobIds.delete(record.id);
            }
        }
    }

    // ========== 工具方法 ==========

    shouldUseImageEditEndpoint(apiUrl = "") {
        const url = String(apiUrl || "").trim();
        if (!url) return true;
        if (/\/chat\/completions\/?$/i.test(url)) return false;
        return /(?:\/images\/edits\/?|\/v1\/?|\/openai\/v1\/?|\/api\/v1\/?|\/)$/.test(url);
    }

    toImageEditUrl(apiUrl = DEFAULT_IMAGE_EDIT_URL) {
        return toImageEditUrl(apiUrl);
    }

    resolveImageEditConfigs(config = {}) {
        return resolveImageEditConfigs(config);
    }

    resolveRequestedProvider(config = {}, opts = {}, e = {}) {
        const directUserText = [e?.msg, e?.raw_message].filter(Boolean).join("\n");
        const sourceText = directUserText || opts?.prompt || "";
        return resolveRequestedImageProvider(config, sourceText, opts?.provider);
    }

    normalizeParameters(params = {}, context = {}) {
        const normalized = super.normalizeParameters(params, context);
        const directUserText = [
            context?.userText,
            context?.currentIntentText,
            context?.event?.msg,
            context?.event?.raw_message
        ].filter(Boolean).join("\n");
        const sourceText = directUserText || normalized.prompt || "";
        let config = {};
        try {
            config = this.loadConfig();
        } catch {}
        return normalizeImageProviderParameter(normalized, config, sourceText);
    }

    validateRequestedImageEditProvider(config = {}, apiUrl = "", provider = "") {
        const requestedProvider = String(provider || "").trim();
        if (!requestedProvider) return;
        const requestedChatPrimary = !this.shouldUseImageEditEndpoint(apiUrl) &&
            matchesImageProvider(config.imageEditAiConfig || {}, requestedProvider);
        if (requestedChatPrimary) return;
        selectImageConfigsByProvider(this.resolveImageEditConfigs(config), requestedProvider, "图片编辑");
    }

    async generateConfiguredImageEdit(config, { apiUrl, apiKey, model, prompt, images, stream = false, provider = "" }) {
        let editConfigs = this.resolveImageEditConfigs(config);
        const requestedProvider = String(provider || "").trim();
        const primaryIsChat = !this.shouldUseImageEditEndpoint(apiUrl);
        const requestedChatPrimary = Boolean(
            requestedProvider &&
            primaryIsChat &&
            matchesImageProvider(config.imageEditAiConfig || {}, requestedProvider)
        );

        if (requestedProvider) {
            if (requestedChatPrimary) {
                this.logInfo(`[图片渠道] 用户指定 ${requestedProvider}，仅使用当前 chat 图片编辑通道`);
                return await this.generateChatImageEdit({ apiUrl, apiKey, model, prompt, images, stream });
            }
            editConfigs = selectImageConfigsByProvider(editConfigs, requestedProvider, "图片编辑");
            this.logInfo(`[图片渠道] 用户指定 ${requestedProvider}，本次禁止跨名称 fallback`);
            return await this.generateImageEdit(editConfigs, prompt, images);
        }

        if (this.shouldUseImageEditEndpoint(apiUrl)) {
            if (!editConfigs.length) throw new Error("未配置可用的图片编辑通道");
            return await this.generateImageEdit(editConfigs, prompt, images);
        }

        let primaryError = null;
        try {
            const chatResult = await this.generateChatImageEdit({ apiUrl, apiKey, model, prompt, images, stream });
            if (this.extractImageUrl(chatResult)) return chatResult;
            primaryError = new Error("未接收到有效图片");
        } catch (error) {
            primaryError = error;
        }

        if (editConfigs.length) {
            this.logWarn(`[图片编辑] 当前图片编辑通道失败，使用相同原 prompt 尝试下一个 edits 候选: ${primaryError?.message || "未接收到有效图片"}`);
            return await this.generateImageEdit(editConfigs, prompt, images);
        }
        throw primaryError || new Error("未接收到有效图片");
    }

    async generateChatImageEdit({ apiUrl, apiKey, model, prompt, images, stream = false }) {
        const content = await this.buildImageMessages(prompt, images);
        const response = await this.fetchWithTimeout(apiUrl || DEFAULT_CHAT_IMAGE_EDIT_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content }],
                stream,
            }),
        });

        return stream
            ? await this.handleStreamResponse(response)
            : await this.handleChatResponse(response);
    }

    async generateImageEdit(configs, prompt, images) {
        return await generateImageEditWithFallbacks(configs, prompt, images, {
            request: (editConfig, inputPrompt, inputImages, responseFormat) => this.requestImageEdit({
                apiUrl: editConfig.apiUrl,
                apiKey: editConfig.apiKey,
                model: editConfig.model,
                prompt: inputPrompt,
                images: inputImages
            }, responseFormat),
            parseResponse: response => this.parseImageEditResponse(response),
            logInfo: (...args) => this.logInfo(...args),
            logWarn: (...args) => this.logWarn(...args)
        });
    }

    async requestImageEdit({ apiUrl, apiKey, model, prompt, images }, responseFormat = "") {
        const formData = await this.buildImageEditFormData({ model, prompt, images, responseFormat });
        const multipart = await serializeMultipartFormData(formData);
        return await this.fetchWithTimeout(this.toImageEditUrl(apiUrl), {
            method: "POST",
            headers: {
                ...multipart.headers,
                Authorization: `Bearer ${apiKey}`,
            },
            body: multipart.body,
        });
    }

    async buildImageEditFormData({ model, prompt, images, responseFormat = "" }) {
        const formData = new FormData();
        formData.append("model", model);
        formData.append("prompt", prompt);
        if (responseFormat) formData.append("response_format", responseFormat);

        for (let index = 0; index < images.length; index++) {
            const image = await this.buildImageFile(images[index], index);
            formData.append("image", image.buffer, {
                filename: image.filename,
                contentType: image.mimeType,
                knownLength: image.buffer.length,
            });
        }

        return formData;
    }

    async buildImageFile(url, index = 0) {
        const imgData = await getBase64Image(url, `image_${index}.png`);

        if (imgData.includes("该图片链接已过期")) {
            throw new Error("该图片下载链接已过期，请重新上传");
        }
        if (imgData.includes("无效的图片下载链接")) {
            throw new Error("无效的图片下载链接，请确保适配器支持且图片未过期");
        }
        if (imgData.includes("无效的图片格式")) {
            throw new Error("无效的图片格式，请重新上传图片");
        }

        const parsed = this.parseDataImage(imgData);
        if (!parsed) throw new Error("图片转换失败，请重新上传图片");

        const ext = mimeTypes.extension(parsed.mimeType) || "png";
        return {
            buffer: parsed.buffer,
            mimeType: parsed.mimeType,
            filename: `image_${index}.${ext}`,
        };
    }

    parseDataImage(dataUrl = "") {
        const match = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) return null;
        return {
            mimeType: match[1],
            buffer: Buffer.from(match[2], "base64"),
        };
    }

    async fetchWithTimeout(url, options = {}, timeoutMs = IMAGE_EDIT_TIMEOUT_MS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, {
                ...options,
                signal: controller.signal
            });
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error(`图片编辑接口超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    shouldRetryWithoutUrlResponseFormat(errorMessage = "") {
        return shouldRetryWithoutUrlResponseFormat(errorMessage);
    }

    async readJsonResponse(response) {
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            return { raw: text };
        }
    }

    formatApiError(response, data) {
        const message = data?.error?.message || data?.detail || data?.raw || response.statusText || "未知错误";
        return `API请求失败: ${response.status} ${message}`;
    }

    async parseImageEditResponse(response) {
        const data = await this.readJsonResponse(response);
        if (!response.ok) {
            return { ok: false, errorMessage: this.formatApiError(response, data), data };
        }
        if (data?.error) {
            const message = data.error.message || "unknown provider error";
            const type = data.error.type || data.error.code || "provider_error";
            this.logWarn(`[图片编辑] 服务返回错误 status=${response.status} type=${type} message=${message}`);
            return {
                ok: false,
                errorMessage: `图片编辑服务错误: ${type}: ${message}`,
                errorKind: "provider_error",
                data
            };
        }

        const item = data?.data?.[0];
        if (item?.url) {
            this.logInfo("[图片编辑] 上游返回 url");
            return { ok: true, image: item.url, format: "url" };
        }
        if (item?.b64_json) {
            this.logInfo("[图片编辑] 上游返回 b64_json");
            return { ok: true, image: `base64://${item.b64_json}`, format: "b64_json" };
        }

        const chatImage = this.extractChatImageResult(data);
        if (chatImage) return { ok: true, image: chatImage, format: "chat" };

        this.logWarn(`[图片编辑] 空结果响应结构 ${JSON.stringify(this.summarizeResponseShape(data)).slice(0, 1800)}`);
        return { ok: false, errorMessage: "未接收到有效图片", errorKind: "empty_image", data };
    }

    summarizeResponseShape(value, depth = 0) {
        if (depth > 4) return "<max-depth>";
        if (Array.isArray(value)) return value.slice(0, 3).map(item => this.summarizeResponseShape(item, depth + 1));
        if (!value || typeof value !== "object") {
            if (typeof value === "string") return value.length > 240 ? `<string length=${value.length} prefix=${value.slice(0, 160)}>` : value;
            return value;
        }
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (/b64|base64/i.test(key)) result[key] = typeof item === "string" ? `<base64 length=${item.length}>` : "<base64-value>";
            else result[key] = this.summarizeResponseShape(item, depth + 1);
        }
        return result;
    }

    extractChatImageResult(data) {
        return data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
            data?.choices?.[0]?.message?.images?.[0]?.url ||
            data?.choices?.[0]?.message?.content ||
            "";
    }

    logInfo(...args) {
        if (typeof logger !== "undefined" && logger?.info) logger.info(...args);
        else console.info(...args);
    }

    logWarn(...args) {
        if (typeof logger !== "undefined" && logger?.warn) logger.warn(...args);
        else console.warn(...args);
    }

    logError(...args) {
        if (typeof logger !== "undefined" && logger?.error) logger.error(...args);
        else console.error(...args);
    }

    async sendProgress(e, { config = {}, opts = {}, signal } = {}) {
        if (!e?.reply || signal?.aborted) return false;
        const reservation = reserveProgressReply(e);
        if (!reservation) return false;
        try {
            const text = await this.progressReplyFactory({
                config,
                taskType: "图片编辑",
                taskMode: "image_edit",
                userText: e?.msg || e?.raw_message || opts?.prompt || "编辑这张图片",
                stage: "已经取得待编辑图片，正在按用户明确要求修改，尚未得到成图",
                suggestedText: opts?.progressText,
                agentContext: opts?.agentContext,
                fetchImpl: this.progressFetchImpl,
                signal
            });
            if (!text || signal?.aborted) {
                reservation.release();
                return false;
            }
            const guardedText = personaFeedbackManager.guardReply(text, config?.personaGuard, {
                userText: e?.msg || e?.raw_message || opts?.prompt || "",
                botNames: [config?.persona?.name]
            });
            if (!guardedText) {
                reservation.release();
                return false;
            }
            await e.reply(guardedText);
            reservation.commit();
            return true;
        } catch (error) {
            reservation.release();
            this.logWarn(`[图片编辑] 发送进度提示失败: ${error.message}`);
            return false;
        }
    }

    loadConfig() {
        const configPath = path.join(process.cwd(), 'plugins/shiloh-plugin/config/message.yaml');
        return YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings;
    }

    normalizeArray(input) {
        if (Array.isArray(input)) return input;
        return typeof input === 'string' ? [input] : [];
    }

    async buildImageMessages(prompt, images) {
        const messages = [{ type: "text", text: prompt }];

        for (const url of images) {
            if (!url) continue;

            const imgData = await getBase64Image(url, "other.png");

            if (imgData.includes("该图片链接已过期")) {
                throw new Error("该图片下载链接已过期，请重新上传");
            }
            if (imgData.includes("无效的图片下载链接")) {
                throw new Error("无效的图片下载链接，请确保适配器支持且图片未过期");
            }

            const mimeType = mimeTypes.lookup("other.png") || 'application/octet-stream';
            messages.push(mimeType.startsWith('image/')
                ? { type: "image_url", image_url: { url: imgData } }
                : { type: "file", file_url: { url: imgData } }
            );
        }
        return messages;
    }

    async handleStreamResponse(response) {
        if (!response.ok || !response.body) {
            const data = await this.readJsonResponse(response);
            throw new Error(this.formatApiError(response, data));
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let content = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            for (const line of decoder.decode(value).split("\n")) {
                if (!line.startsWith("data: ")) continue;

                const dataStr = line.slice(6).trim();
                if (dataStr === "[DONE]") break;

                try {
                    const data = JSON.parse(dataStr);
                    content += data?.choices?.[0]?.delta?.content || "";
                } catch { }
            }
        }

        if (!content) throw new Error("未接收到有效内容");
        return content;
    }

    async handleChatResponse(response) {
        const data = await this.readJsonResponse(response);
        if (!response.ok) {
            throw new Error(this.formatApiError(response, data));
        }

        const imageUrl = this.extractChatImageResult(data);
        if (!imageUrl) throw new Error("未接收到有效内容");
        return imageUrl;
    }

    extractImageUrl(content) {
        return extractImageResult(content);
    }

    // ========== 图片URL处理 ==========

    /**
     * 调用OneBotv11 API
     */
    async callApi(action, params = {}) {
        try {
            if (typeof Bot !== 'undefined' && Bot.sendApi) {
                return await Bot.sendApi(action, params);
            } else if (typeof global.bot !== 'undefined' && global.bot.sendApi) {
                return await global.bot.sendApi(action, params);
            } else {
                throw new Error('找不到OneBotv11 API调用接口');
            }
        } catch (error) {
            console.error(`调用API ${action} 失败:`, error);
            throw error;
        }
    }

    async getRKey(url) {
        // 检查URL是否包含rkey参数
        const rkeyMatch = url.match(/rkey=([^&]+)/);
        if (!rkeyMatch) return null;

        try {
            const response = await this.callApi('nc_get_rkey');
            if (response?.status === 'ok' && response?.data?.length >= 2) {
                // 取数组中第二个元素的rkey，去掉开头的"&rkey="
                const rkeyValue = response.data[1].rkey;
                return rkeyValue.replace(/^&rkey=/, '');
            }
        } catch (error) {
            console.error('获取rkey失败:', error);
        }

        // 如果接口调用失败，返回原始rkey
        return rkeyMatch[1];
    }

    async processImageUrl(url) {
        if (!url?.includes('qq.com')) return url;

        const fid = url.match(/fileid=([^&]+)/)?.[1];
        const rkey = await this.getRKey(url);
        const host = url.slice(0, url.indexOf('&')) || url;

        if (fid && rkey && host) {
            for (let appid = 1408; appid >= 1403; appid--) {
                const newUrl = `${host}/download?appid=${appid}&fileid=${fid}&spec=0&rkey=${rkey}`;
                if (await this.isUrlAvailable(newUrl)) return newUrl;
            }
        }
        return url;
    }

    async isUrlAvailable(url) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 5000,
                maxRedirects: 5
            });

            if (response.headers['content-type']?.includes('application/json')) {
                const text = Buffer.from(response.data).toString();
                if (text.includes('retcode') || text.includes('error')) return false;
            }

            const header = [...Buffer.from(response.data).slice(0, 8)]
                .map(b => b.toString(16).padStart(2, '0').toUpperCase());

            const signatures = [
                ['FF', 'D8'],             // jpeg
                ['89', '50', '4E', '47'], // png
                ['47', '49', '46'],       // gif
                ['52', '49', '46', '46'], // webp
                ['42', '4D']              // bmp
            ];

            return signatures.some(sig => sig.every((b, i) => header[i] === b));
        } catch {
            return false;
        }
    }

    async getZaiKey() {
        const res = await fetch('http://localhost:9223/token');
        return (await res.json()).token || '';
    }
}
