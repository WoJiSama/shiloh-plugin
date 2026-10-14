import type {BananaPorts,DrawOptions,DrawEvent,DrawJob,DrawRecord,DrawQueue,DrawActive,DrawId} from '../../../contracts/bananaTool.js'
import type {ImageServiceCandidate} from '../../../contracts/imageService.js'
import {toolRecord} from '../../../contracts/toolExecution.js'
import {createImageService,isImagesEditEndpoint} from '../../image/application/imageService.js'
import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {randomUUID} from 'node:crypto'
import {DEFAULT_IMAGE_GENERATION_URL,matchesImageProvider,normalizeImageProviderParameter,resolveRequestedImageProvider,resolveImageEditConfigs,resolveImageGenerationConfigs,selectImageConfigsByProvider,shouldRetryWithoutUrlResponseFormat,toImageEditUrl,toImageGenerationUrl} from '../../image/domain/providerConfig.js'
import {extractImageResult} from '../../image/domain/imageResult.js'
import {buildImageFailureReply} from '../../image/domain/imageFailurePolicy.js'
import {applyImageAspectRatioToConfigs,describeImageAspectRatioIntent,resolveImageAspectRatioIntent,type ImageAspectRatioIntent} from '../../image/domain/imageAspectRatio.js'
import {generateContextualProgressReply} from '../../conversation/application/contextualProgressReply.js'
import {reserveProgressReply} from '../../conversation/domain/progressReplyBudget.js'
import {parseDrawOptions,parseDrawEvent,parseDrawRecord} from './bananaDecoders.js'
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error)
const IMAGE_GENERATION_TIMEOUT_MS = 120000;
const IMAGE_GENERATION_DONE_MESSAGES = [
  "画出来啦，你先看看这版像不像你想的那种感觉。",
  "这张先给你看，我感觉还行，但细节可能有点跑。",
  "出来了出来了，我有点紧张，你先看看。"
];
const DRAW_JOB_PREFIX = "ytbot:image_draw_job:";
const DRAW_QUEUE_PREFIX = "ytbot:image_draw_queue:";
const DRAW_JOB_TTL_SECONDS = 24 * 60 * 60;
const imageGenerationScopes = new Map<string,DrawQueue>();

function isReferenceGeneration(opts:DrawOptions = {}) {
  return ["member_avatar", "style_reference", "character_reference"].includes(
    String(opts?.referencePurpose || "").trim().toLowerCase()
  );
}

function isTransportDisplayName(name = "") {
  return /^\s*\[(?:有人@我|回复|转发|引用)/.test(String(name || ""));
}

export class BananaTool extends AbstractTool {
 progressFetchImpl:typeof fetch;progressReplyFactory:typeof generateContextualProgressReply;imageService?:ReturnType<typeof createImageService>;
  declare parameters: {type:string;properties:Record<string,{type?:string;items?:{type?:string;[key:string]:unknown};[key:string]:unknown}>;required:string[];additionalProperties?:boolean};
  constructor({
    progressFetchImpl = globalThis.fetch,
    progressReplyFactory = generateContextualProgressReply
  }: {progressFetchImpl?:typeof fetch;progressReplyFactory?:typeof generateContextualProgressReply} = {}, private readonly ports:BananaPorts) {
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
        },
        references: {
          type: 'array',
          description: '群成员头像参考：用户想让群友形象出现在画面里时按角色列出；qq 必须取自消息中真实被@/被指认的成员，绝不编造；系统会自动下载头像并按本数组顺序附加',
          items: {
            type: 'object',
            properties: {
              qq: { type: 'string', description: '群成员QQ号（纯数字）' },
              role: { type: 'string', description: '该成员在画面中的角色/位置描述，如"画面中央的主体""左侧的恶魔""右侧的天使"' }
            },
            required: ['qq', 'role'],
            additionalProperties: false
          }
        },
        userImagesRole: {
          type: 'string',
          enum: ['style', 'ignore', 'compose'],
          description: '可选：用户已提供图片（引用/上传）在本次绘图中的作用。style=画风/内容参考（默认）；ignore=忽略用户图，只按成员头像与文字画；compose=用户图内容本身要保留在画面（图生图）。仅在携带 images 且与 references 配合时填写'
        }
      },
      required: ['prompt'],
      additionalProperties: false
    };
    this.progressFetchImpl = progressFetchImpl;
    this.progressReplyFactory = progressReplyFactory;
  }

  async func(rawOpts:unknown, rawEvent:unknown) {
    const opts=parseDrawOptions(rawOpts);const e=parseDrawEvent(rawEvent);
    const { prompt } = opts;
    if (!prompt) return "错误：绘图提示词（prompt）不能为空。";
    const config = this.loadConfig();
    const requestedProvider = this.resolveRequestedProvider(config, opts, e);
    const aspectRatioIntent = this.resolveAspectRatioIntent(opts, e);
    const { provider: _untrustedProvider, ...baseOpts } = opts || {};
    const effectiveOpts:DrawOptions = {
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

  async runDrawJob(job:DrawJob) {
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
        this.logWarn(`[图片队列] 恢复后继续处理队列失败: ${errorText(error)}`);
      }));
    }
  }

  async updateDrawTaskStatus(job:DrawJob, status:string, detail = "") {
    const instance = this.ports.getBridge();
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
      this.logWarn(`[图片队列] 同步任务状态失败: ${errorText(error)}`);
    }
  }

  async clearDrawTaskStatus(job:DrawJob) {
    const instance = this.ports.getBridge();
    if (!instance?.clearUserToolTaskStatus) return;
    try {
      await instance.clearUserToolTaskStatus({
        groupId: job.e?.group_id || "",
        userId: job.requesterId || job.e?.user_id || job.e?.sender?.user_id || "",
        toolName: this.name
      });
    } catch (error) {
      this.logWarn(`[图片队列] 清理任务状态失败: ${errorText(error)}`);
    }
  }

  runNextQueuedDraw(scopeKey:string) {
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

  async markDrawMessageStatus(job:DrawJob, result:unknown) {
    const instance = this.ports.getBridge();
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
      this.logWarn(`[图片队列] 同步消息任务状态失败: ${errorText(error)}`);
    }
  }

  serializeResultError(result:unknown) {
    if (!result) return "";
    if (typeof result === "string") return result;
    return toolRecord(result).error ? String(toolRecord(result).error) : JSON.stringify(result).slice(0, 200);
  }

  createDrawJobId(e:DrawEvent) {
    const groupId = e?.group_id || "private";
    const userId = e?.user_id || e?.sender?.user_id || "unknown";
    const messageId = e?.message_id || randomUUID();
    return `${groupId}:${userId}:${messageId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  }

  getRedis() {
    return this.ports.getRedis();
  }

  getDurableJobKey(jobId:string) {
    return `${DRAW_JOB_PREFIX}${jobId}`;
  }

  getDurableQueueKey(scopeKey:string) {
    return `${DRAW_QUEUE_PREFIX}${scopeKey || "private:unknown"}`;
  }

  getDurableTtlSeconds() {
    return Math.max(DRAW_JOB_TTL_SECONDS, Number(this.ports.getBridge()?.getTaskStatusTtlSeconds?.()) || 0);
  }

  serializeDrawJob(job:DrawJob) {
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

  deserializeDrawJob(record:DrawRecord) {
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

  buildRecoveredEvent(record:DrawRecord) {
    const bot = this.ports.getBot(record.selfId);
    const groupId = record.groupId ? Number(record.groupId) : null;
    const userId = Number(record.userId || record.requesterId || 0) || 0;
    const isGroup = Boolean(groupId);
    const event:DrawEvent = {reply:async()=>{throw new Error("恢复事件未初始化")},
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
        const group = bot?.pickGroup?.(groupId!);
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

  async persistDrawJob(job:DrawJob) {
    const store = this.getRedis();
    if (!store || !job?.id) return;
    try {
      const record = this.serializeDrawJob(job);
      const ttl = this.getDurableTtlSeconds();
      await store.set(this.getDurableJobKey(record.id), JSON.stringify(record), { EX: ttl });
      await this.appendDurableQueue(record.scopeKey, record.id, ttl);
    } catch (error) {
      this.logWarn(`[图片队列] 持久化任务失败，重启后可能无法恢复: ${errorText(error)}`);
    }
  }

  async appendDurableQueue(scopeKey:string, jobId:string, ttl = DRAW_JOB_TTL_SECONDS) {
    const list = await this.readDurableQueue(scopeKey);
    if (!list.includes(jobId)) list.push(jobId);
    await this.writeDurableQueue(scopeKey, list, ttl);
  }

  async readDurableQueue(scopeKey:string) {
    const store = this.getRedis();
    if (!store) return [];
    const raw = await store.get(this.getDurableQueueKey(scopeKey));
    if (!raw) return [];
    try {
      const list:unknown = JSON.parse(raw);
      return Array.isArray(list) ? list.filter((id):id is string=>typeof id==='string'&&Boolean(id)) : [];
    } catch {
      return [];
    }
  }

  async writeDurableQueue(scopeKey:string, list:string[], ttl = DRAW_JOB_TTL_SECONDS) {
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

  async removeDurableDrawJob(job:DrawJob) {
    const store = this.getRedis();
    if (!store || !job?.id) return;
    try {
      await store.del(this.getDurableJobKey(job.id));
      const list = await this.readDurableQueue(job.scopeKey);
      await this.writeDurableQueue(job.scopeKey, list.filter(id => id !== job.id), this.getDurableTtlSeconds());
    } catch (error) {
      this.logWarn(`[图片队列] 清理持久任务失败: ${errorText(error)}`);
    }
  }

  async readDurableDrawJob(jobId:string) {
    const store = this.getRedis();
    if (!store || !jobId) return null;
    const raw = await store.get(this.getDurableJobKey(jobId));
    if (!raw) return null;
    try {
      return parseDrawRecord(JSON.parse(raw));
    } catch {
      await store.del(this.getDurableJobKey(jobId));
      return null;
    }
  }

  async scanRedisKeys(pattern:string) {
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

  async processDurableDrawQueue(scopeKey:string) {
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

  async sendRecoveredNotice(job:DrawJob) {
    try {
      await job.e.reply("刚刚我这边重启了一下，不过这张图我还记着呢。我继续画，出来了会直接发给你。");
    } catch (error) {
      this.logWarn(`[图片队列] 发送恢复提示失败: ${errorText(error)}`);
    }
  }

  async performDraw(opts:DrawOptions, e:DrawEvent, options:{skipProgressNotice?:boolean} = {}) {
    const config = this.loadConfig();
    const { prompt, images: rawImages } = opts;

    // 处理图片
    const rawImageList = this.normalizeArray(rawImages);
    const hasReferenceImages = rawImageList.length > 0;
    const referenceGeneration = hasReferenceImages && isReferenceGeneration(opts);
    const operationLabel = referenceGeneration || !hasReferenceImages ? "图片生成" : "图片编辑";
    const images = await this.ports.normalizeImageUrls(rawImageList);
    const requestedProvider = this.resolveRequestedProvider(config, opts, e);
    let imageGenerationConfigs = this.resolveImageGenerationConfigs(config);
    let imageEditConfigs = this.resolveImageEditConfigs(config);
    const finalPrompt = String(prompt || "").trim();
    const aspectRatioIntent = this.resolveAspectRatioIntent(opts, e);
    const editConfig=toolRecord(config.imageEditAiConfig);
    const apiUrl=String(editConfig.imageEditApiUrl||""),apiKey=String(editConfig.imageEditApiKey||""),model=String(editConfig.imageEditApiModel||"");
    const requestedChatEdit = Boolean(
      requestedProvider &&
      matchesImageProvider(toolRecord(config.imageEditAiConfig), requestedProvider) &&
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
      return { error: `图片生成失败: ${errorText(error)}` };
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
    let progressController:AbortController|null = null;
    if (!options.skipProgressNotice) {
      progressController = new AbortController();
      void Promise.resolve(this.sendProgress(e, {
        config,
        opts,
        hasReferenceImages,
        signal: progressController.signal
      })).catch(error => this.logWarn(`[图片进度提示] 生成或发送异常: ${errorText(error)}`));
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

      const imageUrl = await this.getImageService().chat({ apiUrl, apiKey, model }, finalPrompt, images);

      const processedUrl = this.extractImageUrl(imageUrl);

      if (processedUrl) {
        await this.replyImageToRequester(e, processedUrl, { aspectRatioIntent });
        return referenceGeneration ? '图片生成成功' : '图片编辑成功';
      }
      return { error: `${operationLabel}失败` };
    } catch (error) {
      console.error(`${operationLabel}失败`, error);
      const detail = referenceGeneration
        ? String(errorText(error))
            .replace(/^图片编辑失败[:：]\s*/i, "")
            .replace(/图片编辑通道/g, "外观参考通道")
        : errorText(error);
      return { error: `${operationLabel}失败: ${detail}` };
    } finally {
      progressController?.abort?.();
    }
  }

  cloneDrawOptions(opts:DrawOptions = {}) {
    return {
      ...opts,
      images: Array.isArray(opts.images) ? [...opts.images] : opts.images
    };
  }

  resolveRequestedProvider(config:Record<string,unknown> = {}, opts:DrawOptions = {}, e:Partial<DrawEvent> = {}) {
    const directUserText = [e?.msg, e?.raw_message].filter(Boolean).join("\n");
    const sourceText = directUserText || opts?.prompt || "";
    return resolveRequestedImageProvider(config, sourceText, opts?.provider);
  }

  normalizeParameters(params:unknown = {}, context:{userText?:string;currentIntentText?:string;event?:unknown} = {}) {
    const normalized = super.normalizeParameters(params);
    const directUserText = [
      context?.userText,
      context?.currentIntentText,
      toolRecord(context.event).msg,
      toolRecord(context.event).raw_message
    ].filter(Boolean).join("\n");
    const sourceText = directUserText || String(normalized.prompt || "");
    let config = {};
    try {
      config = this.loadConfig();
    } catch {}
    return normalizeImageProviderParameter(normalized, config, sourceText);
  }

  resolveAspectRatioIntent(opts:DrawOptions = {}, e:Partial<DrawEvent> = {}) {
    const sourceText = [e?.msg, e?.raw_message, opts?.prompt].filter(Boolean).join("\n");
    return resolveImageAspectRatioIntent(sourceText, opts?.aspectRatio);
  }

  getRequesterDisplayName(e:DrawEvent) {
    const card = String(e?.sender?.card || "").trim();
    const nickname = String(e?.sender?.nickname || e?.nickname || "").trim();
    const displayName = !isTransportDisplayName(card) ? card : nickname;
    return String(displayName || e?.user_id || "别人")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 24);
  }

  getDrawScopeKey(e:DrawEvent) {
    if (e?.group_id) return `group:${e.group_id}`;
    return `private:${e?.user_id || e?.sender?.user_id || "unknown"}`;
  }

  getDrawQueueState(scopeKey:string) {
    const key = scopeKey || "private:unknown";
    let queueState = imageGenerationScopes.get(key);
    if (!queueState) {
      queueState = { activeTask: null, queue: [] };
      imageGenerationScopes.set(key, queueState);
    }
    return queueState;
  }

  cleanupDrawQueueState(scopeKey:string, queueState:DrawQueue) {
    if (!queueState.activeTask && !queueState.recovering && queueState.queue.length === 0) {
      imageGenerationScopes.delete(scopeKey);
    }
  }

  async replyQueuedDraw(e:DrawEvent, queueState:DrawQueue) {
    const activeTask = queueState?.activeTask;
    const activeName = activeTask?.requesterName || "别人";
    const sameRequester = activeTask?.requesterId &&
      String(activeTask.requesterId) === String(e?.user_id || e?.sender?.user_id || "");
    const message = sameRequester
      ? "我现在还在帮你上一张画画诶，有点忙不过来了…不过这张我也记住了，等上一张画完就来画这张，好不好~"
      : `我现在正在帮「${activeName}」画画诶，有点忙不过来了…不过我已经记住你的了，等我帮那边画完就来帮你画，好不好~`;
    await e.reply(this.buildQueuedDrawReplyMessage(message, activeTask));
  }

  buildQueuedDrawReplyMessage(message:string, activeTask:Partial<DrawActive>|null = {}) {
    const messageId = activeTask?.messageId;
    if (!messageId) return message;
    const replySegment = this.buildReplySegment(messageId);
    return replySegment ? [replySegment, message] : message;
  }

  buildReplySegment(messageId:DrawId) {
    if (!messageId) return null;
    if(this.ports.segment.reply)return this.ports.segment.reply(messageId);
    return { type: "reply", id: String(messageId), data: { id: String(messageId) } };
  }

  getQueuedFailureMessage(error = "") {
    return buildImageFailureReply(error);
  }

  isErrorResult(result:unknown) {
    if (!result) return false;
    if (typeof result === "string") return /^error[:：]/i.test(result.trim()) || /失败|错误|失敗|錯誤/.test(result);
    return Boolean(toolRecord(result).error);
  }

  logInfo(...args:unknown[]) {this.ports.logger.info(...args)}

  logWarn(...args:unknown[]) {this.ports.logger.warn(...args)}

  logError(...args:unknown[]) {this.ports.logger.error(...args)}

  resolveImageGenerationConfigs(config:Record<string,unknown>) {
    return resolveImageGenerationConfigs(config);
  }

  resolveImageGenerationConfig(config:Record<string,unknown>) {
    return this.resolveImageGenerationConfigs(config)[0] || null;
  }

  resolveImageEditConfigs(config:Record<string,unknown>) {
    return resolveImageEditConfigs(config);
  }

  toImageGenerationUrl(apiUrl = DEFAULT_IMAGE_GENERATION_URL) {
    return toImageGenerationUrl(apiUrl);
  }

  toImageEditUrl(apiUrl = "") {
    return toImageEditUrl(apiUrl);
  }

  getImageService() {
    if(!this.imageService)this.imageService=createImageService(this.ports.imageService)
    return this.imageService
  }

  buildImageGenerationPayload(config:ImageServiceCandidate, prompt:string, format = '') {
    return this.getImageService().buildGenerationPayload(config, prompt, format);
  }

  isImagesEditEndpoint(apiUrl = '') {
    return isImagesEditEndpoint(apiUrl);
  }

  async requestImageEdit(config:ImageServiceCandidate, prompt:string, images:string[], format = '') {
    return this.getImageService().requestEdit(config, prompt, images, format);
  }

  async generateImageEdit(configs:ImageServiceCandidate[], prompt:string, images:string[]) {
    const result = await this.getImageService().run(configs, { operation: 'edit', prompt, images, count: 1 });
    const image = result.images[0];
    if(image===undefined)throw new Error("图片服务未返回产物");
    return image instanceof Uint8Array ? Buffer.from(image) : image;
  }

  async requestImageGeneration(config:ImageServiceCandidate, prompt:string, format = '') {
    return this.getImageService().requestGeneration(config, prompt, format);
  }

  async generateImage(configs:ImageServiceCandidate[]|ImageServiceCandidate, prompt:string) {
    const result = await this.getImageService().run(Array.isArray(configs) ? configs : [configs], { operation: 'generate', prompt, count: 1 });
    const image = result.images[0];
    if(image===undefined)throw new Error("图片服务未返回产物");
    return image instanceof Uint8Array ? Buffer.from(image) : image;
  }

  shouldRetryWithoutUrlResponseFormat(errorMessage = "") {
    return shouldRetryWithoutUrlResponseFormat(errorMessage);
  }

  resolveProgressContext(opts:DrawOptions = {}, hasReferenceImages = false) {
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

  async sendProgress(e:DrawEvent, {config={},opts={},hasReferenceImages=false,signal}:{config?:Record<string,unknown>;opts?:DrawOptions;hasReferenceImages?:boolean;signal?:AbortSignal}={}) {
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
        ...(opts.progressText?{suggestedText:opts.progressText}:{}),
        ...(opts.agentContext?{agentContext:opts.agentContext}:{}),
        fetchImpl: this.progressFetchImpl,
        ...(signal?{signal}:{})
      });
      if (!message || signal?.aborted) {
        reservation.release();
        return false;
      }
      const guardedMessage = this.ports.guardReply(message, this.ports.getBridge()?.config?.personaGuard, {
        userText: e?.msg || "",
        botNames: [e?.bot?.nickname, this.ports.getBridge()?.getPersonaFor?.(e)?.name ?? this.ports.getBridge()?.config?.persona?.name]
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
      this.logWarn(`[图片进度提示] 发送异常: ${errorText(error)}`);
      return false;
    }
  }

  getDoneMessage() {
    return IMAGE_GENERATION_DONE_MESSAGES[
      Math.floor(Math.random() * IMAGE_GENERATION_DONE_MESSAGES.length)
    ];
  }

  buildRequesterAtSegment(e:DrawEvent) {
    const userId = e?.user_id || e?.sender?.user_id;
    if (!userId) return null;
    if (this.ports.segment.at) {
      return this.ports.segment.at(userId);
    }
    return { type: "at", qq: userId };
  }

  async replyImageToRequester(e:DrawEvent, image:unknown, context:{aspectRatioIntent?:ImageAspectRatioIntent|null} = {}) {
    const imageBuffer = await this.ports.resolveImageBuffer(image);
    const metadata = await this.ports.getImageBufferMetadata(imageBuffer);
    if (metadata?.width && metadata?.height) {
      this.logInfo(`[图片产物] requested=${describeImageAspectRatioIntent(context.aspectRatioIntent)} actual=${metadata.width}x${metadata.height} format=${metadata.format || "unknown"}`);
    } else {
      this.logWarn("[图片产物] 无法读取实际宽高，将继续发送原始产物");
    }
    const atSegment = this.buildRequesterAtSegment(e);
    const doneMessage = this.getDoneMessage();
    const attempts = [];

    if (atSegment) {
      attempts.push(() => [atSegment, "\n", doneMessage, "\n", this.ports.segment.image(imageBuffer)]);
    }
    attempts.push(() => [doneMessage, "\n", this.ports.segment.image(imageBuffer)]);
    attempts.push(() => [this.ports.segment.image(imageBuffer)]);

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
        this.logWarn(`[图片发送] 发送尝试失败: ${errorText(error)}`);
      }
    }
    throw new Error(`图片已生成但发送失败: ${lastError ? errorText(lastError) : "未知错误"}`);
  }

  isReplySendFailed(result:unknown) {
    return this.ports.isMessageSendFailed(result);
  }

  formatReplySendFailure(result:unknown) {
    return this.ports.formatMessageSendFailure(result);
  }

  async fetchWithTimeout(url:string, options:RequestInit = {}, timeoutMs = IMAGE_GENERATION_TIMEOUT_MS) {
    return this.getImageService().timedFetch(url, options, timeoutMs);
  }

  // 加载配置
  loadConfig() {
    const configPath = path.join(process.cwd(), 'plugins/shiloh-plugin/config/message.yaml');
    return toolRecord(toolRecord(YAML.parse(fs.readFileSync(configPath, 'utf8'))).pluginSettings);
  }

  // 数组标准化
  normalizeArray(input:unknown) {
    if (Array.isArray(input)) return input.filter((item):item is string=>typeof item==='string');
    return typeof input === 'string' ? [input] : [];
  }

  async parseImageGenerationResponse(response:Response) {
    return this.getImageService().parseResponse(response);
  }

  // 提取图片URL
  extractImageUrl(content:unknown) {
    return extractImageResult(content);
  }

  /**
   * 调用OneBotv11 API
   */
  async callApi(action:string,params:Record<string,unknown>={}) {
    const bot=this.ports.getBot();if(!bot?.sendApi)throw new Error('找不到OneBotv11 API调用接口');return bot.sendApi(action,params)
  }

  async getRKey(url:string) {
    // 检查URL是否包含rkey参数
    const rkeyMatch = url.match(/rkey=([^&]+)/);
    if (!rkeyMatch) return null;

    try {
      const response=toolRecord(await this.callApi('nc_get_rkey'));
      const data=Array.isArray(response.data)?response.data:[];
      if (response?.status === 'ok' && data.length >= 2) {
        // 取数组中第二个元素的rkey，去掉开头的"&rkey="
        const rkeyValue=String(toolRecord(data[1]).rkey || "");
        return rkeyValue.replace(/^&rkey=/, '');
      }
    } catch (error) {
      console.error('获取rkey失败:', error);
    }

    // 如果接口调用失败，返回原始rkey
    return rkeyMatch[1];
  }

  // 处理图片URL（腾讯图床等）
  async processImageUrl(url:string) {
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
  async isUrlAvailable(url:string){return this.ports.isUrlAvailable(url)}

  async getZaiKey() {
    const res = await fetch('http://localhost:9223/token');
    return String(toolRecord(await res.json()).token || '');
  }
}
