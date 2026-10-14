import {AbstractTool} from './AbstractTool.js';
import fs from 'node:fs';import path from 'node:path';import YAML from 'yaml';
import {safeTruncateUnicode} from '../../models/domain/unicodeText.js';
import {resolveChatCompletionUrl} from '../../models/domain/chatCompletionUrl.js';
import {reserveProgressReply} from '../../conversation/domain/progressReplyBudget.js';
import type {AnalysisPorts} from './GoogleAnalysisTool.js';
import type {DrawEvent,DrawOptions} from '../../../contracts/bananaTool.js';
import {parseDrawEvent,parseDrawOptions} from './bananaDecoders.js';
import {pixivRecord as record,pixivText as text} from '../../../contracts/pixiv.js';
interface SearchResponse {ok:boolean;status:number;json():Promise<unknown>}
type SearchFetch=(url:string,init:{method:string;headers:Record<string,string>;body:string;signal:AbortSignal})=>Promise<SearchResponse>;
export interface SearchInformationOptions {fetchImpl?:SearchFetch;progressFetchImpl?:typeof globalThis.fetch;progressDelayMs?:number;configLoader?:()=>unknown;progressReplyFactory?:AnalysisPorts['progressReplyFactory']}
export function createSearchInformationTool(ports:{totalTokens(text:string):Promise<{completion_tokens:number}>;progressReplyFactory:AnalysisPorts['progressReplyFactory'];debug(message:string):void}){
const TotalTokens=ports.totalTokens,generateContextualProgressReply=ports.progressReplyFactory;
/**
 * Search 工具类，用于自由搜索并控制返回结果的大小
 */
class SearchInformationTool extends AbstractTool {
maxTokens:number;fetchImpl:SearchFetch;progressFetchImpl:typeof globalThis.fetch;progressDelayMs:number;configLoader:(()=>unknown)|undefined;progressReplyFactory:AnalysisPorts['progressReplyFactory'];
  // 代理 fetch 缓存:同一 proxyUrl 复用 ProxyAgent;undici 的 fetch 与 ProxyAgent 成对使用
  static proxyFetchCache = new Map<string,SearchFetch>()

  async getProxyFetch(proxyUrl:string) {
    if (!/^https?:\/\//i.test(proxyUrl)) throw new Error(`searchApiProxy 配置不合法: ${proxyUrl}`)
    const cached = SearchInformationTool.proxyFetchCache.get(proxyUrl)
    if (cached) return cached
    const { fetch: undiciFetch, ProxyAgent } = await import("undici")
    const agent = new ProxyAgent(proxyUrl)
    const wrapped:SearchFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: agent })
    SearchInformationTool.proxyFetchCache.set(proxyUrl, wrapped)
    return wrapped
  }

  constructor({
    fetchImpl = globalThis.fetch,
    progressFetchImpl = globalThis.fetch,
    progressDelayMs = 2500,
    configLoader,
    progressReplyFactory = generateContextualProgressReply
  }:SearchInformationOptions = {}) {
    super();
    this.name = 'searchInformationTool';
    this.description = '请求外部 API 进行自由搜索，检索结果，对于需要进行搜索或需要实时数据信息的时候使用，总结群聊聊天记录时无需调用';
    this.parameters = {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: '搜索的查询关键词'
        },
        progressText: {
          type: 'string',
          description: '可选：根据当前对话生成一句自然的搜索中途接话；不能编造结果或完成时间，不要使用客服腔'
        }
      },
      required: ['query']
    };

    // 固定最大 token 数量为 30000
    this.maxTokens = 30000;
    this.fetchImpl = fetchImpl;
    this.progressFetchImpl = progressFetchImpl;
    this.progressDelayMs = Math.max(500, Number(progressDelayMs) || 2500);
    this.configLoader = configLoader;
    this.progressReplyFactory = progressReplyFactory;
  }

  loadConfig() {
    if (typeof this.configLoader === 'function') return record(this.configLoader());
    const configPath = path.join(process.cwd(), 'plugins/shiloh-plugin/config/message.yaml');
    return record(record(YAML.parse(fs.readFileSync(configPath, 'utf8'))).pluginSettings);
  }

  async sendContextualProgress({ config, opts, e, query, signal, isActive }:{config:Record<string,unknown>;opts:DrawOptions;e:DrawEvent;query:string;signal:AbortSignal;isActive:()=>boolean}) {
    const reservation = reserveProgressReply(e)
    if (!reservation) return
    let deliveryAttempted=false;
    try {
      const text = await this.progressReplyFactory({
        config,
        taskType: '联网查询',
        userText: e?.msg || e?.raw_message || query,
        stage: '查询请求已经发出，正在等待可靠结果',
        suggestedText: opts?.progressText,
        agentContext: opts?.agentContext,
        fetchImpl: this.progressFetchImpl,
        signal
      });
      if (!text || !isActive() || signal?.aborted) {
        reservation.release()
        return
      }
      deliveryAttempted=true;await e.reply(text);
      reservation.commit()
    } catch (error) {
      if(deliveryAttempted)reservation.commit();else reservation.release()
      ports.debug(`[搜索进度] 生成或发送失败: ${record(error).name || 'Error'}`);
    }
  }

  /**
   * 截断文本以控制 token 数量
   * @param {string} text - 需要截断的文本
   * @returns {Promise<string>} 截断后的文本
   */
  async truncateText(text:string) {
    if (!text) return '未找到相关搜索结果';

    const tokens = await TotalTokens(text);

    if (tokens.completion_tokens <= this.maxTokens) {
      return text;
    }

    // 如果超出限制，按比例截断文本
    const ratio = this.maxTokens / tokens.completion_tokens;
    const truncatedLength = Math.floor(text.length * ratio);
    const truncated = safeTruncateUnicode(text, truncatedLength);

    return `${truncated}\n\n[注意：结果已截断，显示内容已达到长度限制]`;
  }

  /**
   * 将各种格式的结果转换为字符串
   * @param {any} result - 任意类型的结果
   * @returns {string} 转换后的字符串
   */
  resultToString(result:unknown) {
    // logger.error('result', result)
    if (typeof result === 'string') {
      return result;
    }

    if (result === null || result === undefined) {
      return '未找到相关搜索结果';
    }

    if (typeof result === 'object') {
      const value=record(result);
      // 处理常见的结果格式
      if (value.content) {
        return String(value.content);
      }
      if (value.results && Array.isArray(value.results)) {
        return value.results.map((item, index) => {
          if (typeof item === 'string') {
            return `${index + 1}. ${item}`;
          }
          if (record(item).title && record(item).content) {
            return `${index + 1}. ${record(item).title}\n${record(item).content}`;
          }
          return `${index + 1}. ${JSON.stringify(item)}`;
        }).join('\n\n');
      }
      const webPages=record(record(value.data).webPages).value;
      if (Array.isArray(webPages)) {
        return webPages.map((item, index) => {
          if (typeof record(item).snippet === 'string') {
            return `${index + 1}. ${record(item).snippet}`;
          }
          return `${index + 1}. ${JSON.stringify(item)}`;
        }).join('\n\n');
      }
      if (value.message) {
        return String(value.message);
      }
    }

    // 最后的兜底方案
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  /**
   * 处理搜索操作并返回字符串结果
   * @param {Object} opts - 参数选项
   * @param {Object} e - 事件对象
   * @returns {Promise<string>} 字符串形式的搜索结果
   */
  async func(input:Record<string,unknown>, event:unknown) {
    const opts=parseDrawOptions(input),rawEvent=record(event),canReply=typeof rawEvent.reply==='function',e=canReply?parseDrawEvent(event):parseDrawEvent({...rawEvent,reply:async()=>undefined}),query=text(opts.query);

    if (!query?.trim()) {
      return '搜索失败：搜索关键词不能为空';
    }

    let progressTimer:ReturnType<typeof setTimeout>|null = null;
    let controller:AbortController|null = null;
    let requestTimeout:ReturnType<typeof setTimeout>|null = null;
    let completed = false;
    let progressController:AbortController|null = null;
    let timeoutMs = 20000;
    try {
      const config = this.loadConfig();
      
      const apiUrl = resolveChatCompletionUrl(text(record(config.searchAiConfig).searchApiUrl) || 'https://api.openai.com/v1/chat/completions')
      const apiKey = record(config.searchAiConfig).searchApiKey || 'sk-xxxxxx'
      // 搜索后端域名被墙/DNS污染时,可配 searchApiProxy: http://127.0.0.1:7890 走本地代理
      const proxyUrl = String(record(config.searchAiConfig).searchApiProxy || "").trim()
      const proxyFetch = proxyUrl ? await this.getProxyFetch(proxyUrl) : null

      const requestData = { "model": record(config.searchAiConfig).searchApiModel || 'deepseek-r1-search', "messages": [{ "role": "user", "content": query }], "temperature": 1, "top_p": 0.1 }
      timeoutMs = Math.max(3000, Number(record(config.searchAiConfig).timeoutMs) || 20000)
      controller = new AbortController()
      requestTimeout = setTimeout(() => controller?.abort(), timeoutMs)
      if(canReply)progressTimer = setTimeout(() => {
        progressController = new AbortController()
        void this.sendContextualProgress({
          config,
          opts,
          e,
          query,
          signal: progressController.signal,
          isActive: () => !completed
        })
      }, this.progressDelayMs)

      const response = await (proxyFetch || this.fetchImpl)(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestData),
        signal: controller.signal
      })
      clearTimeout(requestTimeout)

      // 非 JSON 响应体(如网关 HTML)不应顶替真实状态码;4xx/5xx 时透传上游 error.message(如配额不足)供最终回复如实说明
      const analysis = record(await response.json().catch(() => null))
      if (!response.ok) {
        const upstream = typeof record(analysis.error).message === 'string' ? `：${text(record(analysis.error).message).slice(0, 200)}` : ''
        throw new Error(`搜索服务返回 ${response.status}${upstream}`)
      }
      const content = record(record(Array.isArray(analysis.choices)?analysis.choices[0]:null).message).content
      if (typeof content!=='string'||!content.trim()) throw new Error('搜索服务没有返回可用结果')
      return content + '\n\n提示：如果用户想基于搜索结果制作文件，可以使用 aiMindMapTool 工具继续操作。'

    } catch (error) {
      console.error('搜索过程发生错误:', error);
      const message = record(error).name === 'AbortError' ? `搜索超过 ${Math.ceil(timeoutMs / 1000)} 秒仍未返回` : (error instanceof Error?error.message:'发生未知错误')
      return `搜索失败：${message}`;
    } finally {
      completed = true
      if (progressTimer) clearTimeout(progressTimer)
      if (requestTimeout) clearTimeout(requestTimeout)
      const pending:unknown=progressController;if(pending instanceof AbortController)pending.abort()
      controller?.abort?.()
    }
  }
}

return SearchInformationTool;
}
