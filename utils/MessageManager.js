import { dependencies } from '../dependence/dependencies.js';
const { axios, moment } = dependencies;
import schedule from 'node-schedule';
import { refreshTencentImageUrl } from './fileUtils.js';
import { enrichBilibiliMessageSegments, formatBilibiliHistoryLinks, formatBilibiliHistoryText } from './bilibiliMessage.js';
import { enrichDouyinMessageSegments, formatDouyinHistoryLinks, formatDouyinHistoryText } from './douyinMessage.js';
import { KeyedSerialQueue } from './messagePipeline/keyedSerialQueue.js';

import { createMessageManagerClass } from '../dist/backend/modules/messaging/application/recentMessages.js'
const recentMessageWriteQueue = new KeyedSerialQueue()
export const MessageManager = createMessageManagerClass({
 redis: {
  get: (...args) => globalThis.redis.get(...args), set: (...args) => globalThis.redis.set(...args),
  del: (...args) => globalThis.redis.del(...args), keys: (...args) => globalThis.redis.keys(...args),
  get scanIterator() { return globalThis.redis?.scanIterator?.bind(globalThis.redis) },
  get scan() { return globalThis.redis?.scan?.bind(globalThis.redis) }
 },
 bot: { get uin() { return globalThis.Bot?.uin }, get nickname() { return globalThis.Bot?.nickname } },
 logger: { info: message => globalThis.logger?.info?.(message), warn: message => globalThis.logger?.warn?.(message), error: message => globalThis.logger?.error?.(message) },
 queue: recentMessageWriteQueue, scheduleJob: (...args) => schedule.scheduleJob(...args),
 getUrl: url => axios.get(url), formatTime: time => moment(time).format('YYYY-MM-DD HH:mm:ss'), parseTime: time => Number(moment(time, 'MM-DD HH:mm:ss')),
 refreshTencentImageUrl, enrichBilibiliMessageSegments, enrichDouyinMessageSegments,
 formatBilibiliHistoryText, formatBilibiliHistoryLinks, formatDouyinHistoryText, formatDouyinHistoryLinks
})
