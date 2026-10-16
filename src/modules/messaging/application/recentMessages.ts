import { resolveMessageCacheTtlSeconds } from '../domain/messageCacheTtl.js'
import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'
import type { RecentMessagePorts, RecentOptions, Segment, Sender, MessageEvent, StoredMessage } from '../../../contracts/recentMessages.js'
import {parseSentPersonaSource} from '../../conversation/domain/personaProvenance.js'
import {findForwardCompleteness, parseForwardCompleteness} from '../../conversation/domain/forwardCompleteness.js'

function parseStoredMessages(value: unknown): StoredMessage[] {
 if (!Array.isArray(value)) throw new Error('消息历史格式无效')
 const object = (item: unknown): Record<string, unknown> | null => item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string,unknown> : null
 return value.map(value => {
  const item = object(value), sender = object(item?.sender)
  if (!item || typeof item.time !== 'string' || typeof item.content !== 'string' || !sender) throw new Error('消息历史条目格式无效')
  for (const field of ['nickname','card','role','title','identity']) if (sender[field] !== undefined && typeof sender[field] !== 'string') throw new Error('消息历史发送者格式无效')
  if (sender.user_id !== undefined && typeof sender.user_id !== 'number' && typeof sender.user_id !== 'string') throw new Error('消息历史发送者格式无效')
  if (item.group_name !== undefined && item.group_name !== null && typeof item.group_name !== 'string') throw new Error('消息历史群名称格式无效')
  const personaSource = parseSentPersonaSource(item.personaSource, item.source, sender.user_id)
  const forwardCompleteness = parseForwardCompleteness(item.forwardCompleteness) || findForwardCompleteness(item.message, item.forward_context)
  const {personaSource: _unverifiedSource, forwardCompleteness: _unverifiedCompleteness, ...record} = item
  return {...record, ...(personaSource ? {personaSource} : {}), ...(forwardCompleteness ? {forwardCompleteness} : {})} as StoredMessage
 })
}

export function createMessageManagerClass(ports: RecentMessagePorts) {
const { redis: redisClient, bot: botIdentity, logger, refreshTencentImageUrl, enrichBilibiliMessageSegments, enrichDouyinMessageSegments, formatBilibiliHistoryText, formatBilibiliHistoryLinks, formatDouyinHistoryText, formatDouyinHistoryLinks, queue: recentMessageWriteQueue } = ports
return class MessageManager {
 PRIVATE_MAX_MESSAGES: number; GROUP_MAX_MESSAGES: number; MESSAGE_MAX_LENGTH: number
 CACHE_EXPIRE_SECONDS = 3600; CACHE_EXPIRE_DAYS = 1 / 24; REDIS_KEY_PREFIX: string
  /**
   * 初始化消息管理器
   * @param {Object} options 配置选项
   * @param {number} [options.privateMaxMessages=20] 私聊消息上限
   * @param {number} [options.groupMaxMessages=35] 群聊消息上限 
   * @param {number} [options.messageMaxLength=200] 单条消息最大长度
   * @param {number} [options.cacheExpireSeconds] 缓存过期时间（秒，优先级最高）
   * @param {number} [options.cacheExpireMinutes] 缓存过期时间（分钟）
   * @param {number} [options.cacheExpireDays] 旧版缓存过期时间（天）
   */
  constructor(options: RecentOptions = {}) {
    // 可配置参数
    this.PRIVATE_MAX_MESSAGES = options.privateMaxMessages || 20;  // 私聊消息上限
    this.GROUP_MAX_MESSAGES = options.groupMaxMessages || 100;      // 群聊消息上限(可由用户配置)
    this.MESSAGE_MAX_LENGTH = options.messageMaxLength || 200;     // 单条消息最大长度（不计图片/文件链接）
    this.setCacheExpire(options);

    // 固定参数
    this.REDIS_KEY_PREFIX = 'ytbot:messages:';                     // Redis key前缀

    // 初始化定时任务
    // this.initScheduledTasks();
  }

  /**
   * 统一使用秒保存 Redis TTL。旧的天级配置仍可读取，避免外部调用方升级后失效。
   */
  setCacheExpire(options: RecentOptions = {}) {
    this.CACHE_EXPIRE_SECONDS = resolveMessageCacheTtlSeconds(options);
    // 兼容可能读取该公开字段的旧插件；实际写 Redis 时只使用秒级字段。
    this.CACHE_EXPIRE_DAYS = this.CACHE_EXPIRE_SECONDS / (24 * 60 * 60);
  }

  /**
   * 初始化定时任务
   */
  initScheduledTasks() {
    // 设置每天晚上0点执行的定时任务
    ports.scheduleJob('0 0 * * *', async () => {
      try {
        logger.info('开始执行消息历史记录清理定时任务');
        await this.clearAllMessages();
        logger.info('消息历史记录清理完成');
      } catch (error) {
        logger.error(`定时清理消息历史记录失败: ${error}`);
      }
    });
  }

  /**
   * 清除所有消息历史记录
   * @returns {Promise<void>}
   */
  async scanRedisKeys(pattern: string): Promise<string[]> {
    try {
      if (typeof redisClient.scanIterator === "function") {
        const keys = [];
        for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 200 })) {
          if (Array.isArray(key)) keys.push(...key);
          else keys.push(key);
        }
        return keys;
      }

      if (typeof redisClient.scan === "function") {
        const keys = [];
        let cursor = "0";
        do {
          const [nextCursor, batch = []] = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 200);
          cursor = String(nextCursor);
          keys.push(...batch);
        } while (cursor !== "0");
        return keys;
      }
    } catch (error) {
      logger.warn(`[MessageManager] SCAN 扫描失败，回退使用 KEYS：${pattern}，原因：${error instanceof Error ? error.message : String(error)}`);
    }

    return await redisClient.keys(pattern);
  }

  async deleteRedisKeys(keys: string[] = []) {
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200).filter(Boolean);
      if (chunk.length) {
        await redisClient.del(...chunk);
      }
    }
  }

  async clearAllMessages() {
    try {
      // 获取所有以消息前缀开头的键
      const keys = await this.scanRedisKeys(`${this.REDIS_KEY_PREFIX}*`);
      if (keys && keys.length > 0) {
        // 批量删除所有消息记录
        await this.deleteRedisKeys(keys);
        logger.info(`已清除${keys.length}条消息历史记录`);
      } else {
        logger.info('没有需要清除的消息历史记录');
      }
    } catch (error) {
      logger.error(`清除所有消息历史失败: ${error}`);
      throw error;
    }
  }

  /**
   * 获取图片URL
   * @param {Array} message 消息数组
   * @returns {Promise<string|null>} 处理后的图片URL
   */
  async getImageUrl(message: Segment[]) {
    for (const { type, url, fid } of message) {
      if ((type === "image" || type === "file") && url) {
        return await refreshTencentImageUrl(url, fid);
      }
    }
    return null;
  }

  /**
   * 检查URL是否可用
   * @param {string} url 需要检查的URL
   * @returns {Promise<boolean>} URL是否可用
   */
  async isUrlAvailable(url: string) {
    try {
      const response = await ports.getUrl(url);
      const contentType = response.headers['content-type'];
      return !contentType || !contentType.includes('application/json');
    } catch (error) {
      return false;
    }
  }

  /**
   * 从URL中提取rkey参数
   * @param {string} url 包含rkey的URL
   * @returns {string|null} 提取的rkey值
   */
  getRKey(url: string) {
    const rkeyParam = 'rkey=';
    const rkeyStartIndex = url.indexOf(rkeyParam);
    if (rkeyStartIndex === -1) return null;
    const actualStartIndex = rkeyStartIndex + rkeyParam.length;
    const rkeyEndIndex = url.indexOf('&', actualStartIndex);
    return rkeyEndIndex === -1
      ? url.substring(actualStartIndex)
      : url.substring(actualStartIndex, rkeyEndIndex);
  }

  /**
   * 从URL中提取域名部分
   * @param {string} url 完整URL
   * @returns {string} 提取的域名部分
   */
  extractDomain(url: string) {
    const ampIndex = url.indexOf('&');
    return ampIndex !== -1 ? url.slice(0, ampIndex) : url;
  }

  /**
   * 获取文件URL
   * @param {Object} e 事件对象
   * @param {string} type 类型(group/friend)
   * @returns {Promise<string|null>} 文件URL
   */
  async getFileUrl(e: MessageEvent, type: string) {
    const fileSegment = Array.isArray(e?.message) ? e.message.find(item => item?.type === 'file') : null;
    if (fileSegment) {
      const { fid, url } = fileSegment;
      if (url) return url;
      if (fid) {
        return type === 'group'
          ? await e.group?.getFileUrl(fid)
          : await e.friend?.getFileUrl(fid);
      }
    }
    return null;
  }

  /**
   * 获取发送者的身份标识
   * @param {Object} sender 发送者信息
   * @param {boolean} isGroup 是否群聊
   * @returns {string} 身份标识文本
   */
  getSenderTitle(sender: Sender, isGroup: boolean) {
    if (!isGroup) return '';

    const titles = [];
    if (sender.role === 'owner') {
      titles.push('群主');
    }
    else if (sender.role === 'admin') {
      titles.push('管理员');
    }
    if (sender.title) {
      titles.push(sender.title);
    }

    return titles.length ? `[${titles.join('/')}]` : '';
  }

  /**
 * 格式化消息内容
 * 图片/文件的链接长度不计入总长度
 * @param {Object} message 消息对象
 * @returns {Promise<string>} 格式化后的消息内容
 */
  async formatMessageContent(message: MessageEvent) {
    const isGroup = message.message_type === 'group';
    let content = '';
    let totalLength = 0;

    if (Array.isArray(message.message)) {
      for (const msg of message.message) {
        let action = '';
        let urlPart = '';
        switch (msg.type) {
          case 'text':
            action = `在${isGroup ? '群里' : '私聊'}说: ${msg.text}`;
            break;
          case 'image': {
            const url = await this.getImageUrl([msg]);
            action = `发送了一张图片`;
            urlPart = url ? ` [${url}]` : '';
            break;
          }
          case 'file': {
            const url = await this.getFileUrl(message, isGroup ? 'group' : 'private');
            const fileSize = msg.size ? `(${(msg.size / 1024 / 1024).toFixed(2)}MB)` : '';
            action = `发送了文件: ${msg.name || '未知文件'}${fileSize}`;
            urlPart = url ? ` [${url}]` : '';
            break;
          }
          case 'face':
            action = `发送了表情 [${msg.text || msg.id}]`;
            break;
          case 'at':
            action = `艾特了 ${msg.text || msg.qq || '某人'}`;
            break;
          case 'video':
            action = '发送了一个视频';
            urlPart = msg.url ? ` [视频:${msg.url}]` : '';
            break;
          case 'record':
            action = '发送了一条语音';
            break;
          case 'share':
            action = `分享了链接: ${msg.title || msg.url}`;
            break;
          case 'reply':
            action = `回复了消息`;
            break;
          case 'forward':
            action = '转发了消息';
            break;
          case 'forward_context':
            action = `转发记录内容: ${msg.text || ''}`;
            break;
          case 'bface':
            action = '发送了qq表情包';
            break;
          case 'xml':
          case 'json':
            action = '发送了卡片消息';
            break;
          case 'bilibili':
            action = formatBilibiliHistoryText(msg);
            urlPart = formatBilibiliHistoryLinks(msg);
            if (urlPart) urlPart = ` [${urlPart}]`;
            break;
          case 'douyin':
            action = formatDouyinHistoryText(msg);
            urlPart = formatDouyinHistoryLinks(msg);
            if (urlPart) urlPart = ` [${urlPart}]`;
            break;
          default:
            action = `发送了 ${msg.type} 类型消息`;
        }

        // 计算不包含URL的部分长度
        const actionLength = action.length;
        const separatorLength = content.length > 0 ? 1 : 0;

        // 修改：如果超出最大长度，截断而不是直接变成 ...
        if (totalLength + separatorLength + actionLength > this.MESSAGE_MAX_LENGTH) {
          const remainingLength = this.MESSAGE_MAX_LENGTH - totalLength - separatorLength - 3; // 3 是 "..." 的长度

          if (remainingLength > 10) {
            // 还有足够空间，截断当前消息
            if (separatorLength) {
              content += '，';
            }
            content += safeTruncateUnicode(action, remainingLength, '...');
          } else if (content.length === 0) {
            // 第一条消息就超长，直接截断
            content = safeTruncateUnicode(action, this.MESSAGE_MAX_LENGTH - 3, '...');
          } else {
            content += '...';
          }
          break;
        }

        // 添加分隔符
        if (separatorLength) {
          content += '，';
        }

        // 添加动作描述
        content += action;
        totalLength += separatorLength + actionLength;

        // 添加URL部分，不计入总长度
        if (urlPart) {
          content += urlPart;
        }
      }
    } else {
      let action = `说: ${message.raw_message || '未知消息'}`;
      // 如果有URL，需要将其分离
      const urlMatch = action.match(/\[.*?\]/);
      let urlPart = '';
      if (urlMatch) {
        urlPart = urlMatch[0];
        action = action.replace(urlPart, '');
      }

      if (action.length > this.MESSAGE_MAX_LENGTH) {
        content = safeTruncateUnicode(action, this.MESSAGE_MAX_LENGTH - 3, '...');
      } else {
        content = action;
      }

      if (urlPart) {
        content += urlPart;
      }
    }

    return content;
  }


  /**
   * 格式化单条消息记录
   * @param {Object} message 消息对象
   * @returns {Promise<Object>} 格式化后的消息对象
   */
  async formatMessage(message: MessageEvent & {sender: Sender}, options: RecentOptions = {}) {
    const isGroup = message.message_type === 'group';
    const isBot = message.sender.user_id === botIdentity.uin;
    const personaSource = parseSentPersonaSource(message.personaSource, message.source, message.sender.user_id);
    const enrichedMessage = Array.isArray(options.preEnrichedMessage)
      ? options.preEnrichedMessage
      : await enrichDouyinMessageSegments(
        await enrichBilibiliMessageSegments(message.message, message.raw_message),
        message.raw_message
      );
    const formattedMessage = { ...message, message: enrichedMessage };
    const forwardCompleteness = findForwardCompleteness(enrichedMessage, message.forward_context);

    return {
      time: ports.formatTime(message.time * 1000),
      // Keep an unambiguous clock for short-lived physical observations. The
      // display timestamp can be local and must not authorize current state.
      at: message.time * 1000,
      sender: {
        user_id: message.sender.user_id,
        nickname: isBot ? botIdentity.nickname : (message.sender.card || message.sender.nickname),
        role: isBot ? 'bot' : message.sender.role,
        title: message.sender.title,
        level: message.sender.level,
        identity: isBot ? '[Bot]' : this.getSenderTitle(message.sender, isGroup)  // 为 bot 添加标识
      },
      content: await this.formatMessageContent(formattedMessage),
      event_id: message.event_id || null,
      message_id: message.message_id,
      ...(message.self_id !== undefined ? { self_id: message.self_id } : {}),
      message_type: message.message_type,
      source: message.source || null,
      ...(personaSource ? {personaSource} : {}),
      ...(forwardCompleteness ? {forwardCompleteness} : {}),
      group_id: isGroup ? message.group_id : null,
      group_name: isGroup ? message.group_name : null,
      message: enrichedMessage,
      raw_message: message.raw_message
    };
  }

  /**
   * 获取Redis键名
   * @param {string} type 消息类型 (private/group)
   * @param {number} id 用户ID或群ID
   * @returns {string} Redis键名
   */
  getRedisKey(type: string, id: unknown) {
    return `${this.REDIS_KEY_PREFIX}${type}:${id}`;
  }

  /**
   * 记录新消息
   * @param {Object} e 事件对象
   * @param {Object} options 可选参数
   * @param {number} [options.groupMaxMessages] 自定义群聊消息上限
   * @returns {Promise<void>}
   */
  async recordMessage(e: MessageEvent, options: RecentOptions = {}) {
    try {
      const event = {
        ...e,
        sender: e.sender || {
          user_id: botIdentity.uin,
          nickname: botIdentity.nickname,
          role: 'bot'
        }
      };
      const isGroup = event.message_type === 'group';
      const id = isGroup ? event.group_id : event.sender.user_id;
      const type = isGroup ? 'group' : 'private';
      const redisKey = this.getRedisKey(type, id);

      return await recentMessageWriteQueue.run(redisKey, async () => {
        let messages = await this.getMessages(type, id, { throwOnError: true });
        const formatted = await this.formatMessage(event, options);
        const existingIndex = messages.findIndex(item => {
          if (formatted.event_id) return String(item.event_id || '') === String(formatted.event_id)
          return formatted.message_id !== undefined
            && formatted.message_id !== null
            && formatted.message_id !== ''
            && String(item.message_id || '') === String(formatted.message_id)
        });
        if (existingIndex >= 0) messages[existingIndex] = formatted;
        else messages.unshift(formatted);

        const maxMessages = isGroup
          ? (options.groupMaxMessages || this.GROUP_MAX_MESSAGES)
          : this.PRIVATE_MAX_MESSAGES;

        if (messages.length > maxMessages) messages = messages.slice(0, maxMessages);
        await redisClient.set(redisKey, JSON.stringify(messages), { EX: this.CACHE_EXPIRE_SECONDS });
        return formatted;
      });
    } catch (error) {
      logger.error(`记录消息失败: ${error}`);
      if (options.throwOnError) throw error;
      return null;
    }
  }

  /**
   * 获取消息历史
   * @param {string} type 消息类型 (private/group)
   * @param {number} id 用户ID或群ID
   * @returns {Promise<Array>} 消息历史数组
   */
  async getMessages(type: string, id: unknown, options: RecentOptions = {}): Promise<StoredMessage[]> {
    try {
      const redisKey = this.getRedisKey(type, id);
      const data = await redisClient.get(redisKey);
      const messages = data ? parseStoredMessages(JSON.parse(data)) : [];
      // 按时间戳倒序排序
      return messages.sort((a, b) => {
        const timeA = ports.parseTime(a.time);
        const timeB = ports.parseTime(b.time);
        return timeB - timeA; // 倒序排列
      });
    } catch (error) {
      logger.error(`获取消息历史失败: ${error}`);
      if (options.throwOnError) throw error;
      return [];
    }
  }

  /**
   * 清除指定对象的消息历史
   * @param {string} type 消息类型 (private/group)
   * @param {number} id 用户ID或群ID
   * @returns {Promise<void>}
   */
  async clearMessages(type: string, id: unknown) {
    try {
      const redisKey = this.getRedisKey(type, id);
      await redisClient.del(redisKey);
      logger.info(`已清除${type}:${id}的消息历史记录`);
    } catch (error) {
      logger.error(`清除消息历史失败: ${error}`);
    }
  }

  /**
   * 格式化消息历史为可读字符串
   * @param {string} type 消息类型 (private/group)
   * @param {number} id 用户ID或群ID
   * @param {number} limit 限制返回的消息数量
   * @returns {Promise<string>} 格式化后的消息历史文本
   */
  async formatMessageHistory(type: string, id: unknown, limit: number | null = null) {
    try {
      let messages = await this.getMessages(type, id);

      if (messages.length === 0) {
        return '暂无消息记录';
      }

      // 如果指定了限制，直接取最新的几条
      if (limit) {
        messages = messages.slice(0, limit); // 因为已经倒序，所以直接从头开始取
      }

      const title = type === 'group'
        ? `群${messages[0]!.group_name}(${id})的聊天记录`
        : `与${messages[0]!.sender.nickname}(${id})的私聊记录`;

      let output = `=== ${title} ===\n`;
      output += '最新消息在上方\n';
      output += '==================\n\n';

      // 直接遍历即可，因为已经排序
      messages.forEach(msg => {
        const identity = msg.sender.identity ? `${msg.sender.identity} ` : '';
        output += `[${msg.time}] ${identity}${msg.sender.nickname}(${msg.sender.user_id}) ${msg.content}\n`;
      });

      return output;
    } catch (error) {
      logger.error(`格式化消息历史失败: ${error}`);
      return '获取消息记录失败';
    }
  }
}

}
