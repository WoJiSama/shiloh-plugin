import { AbstractTool } from './AbstractTool.js';
import { getBase64Image, normalizeImageUrls } from '../../utils/fileUtils.js';
import { dependencies } from "../../dependence/dependencies.js";
import fs from "fs";
import YAML from "yaml";
import path from "path";
import { randomUUID } from "crypto";
import { pluginBridge } from "../../utils/pluginBridge.js";
import { personaFeedbackManager } from "../../domains/memory/PersonaFeedbackManager.js";
import {
  DEFAULT_IMAGE_GENERATION_URL,
  generateImageEditWithFallbacks,
  generateImageWithFallbacks,
  matchesImageProvider,
  normalizeImageProviderParameter,
  resolveRequestedImageProvider,
  resolveImageEditConfigs,
  resolveImageGenerationConfigs,
  selectImageConfigsByProvider,
  shouldRetryWithoutUrlResponseFormat,
  toImageEditUrl,
  toImageGenerationUrl
} from "../../utils/imageGenerationFallback.js";
import { serializeMultipartFormData } from "../../utils/multipartFormData.js";
import { formatMessageSendFailure, getImageBufferMetadata, isMessageSendFailed, resolveImageBuffer } from "../../utils/reliableImageSender.js";
import { extractImageResult } from "../../utils/imageResult.js";
import { buildImageFailureReply } from "../../utils/imageFailurePolicy.js";
import {
  applyImageAspectRatioToConfigs,
  describeImageAspectRatioIntent,
  resolveImageAspectRatioIntent
} from "../../utils/imageAspectRatio.js";
import { generateContextualProgressReply } from "../../utils/contextualProgressReply.js";
import { reserveProgressReply } from "../../utils/progressReplyBudget.js";

const { mimeTypes, FormData } = dependencies;
const DEFAULT_CHAT_IMAGE_URL = 'https://api.openai.com/v1/chat/completions';
const IMAGE_GENERATION_TIMEOUT_MS = 120000;
const IMAGE_GENERATION_DONE_MESSAGES = [
  "画出来啦，你先看看这版像不像你想的那种感觉。",
  "这张先给你看，我感觉还行，但细节可能有点跑。",
  "出来了出来了，我有点紧张，你先看看。"
];
const DRAW_JOB_PREFIX = "ytbot:image_draw_job:";
const DRAW_QUEUE_PREFIX = "ytbot:image_draw_queue:";
const DRAW_JOB_TTL_SECONDS = 24 * 60 * 60;
const imageGenerationScopes = new Map();

function isReferenceGeneration(opts = {}) {
  return ["member_avatar", "style_reference", "character_reference"].includes(
    String(opts?.referencePurpose || "").trim().toLowerCase()
  );
}

function isTransportDisplayName(name = "") {
  return /^\s*\[(?:有人@我|回复|转发|引用)/.test(String(name || ""));
}

function imageResponseTimeoutError(timeoutMs, { completeResponse = false } = {}) {
  const seconds = Math.max(1, Math.ceil(Number(timeoutMs) / 1000));
  return new Error(`图片接口超过 ${seconds} 秒没有返回${completeResponse ? "完整响应" : "结果"}`);
}

export class BananaTool extends AbstractTool {
  constructor({
    progressFetchImpl = globalThis.fetch,
    progressReplyFactory = generateContextualProgressReply
  } = {}) {
    super();
    this.name = 'bananaTool';
    this.description = '根据提示词生成或编辑图片；可按用户明确指定的已配置图片渠道执行';
    this.parameters = {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '绘图的描述提示词',
          minLength: 1,
          maxLength: 4000
        },
        images: {
          type: 'array',
          description: '用户提供的图片链接数组，需保留原始URL完整性',
          items: { type: 'string' }
        },
        provider: {
          type: 'string',
          description: '仅当用户明确说“用/指定某个渠道或模型画”时填写其原始名称，例如 Grok；未指定时不要填写'
        },
        aspectRatio: {
          type: 'string',
          description: '用户明确要求的画面比例或方向，例如 9:16、16:9、1:1、portrait、landscape、square；不要把它当作精确像素尺寸'
        },
        progressText: {
          type: 'string',
          description: '可选：结合当前绘图要求生成一句自然开场；必须符合真实任务类型，不能把文生图说成看图或改图'
        }
      },
      required: ['prompt'],
      additionalProperties: false
    };
    this.progressFetchImpl = progressFetchImpl;
    this.progressReplyFactory = progressReplyFactory;
  }

  async func(opts, e) {
    const { prompt } = opts;
    if (!prompt) return "错误：绘图提示词（prompt）不能为空。";
    const config = this.loadConfig();
    const requestedProvider = this.resolveRequestedProvider(config, opts, e);
    const aspectRatioIntent = this.resolveAspectRatioIntent(opts, e);
    const { provider: _untrustedProvider, ...baseOpts } = opts || {};
    const effectiveOpts = {
      ...baseOpts,
      ...(requestedProvider ? { provider: requestedProvider } : {}),
      ...(aspectRatioIntent ? { aspectRatio: aspectRatioIntent.raw || aspectRatioIntent.orientation } : {})
    };

    const job = {
      id: this.createDrawJobId(e),
      opts: this.cloneDrawOptions(effectiveOpts),
      e,
      scopeKey: this.getDrawScopeKey(e),
      requesterName: this.getRequesterDisplayName(e),
      requesterId: e?.user_id || e?.sender?.user_id || "",
      messageId: e?.message_id || "",
      queuedAt: Date.now(),
      notifyFailure: false,
      skipProgressNotice: false
    };
    const queueState = this.getDrawQueueState(job.scopeKey);
    await this.persistDrawJob(job);

    if (queueState.activeTask) {
      job.notifyFailure = true;
      job.skipProgressNotice = true;
      queueState.queue.push(job);
      this.logInfo(`[图片队列] 已排队 scope=${job.scopeKey} requester=${job.requesterName} queue=${queueState.queue.length} active=${queueState.activeTask.requesterName}`);
      await this.updateDrawTaskStatus(job, "queued", `前面正在帮 ${queueState.activeTask.requesterName || "别人"} 画图`);
      await this.replyQueuedDraw(e, queueState);
      return `图片生成已排队，前面还有 ${queueState.queue.length} 个任务`;
    }

    return await this.runDrawJob(job);
  }

  async runDrawJob(job) {
    if (!job.id) job.id = this.createDrawJobId(job.e);
    const queueState = this.getDrawQueueState(job.scopeKey);
    queueState.activeTask = {
      jobId: job.id,
      requesterName: job.requesterName,
      requesterId: job.requesterId,
      groupId: job.e?.group_id || "",
      messageId: job.messageId || "",
      startedAt: Date.now()
    };
    // 先占位再持久化。runNextQueuedDraw 不等待本任务，恢复扫描必须马上看见它在运行。
    await this.persistDrawJob(job);
    await this.updateDrawTaskStatus(job, "running", "图片正在生成中");

    try {
      const result = await this.performDraw(job.opts, job.e, {
        skipProgressNotice: job.skipProgressNotice
      });
      if (job.notifyFailure && this.isErrorResult(result)) {
        await job.e.reply(this.getQueuedFailureMessage(this.serializeResultError(result)));
      }
      await this.markDrawMessageStatus(job, result);
      return result;
    } finally {
      queueState.activeTask = null;
      await this.removeDurableDrawJob(job);
      await this.clearDrawTaskStatus(job);
      this.runNextQueuedDraw(job.scopeKey);
      setImmediate(() => this.processDurableDrawQueue(job.scopeKey).catch(error => {
        this.logWarn(`[图片队列] 恢复后继续处理队列失败: ${error.message}`);
      }));
    }
  }

  async updateDrawTaskStatus(job, status, detail = "") {
    const instance = pluginBridge.instance;
    if (!instance?.updateUserToolTaskStatus) return;
    try {
      await instance.updateUserToolTaskStatus({
        groupId: job.e?.group_id || "",
        userId: job.requesterId || job.e?.user_id || job.e?.sender?.user_id || "",
        messageId: job.messageId || job.e?.message_id || "",
        toolName: this.name,
        status,
        requesterName: job.requesterName || "",
        detail,
        scopeKey: job.scopeKey || ""
      });
    } catch (error) {
      this.logWarn(`[图片队列] 同步任务状态失败: ${error.message}`);
    }
  }

  async clearDrawTaskStatus(job) {
    const instance = pluginBridge.instance;
    if (!instance?.clearUserToolTaskStatus) return;
    try {
      await instance.clearUserToolTaskStatus({
        groupId: job.e?.group_id || "",
        userId: job.requesterId || job.e?.user_id || job.e?.sender?.user_id || "",
        toolName: this.name
      });
    } catch (error) {
      this.logWarn(`[图片队列] 清理任务状态失败: ${error.message}`);
    }
  }

  runNextQueuedDraw(scopeKey) {
    const queueState = this.getDrawQueueState(scopeKey);
    const next = queueState.queue.shift();
    if (!next) {
      this.cleanupDrawQueueState(scopeKey, queueState);
      return;
    }
    this.logInfo(`[图片队列] 开始下一项 scope=${scopeKey} requester=${next.requesterName} remaining=${queueState.queue.length}`);
    this.runDrawJob(next).catch(error => {
      this.logError("[图片队列] 后台绘图任务失败:", error);
      this.cleanupDrawQueueState(scopeKey, queueState);
    });
  }

  async markDrawMessageStatus(job, result) {
    const instance = pluginBridge.instance;
    if (!instance?.saveTaskStatus || !job?.messageId) return;
    try {
      const failed = this.isErrorResult(result);
      await instance.saveTaskStatus({
        groupId: job.e?.group_id || "",
        userId: job.requesterId || job.e?.user_id || job.e?.sender?.user_id || "",
        messageId: job.messageId,
        status: failed ? "tool_failed" : "tool_success",
        toolName: this.name,
        error: failed ? this.serializeResultError(result) : ""
      });
    } catch (error) {
      this.logWarn(`[图片队列] 同步消息任务状态失败: ${error.message}`);
    }
  }

  serializeResultError(result) {
    if (!result) return "";
    if (typeof result === "string") return result;
    return result.error ? String(result.error) : JSON.stringify(result).slice(0, 200);
  }

  createDrawJobId(e) {
    const groupId = e?.group_id || "private";
    const userId = e?.user_id || e?.sender?.user_id || "unknown";
    const messageId = e?.message_id || randomUUID();
    return `${groupId}:${userId}:${messageId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  }

  getRedis() {
    return globalThis.redis || (typeof redis !== "undefined" ? redis : null);
  }

  getDurableJobKey(jobId) {
    return `${DRAW_JOB_PREFIX}${jobId}`;
  }

  getDurableQueueKey(scopeKey) {
    return `${DRAW_QUEUE_PREFIX}${scopeKey || "private:unknown"}`;
  }

  getDurableTtlSeconds() {
    return Math.max(DRAW_JOB_TTL_SECONDS, Number(pluginBridge.instance?.getTaskStatusTtlSeconds?.()) || 0);
  }

  serializeDrawJob(job) {
    const e = job.e || {};
    const userId = job.requesterId || e.user_id || e.sender?.user_id || "";
    const groupId = e.group_id || "";
    return {
      id: job.id,
      opts: this.cloneDrawOptions(job.opts),
      scopeKey: job.scopeKey || this.getDrawScopeKey(e),
      requesterName: job.requesterName || this.getRequesterDisplayName(e),
      requesterId: String(userId || ""),
      userId: String(userId || ""),
      groupId: groupId ? String(groupId) : "",
      messageId: job.messageId || e.message_id || "",
      messageType: e.message_type || (groupId ? "group" : "private"),
      selfId: e.self_id || "",
      sender: {
        user_id: userId ? Number(userId) : undefined,
        nickname: e.sender?.nickname || e.nickname || job.requesterName || "",
        card: e.sender?.card || ""
      },
      queuedAt: job.queuedAt || Date.now(),
      notifyFailure: Boolean(job.notifyFailure),
      skipProgressNotice: Boolean(job.skipProgressNotice)
    };
  }

  deserializeDrawJob(record) {
    const e = this.buildRecoveredEvent(record);
    return {
      id: record.id,
      opts: this.cloneDrawOptions(record.opts || {}),
      e,
      scopeKey: record.scopeKey || this.getDrawScopeKey(e),
      requesterName: record.requesterName || this.getRequesterDisplayName(e),
      requesterId: record.requesterId || record.userId || e.user_id || "",
      messageId: record.messageId || "",
      queuedAt: record.queuedAt || Date.now(),
      // The original Agent call is gone after a process restart, so a recovered
      // job must deliver its own terminal failure instead of only writing status.
      notifyFailure: true,
      skipProgressNotice: true,
      recovered: true
    };
  }

  buildRecoveredEvent(record = {}) {
    const bot = globalThis.Bot || (typeof Bot !== "undefined" ? Bot : null);
    const groupId = record.groupId ? Number(record.groupId) : null;
    const userId = Number(record.userId || record.requesterId || 0) || 0;
    const isGroup = Boolean(groupId);
    const event = {
      group_id: groupId,
      user_id: userId,
      sender: {
        ...(record.sender || {}),
        user_id: userId
      },
      message_id: record.messageId || "",
      message_type: record.messageType || (isGroup ? "group" : "private"),
      self_id: record.selfId || bot?.uin || "",
      bot,
      isGroup
    };
    event.reply = async message => {
      if (isGroup) {
        const group = bot?.pickGroup?.(groupId);
        if (group?.sendMsg) return await group.sendMsg(message);
        if (bot?.sendApi) return await bot.sendApi("send_group_msg", { group_id: groupId, message });
      } else if (userId) {
        const friend = bot?.pickFriend?.(userId);
        if (friend?.sendMsg) return await friend.sendMsg(message);
        if (bot?.sendApi) return await bot.sendApi("send_private_msg", { user_id: userId, message });
      }
      throw new Error("无法恢复发送上下文");
    };
    return event;
  }

  async persistDrawJob(job) {
    const store = this.getRedis();
    if (!store || !job?.id) return;
    try {
      const record = this.serializeDrawJob(job);
      const ttl = this.getDurableTtlSeconds();
      await store.set(this.getDurableJobKey(record.id), JSON.stringify(record), { EX: ttl });
      await this.appendDurableQueue(record.scopeKey, record.id, ttl);
    } catch (error) {
      this.logWarn(`[图片队列] 持久化任务失败，重启后可能无法恢复: ${error.message}`);
    }
  }

  async appendDurableQueue(scopeKey, jobId, ttl = DRAW_JOB_TTL_SECONDS) {
    const list = await this.readDurableQueue(scopeKey);
    if (!list.includes(jobId)) list.push(jobId);
    await this.writeDurableQueue(scopeKey, list, ttl);
  }

  async readDurableQueue(scopeKey) {
    const store = this.getRedis();
    if (!store) return [];
    const raw = await store.get(this.getDurableQueueKey(scopeKey));
    if (!raw) return [];
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async writeDurableQueue(scopeKey, list, ttl = DRAW_JOB_TTL_SECONDS) {
    const store = this.getRedis();
    if (!store) return;
    const key = this.getDurableQueueKey(scopeKey);
    const normalized = [...new Set((list || []).filter(Boolean))];
    if (!normalized.length) {
      await store.del(key);
      return;
    }
    await store.set(key, JSON.stringify(normalized), { EX: ttl });
  }

  async removeDurableDrawJob(job) {
    const store = this.getRedis();
    if (!store || !job?.id) return;
    try {
      await store.del(this.getDurableJobKey(job.id));
      const list = await this.readDurableQueue(job.scopeKey);
      await this.writeDurableQueue(job.scopeKey, list.filter(id => id !== job.id), this.getDurableTtlSeconds());
    } catch (error) {
      this.logWarn(`[图片队列] 清理持久任务失败: ${error.message}`);
    }
  }

  async readDurableDrawJob(jobId) {
    const store = this.getRedis();
    if (!store || !jobId) return null;
    const raw = await store.get(this.getDurableJobKey(jobId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      await store.del(this.getDurableJobKey(jobId));
      return null;
    }
  }

  async scanRedisKeys(pattern) {
    const store = this.getRedis();
    if (!store) return [];
    if (typeof store.scanIterator === "function") {
      const keys = [];
      for await (const key of store.scanIterator({ MATCH: pattern, COUNT: 200 })) {
        if (Array.isArray(key)) keys.push(...key);
        else keys.push(key);
      }
      return keys;
    }
    if (typeof store.scan === "function") {
      const keys = [];
      let cursor = "0";
      do {
        const [nextCursor, batch = []] = await store.scan(cursor, "MATCH", pattern, "COUNT", 200);
        cursor = String(nextCursor);
        keys.push(...batch);
      } while (cursor !== "0");
      return keys;
    }
    return typeof store.keys === "function" ? await store.keys(pattern) : [];
  }

  async recoverDurableJobs() {
    const keys = await this.scanRedisKeys(`${DRAW_QUEUE_PREFIX}*`);
    if (!keys.length) return;
    this.logInfo(`[图片队列] 发现 ${keys.length} 个持久队列，准备恢复未完成绘图任务`);
    for (const key of keys) {
      const scopeKey = key.slice(DRAW_QUEUE_PREFIX.length);
      await this.processDurableDrawQueue(scopeKey);
    }
  }

  async processDurableDrawQueue(scopeKey) {
    const queueState = this.getDrawQueueState(scopeKey);
    if (queueState.activeTask || queueState.recovering) return;
    queueState.recovering = true;

    try {
      const ids = await this.readDurableQueue(scopeKey);
      if (!ids.length) return;

      for (const jobId of ids) {
        const record = await this.readDurableDrawJob(jobId);
        if (!record) {
          await this.writeDurableQueue(scopeKey, ids.filter(id => id !== jobId), this.getDurableTtlSeconds());
          continue;
        }

        const job = this.deserializeDrawJob(record);
        this.logInfo(`[图片队列] 恢复未完成绘图任务 scope=${scopeKey} requester=${job.requesterName} message=${job.messageId}`);
        await this.sendRecoveredNotice(job);
        queueState.recovering = false;
        this.runDrawJob(job).catch(error => {
          this.logError("[图片队列] 恢复绘图任务失败:", error);
        });
        return;
      }
    } finally {
      if (queueState.recovering) queueState.recovering = false;
    }
  }

  async sendRecoveredNotice(job) {
    try {
      await job.e.reply("刚刚我这边重启了一下，不过这张图我还记着呢。我继续画，出来了会直接发给你。");
    } catch (error) {
      this.logWarn(`[图片队列] 发送恢复提示失败: ${error.message}`);
    }
  }

  async performDraw(opts, e, options = {}) {
    const STREAM = false;
    const config = this.loadConfig();
    const { prompt, images: rawImages } = opts;

    // 处理图片
    const rawImageList = this.normalizeArray(rawImages);
    const hasReferenceImages = rawImageList.length > 0;
    const referenceGeneration = hasReferenceImages && isReferenceGeneration(opts);
    const operationLabel = referenceGeneration || !hasReferenceImages ? "图片生成" : "图片编辑";
    const images = await normalizeImageUrls(rawImageList);
    const requestedProvider = this.resolveRequestedProvider(config, opts, e);
    let imageGenerationConfigs = this.resolveImageGenerationConfigs(config);
    let imageEditConfigs = this.resolveImageEditConfigs(config);
    const finalPrompt = String(prompt || "").trim();
    const aspectRatioIntent = this.resolveAspectRatioIntent(opts, e);
    const { imageEditApiUrl: apiUrl, imageEditApiKey: apiKey, imageEditApiModel: model } =
      config.imageEditAiConfig || {};
    const requestedChatEdit = Boolean(
      requestedProvider &&
      matchesImageProvider(config.imageEditAiConfig || {}, requestedProvider) &&
      !this.isImagesEditEndpoint(apiUrl)
    );

    try {
      if (requestedProvider) {
        if (hasReferenceImages) {
          if (!requestedChatEdit) {
            imageEditConfigs = selectImageConfigsByProvider(imageEditConfigs, requestedProvider, "图片编辑");
          } else {
            imageEditConfigs = [];
          }
        } else {
          imageGenerationConfigs = selectImageConfigsByProvider(imageGenerationConfigs, requestedProvider, "文生图");
        }
        this.logInfo(`[图片渠道] 用户指定 ${requestedProvider}，本次禁止跨名称 fallback`);
      }
    } catch (error) {
      return { error: `图片生成失败: ${error.message}` };
    }
    imageGenerationConfigs = applyImageAspectRatioToConfigs(imageGenerationConfigs, aspectRatioIntent, {
      operation: "generate"
    });
    imageEditConfigs = applyImageAspectRatioToConfigs(imageEditConfigs, aspectRatioIntent, {
      operation: "edit"
    });
    const activeConfigs = hasReferenceImages ? imageEditConfigs : imageGenerationConfigs;
    if (activeConfigs.length) {
      const sizes = activeConfigs.map(item => `${item.name || item.model}:${item.size || "provider-default"}`).join(",");
      this.logInfo(`[图片比例] intent=${describeImageAspectRatioIntent(aspectRatioIntent)} operation=${hasReferenceImages ? "edit" : "generate"} sizes=${sizes}`);
    }
    if (hasReferenceImages && !images.length) {
      return { error: `${operationLabel}失败: 未检测到有效的图片链接` };
    }
    if (!finalPrompt) return { error: '图片生成失败: 绘图提示词为空' };
    let progressController = null;
    if (!options.skipProgressNotice) {
      progressController = new AbortController();
      void Promise.resolve(this.sendProgress(e, {
        config,
        opts,
        hasReferenceImages,
        signal: progressController.signal
      })).catch(error => this.logWarn(`[图片进度提示] 生成或发送异常: ${error?.message || error}`));
    }

    try {
      if (!hasReferenceImages && imageGenerationConfigs.length) {
        const generatedImage = await this.generateImage(imageGenerationConfigs, finalPrompt);
        await this.replyImageToRequester(e, generatedImage, { aspectRatioIntent });
        return '图片生成成功';
      }

      if (hasReferenceImages && imageEditConfigs.length) {
        const editedImage = await this.generateImageEdit(imageEditConfigs, finalPrompt, images);
        await this.replyImageToRequester(e, editedImage, { aspectRatioIntent });
        return referenceGeneration ? '图片生成成功' : '图片编辑成功';
      }

      const imgurls = await this.buildImageMessages(finalPrompt, images);
      const response = await fetch(apiUrl || DEFAULT_CHAT_IMAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey || 'sk-xxxxxx'}`,
        },
        body: JSON.stringify({
          model: model || "gemini-3-pro-image-preview",
          messages: [{ role: "user", content: imgurls }],
          stream: STREAM,
        }),
      });

      const imageUrl = STREAM
        ? await this.handleStreamResponse(response)
        : await this.handleNormalResponse(response);

      const processedUrl = this.extractImageUrl(imageUrl);

      if (processedUrl) {
        await this.replyImageToRequester(e, processedUrl, { aspectRatioIntent });
        return referenceGeneration ? '图片生成成功' : '图片编辑成功';
      }
      return { error: `${operationLabel}失败` };
    } catch (error) {
      console.error(`${operationLabel}失败`, error);
      const detail = referenceGeneration
        ? String(error?.message || error)
            .replace(/^图片编辑失败[:：]\s*/i, "")
            .replace(/图片编辑通道/g, "外观参考通道")
        : error.message;
      return { error: `${operationLabel}失败: ${detail}` };
    } finally {
      progressController?.abort?.();
    }
  }

  cloneDrawOptions(opts = {}) {
    return {
      ...opts,
      images: Array.isArray(opts.images) ? [...opts.images] : opts.images
    };
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

  resolveAspectRatioIntent(opts = {}, e = {}) {
    const sourceText = [e?.msg, e?.raw_message, opts?.prompt].filter(Boolean).join("\n");
    return resolveImageAspectRatioIntent(sourceText, opts?.aspectRatio);
  }

  getRequesterDisplayName(e) {
    const card = String(e?.sender?.card || "").trim();
    const nickname = String(e?.sender?.nickname || e?.nickname || "").trim();
    const displayName = !isTransportDisplayName(card) ? card : nickname;
    return String(displayName || e?.user_id || "别人")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 24);
  }

  getDrawScopeKey(e) {
    if (e?.group_id) return `group:${e.group_id}`;
    return `private:${e?.user_id || e?.sender?.user_id || "unknown"}`;
  }

  getDrawQueueState(scopeKey) {
    const key = scopeKey || "private:unknown";
    let queueState = imageGenerationScopes.get(key);
    if (!queueState) {
      queueState = { activeTask: null, queue: [] };
      imageGenerationScopes.set(key, queueState);
    }
    return queueState;
  }

  cleanupDrawQueueState(scopeKey, queueState) {
    if (!queueState.activeTask && !queueState.recovering && queueState.queue.length === 0) {
      imageGenerationScopes.delete(scopeKey);
    }
  }

  async replyQueuedDraw(e, queueState) {
    const activeTask = queueState?.activeTask;
    const activeName = activeTask?.requesterName || "别人";
    const sameRequester = activeTask?.requesterId &&
      String(activeTask.requesterId) === String(e?.user_id || e?.sender?.user_id || "");
    const message = sameRequester
      ? "我现在还在帮你上一张画画诶，有点忙不过来了…不过这张我也记住了，等上一张画完就来画这张，好不好~"
      : `我现在正在帮「${activeName}」画画诶，有点忙不过来了…不过我已经记住你的了，等我帮那边画完就来帮你画，好不好~`;
    await e.reply(this.buildQueuedDrawReplyMessage(message, activeTask));
  }

  buildQueuedDrawReplyMessage(message, activeTask = {}) {
    const messageId = activeTask?.messageId;
    if (!messageId) return message;
    const replySegment = this.buildReplySegment(messageId);
    return replySegment ? [replySegment, message] : message;
  }

  buildReplySegment(messageId) {
    if (!messageId) return null;
    if (globalThis.segment?.reply) return globalThis.segment.reply(messageId);
    if (typeof segment !== "undefined" && segment?.reply) return segment.reply(messageId);
    return { type: "reply", id: String(messageId), data: { id: String(messageId) } };
  }

  getQueuedFailureMessage(error = "") {
    return buildImageFailureReply(error);
  }

  isErrorResult(result) {
    if (!result) return false;
    if (typeof result === "string") return /^error[:：]/i.test(result.trim()) || /失败|错误|失敗|錯誤/.test(result);
    return Boolean(result.error);
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

  resolveImageGenerationConfigs(config) {
    return resolveImageGenerationConfigs(config);
  }

  resolveImageGenerationConfig(config) {
    return this.resolveImageGenerationConfigs(config)[0] || null;
  }

  resolveImageEditConfigs(config) {
    return resolveImageEditConfigs(config);
  }

  toImageGenerationUrl(apiUrl = DEFAULT_IMAGE_GENERATION_URL) {
    return toImageGenerationUrl(apiUrl);
  }

  toImageEditUrl(apiUrl = "") {
    return toImageEditUrl(apiUrl);
  }

  buildImageGenerationPayload(imageGenerationConfig, prompt, responseFormat = "") {
    if (/^grok-imagine-image(?:-edit)?$/i.test(String(imageGenerationConfig.model || "").trim())) {
      const payload = {
        model: imageGenerationConfig.model,
        prompt,
        quality: imageGenerationConfig.quality || "high"
      };
      if (imageGenerationConfig.size) payload.size = imageGenerationConfig.size;
      return payload;
    }
    const payload = {
      model: imageGenerationConfig.model,
      prompt,
      n: 1
    };
    if (imageGenerationConfig.size) payload.size = imageGenerationConfig.size;
    if (responseFormat) payload.response_format = responseFormat;
    return payload;
  }

  isImagesEditEndpoint(apiUrl = "") {
    const url = String(apiUrl || "").trim();
    if (!url) return false;
    if (/\/chat\/completions\/?$/i.test(url)) return false;
    return /(?:\/images\/edits\/?|\/v1\/?|\/openai\/v1\/?|\/api\/v1\/?|\/)$/.test(url);
  }

  parseDataImage(dataUri = "") {
    const match = String(dataUri || "").match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error("参考图片转换失败");
    const [, mimeType, base64] = match;
    return { mimeType, buffer: Buffer.from(base64, "base64") };
  }

  async buildImageEditFormData(imageEditConfig, prompt, images, responseFormat = "") {
    const form = new FormData();
    form.append("model", imageEditConfig.model || "gpt-image-2");
    form.append("prompt", prompt);
    form.append("n", "1");
    if (imageEditConfig.size) form.append("size", imageEditConfig.size);
    if (responseFormat) form.append("response_format", responseFormat);

    let imageCount = 0;
    for (const url of images) {
      if (!url) continue;
      const imgData = await getBase64Image(url, `reference-${imageCount + 1}.png`);
      if (imgData.includes("该图片链接已过期") || imgData.includes("无效的图片下载链接") || imgData.includes("无效的图片格式")) {
        throw new Error(imgData);
      }
      const image = this.parseDataImage(imgData);
      const ext = mimeTypes.extension(image.mimeType) || "png";
      form.append("image", image.buffer, {
        filename: `reference-${imageCount + 1}.${ext}`,
        contentType: image.mimeType,
        knownLength: image.buffer.length,
      });
      imageCount++;
    }

    if (!imageCount) throw new Error("没有可用的参考图片");
    return form;
  }

  async requestImageEdit(imageEditConfig, prompt, images, responseFormat = "") {
    const form = await this.buildImageEditFormData(imageEditConfig, prompt, images, responseFormat);
    const multipart = await serializeMultipartFormData(form);
    return await this.fetchWithTimeout(imageEditConfig.apiUrl, {
      method: "POST",
      headers: {
        ...multipart.headers,
        Authorization: `Bearer ${imageEditConfig.apiKey || 'sk-xxxxxx'}`,
      },
      body: multipart.body,
    }, IMAGE_GENERATION_TIMEOUT_MS);
  }

  async generateImageEdit(imageEditConfigs, prompt, images) {
    return await generateImageEditWithFallbacks(imageEditConfigs, prompt, images, {
      request: (config, inputPrompt, inputImages, responseFormat) =>
        this.requestImageEdit(config, inputPrompt, inputImages, responseFormat),
      parseResponse: response => this.parseImageGenerationResponse(response),
      logInfo: (...args) => this.logInfo(...args),
      logWarn: (...args) => this.logWarn(...args)
    });
  }

  async requestImageGeneration(imageGenerationConfig, prompt, responseFormat = "") {
    return await this.fetchWithTimeout(imageGenerationConfig.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${imageGenerationConfig.apiKey}`,
      },
      body: JSON.stringify(this.buildImageGenerationPayload(imageGenerationConfig, prompt, responseFormat)),
    }, IMAGE_GENERATION_TIMEOUT_MS);
  }

  async generateImage(imageGenerationConfig, prompt) {
    return await generateImageWithFallbacks(imageGenerationConfig, prompt, {
      request: (config, inputPrompt, responseFormat) =>
        this.requestImageGeneration(config, inputPrompt, responseFormat),
      parseResponse: response => this.parseImageGenerationResponse(response),
      logInfo: (...args) => this.logInfo(...args),
      logWarn: (...args) => this.logWarn(...args)
    });
  }

  shouldRetryWithoutUrlResponseFormat(errorMessage = "") {
    return shouldRetryWithoutUrlResponseFormat(errorMessage);
  }

  resolveProgressContext(opts = {}, hasReferenceImages = false) {
    const referencePurpose = String(opts?.referencePurpose || "").trim().toLowerCase();
    const taskMode = hasReferenceImages ? "reference_generation" : "image_generation";
    return {
      taskType: referencePurpose === "member_avatar" ? "群友形象图片生成" : "图片生成",
      taskMode,
      stage: hasReferenceImages
        ? "正在按用户描述生成一张新图，参考素材只用于外观或风格，尚未得到成图"
        : "正在按用户描述生成一张新图，尚未得到成图"
    };
  }

  async sendProgress(e, { config = {}, opts = {}, hasReferenceImages = false, signal } = {}) {
    const reservation = reserveProgressReply(e);
    if (!reservation) return false;
    try {
      if (!e?.reply || signal?.aborted) {
        reservation.release();
        return false;
      }
      const progress = this.resolveProgressContext(opts, hasReferenceImages);
      const message = await this.progressReplyFactory({
        config,
        ...progress,
        userText: e?.msg || e?.raw_message || opts?.prompt || "生成一张图片",
        suggestedText: opts?.progressText,
        agentContext: opts?.agentContext,
        fetchImpl: this.progressFetchImpl,
        signal
      });
      if (!message || signal?.aborted) {
        reservation.release();
        return false;
      }
      const guardedMessage = personaFeedbackManager.guardReply(message, pluginBridge.instance?.config?.personaGuard, {
        userText: e?.msg || "",
        botNames: [e?.bot?.nickname, pluginBridge.instance?.config?.persona?.name]
      });
      if (!guardedMessage) {
        reservation.release();
        return false;
      }
      const result = await e.reply(guardedMessage);
      if (this.isReplySendFailed(result)) {
        reservation.release();
        this.logWarn(`[图片进度提示] 发送失败: ${this.formatReplySendFailure(result)}`);
        return false;
      }
      reservation.commit();
      this.logInfo(`[图片进度提示] 已发送 requester=${this.getRequesterDisplayName(e)}`);
      return true;
    } catch (error) {
      reservation.release();
      this.logWarn(`[图片进度提示] 发送异常: ${error?.message || error}`);
      return false;
    }
  }

  getDoneMessage() {
    return IMAGE_GENERATION_DONE_MESSAGES[
      Math.floor(Math.random() * IMAGE_GENERATION_DONE_MESSAGES.length)
    ];
  }

  buildRequesterAtSegment(e) {
    const userId = e?.user_id || e?.sender?.user_id;
    if (!userId) return null;
    if (typeof segment !== "undefined" && typeof segment.at === "function") {
      return segment.at(userId);
    }
    return { type: "at", qq: userId };
  }

  async replyImageToRequester(e, image, context = {}) {
    const imageBuffer = await resolveImageBuffer(image);
    const metadata = await getImageBufferMetadata(imageBuffer);
    if (metadata?.width && metadata?.height) {
      this.logInfo(`[图片产物] requested=${describeImageAspectRatioIntent(context.aspectRatioIntent)} actual=${metadata.width}x${metadata.height} format=${metadata.format || "unknown"}`);
    } else {
      this.logWarn("[图片产物] 无法读取实际宽高，将继续发送原始产物");
    }
    const atSegment = this.buildRequesterAtSegment(e);
    const doneMessage = this.getDoneMessage();
    const attempts = [];

    if (atSegment) {
      attempts.push(() => [atSegment, "\n", doneMessage, "\n", segment.image(imageBuffer)]);
    }
    attempts.push(() => [doneMessage, "\n", segment.image(imageBuffer)]);
    attempts.push(() => [segment.image(imageBuffer)]);

    let lastError = null;
    for (const buildMessage of attempts) {
      try {
        const replyResult = await e.reply(buildMessage());
        if (this.isReplySendFailed(replyResult)) {
          throw new Error(this.formatReplySendFailure(replyResult));
        }
        return metadata;
      } catch (error) {
        lastError = error;
        this.logWarn(`[图片发送] 发送尝试失败: ${error.message}`);
      }
    }
    throw new Error(`图片已生成但发送失败: ${lastError?.message || "未知错误"}`);
  }

  isReplySendFailed(result) {
    return isMessageSendFailed(result);
  }

  formatReplySendFailure(result) {
    return formatMessageSendFailure(result);
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = IMAGE_GENERATION_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      const readText = response?.text;
      if (typeof readText !== "function") {
        clearTimeout(timer);
        return response;
      }

      let timerCleared = false;
      const clearTimer = () => {
        if (timerCleared) return;
        timerCleared = true;
        clearTimeout(timer);
      };
      const readTimedText = async () => {
        try {
          return await readText.call(response);
        } catch (error) {
          if (controller.signal.aborted) throw imageResponseTimeoutError(timeoutMs, { completeResponse: true });
          throw error;
        } finally {
          clearTimer();
        }
      };

      // Keep the abort timer alive until the body is fully consumed. A provider can
      // send response headers then stall forever while `response.text()` waits.
      return new Proxy(response, {
        get(target, property) {
          if (property === "text") return readTimedText;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw imageResponseTimeoutError(timeoutMs);
      }
      throw error;
    }
  }

  // 加载配置
  loadConfig() {
    const configPath = path.join(process.cwd(), 'plugins/shiloh-plugin/config/message.yaml');
    return YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings;
  }

  // 数组标准化
  normalizeArray(input) {
    if (Array.isArray(input)) return input;
    return typeof input === 'string' ? [input] : [];
  }

  // 构建图片消息
  async buildImageMessages(prompt, images) {
    const messages = [{ type: "text", text: "你必须至少生成一张高质量的图片:" + prompt }];

    for (const url of images) {
      if (!url) continue;
      const imgData = await getBase64Image(url, "other.png");

      if (imgData.includes("该图片链接已过期") || imgData.includes("无效的图片下载链接")) {
        throw new Error(imgData);
      }

      const mimeType = mimeTypes.lookup("other.png") || 'application/octet-stream';
      messages.push(mimeType.startsWith('image/')
        ? { type: "image_url", image_url: { url: imgData } }
        : { type: "file", file_url: { url: imgData } }
      );
    }
    return messages;
  }

  // 处理流式响应
  async handleStreamResponse(response) {
    if (!response.ok || !response.body) {
      throw new Error(`API请求失败: ${response.statusText}`);
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

  // 处理普通响应
  async handleNormalResponse(response) {
    const data = await this.readJsonResponse(response);
    if (!response.ok) {
      throw new Error(this.formatApiError(response, data));
    }
    return data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
      data?.choices?.[0]?.message?.images?.[0]?.url ||
      data?.choices?.[0]?.message?.content;
  }

  async parseImageGenerationResponse(response) {
    const data = await this.readJsonResponse(response);
    if (!response.ok) {
      return { ok: false, errorMessage: this.formatApiError(response, data), data };
    }

    const item = data?.data?.[0];
    if (item?.url) {
      this.logInfo("[图片生成] 上游返回 url");
      return { ok: true, image: item.url, format: "url" };
    }
    if (item?.b64_json) {
      this.logInfo("[图片生成] 上游返回 b64_json");
      return { ok: true, image: `base64://${item.b64_json}`, format: "b64_json" };
    }
    const detail = this.formatImageGenerationEmptyResponse(data);
    return { ok: false, errorMessage: detail || "未接收到有效图片", data };
  }

  formatImageGenerationEmptyResponse(data = {}) {
    const item = data?.data?.[0] || {};
    const keys = Object.keys(item);
    const revised = item?.revised_prompt ? ` revised_prompt=${String(item.revised_prompt).slice(0, 180)}` : "";
    const upstreamError = data?.error
      ? ` error=${String(data.error.message || data.error.code || data.error.type || JSON.stringify(data.error)).slice(0, 240)}`
      : "";
    const topKeys = Object.keys(data || {}).join(",");
    if (!keys.length && !topKeys) return "";
    return `未接收到有效图片，上游返回字段: top=[${topKeys || "无"}] data0=[${keys.join(",") || "无"}]${upstreamError}${revised}`;
  }

  async handleImageGenerationResponse(response) {
    const result = await this.parseImageGenerationResponse(response);
    if (result.ok) return result.image;
    throw new Error(result.errorMessage);
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

  // 提取图片URL
  extractImageUrl(content) {
    return extractImageResult(content);
  }

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

  // 处理图片URL（腾讯图床等）
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

  // 检查URL可用性
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
        ['FF', 'D8'],           // jpeg
        ['89', '50', '4E', '47'], // png
        ['47', '49', '46'],      // gif
        ['52', '49', '46', '46'], // webp
        ['42', '4D']            // bmp
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
