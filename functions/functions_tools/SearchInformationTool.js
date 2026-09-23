import { AbstractTool } from './AbstractTool.js';
import { TotalTokens } from "../../functions/tools/CalculateToken.js";
import fs from "fs";
import YAML from "yaml";
import path from "path";
import { safeTruncateUnicode } from "../../utils/unicodeText.js";
import { resolveChatCompletionUrl } from "../../utils/chatCompletionUrl.js";
import { generateContextualProgressReply } from "../../utils/contextualProgressReply.js";
import { reserveProgressReply } from "../../utils/progressReplyBudget.js";
/**
 * Search 工具类，用于自由搜索并控制返回结果的大小
 */
export class SearchInformationTool extends AbstractTool {
  // 代理 fetch 缓存:同一 proxyUrl 复用 ProxyAgent;undici 的 fetch 与 ProxyAgent 成对使用
  static proxyFetchCache = new Map()

  async getProxyFetch(proxyUrl) {
    if (!/^https?:\/\//i.test(proxyUrl)) throw new Error(`searchApiProxy 配置不合法: ${proxyUrl}`)
    const cached = SearchInformationTool.proxyFetchCache.get(proxyUrl)
    if (cached) return cached
    const { fetch: undiciFetch, ProxyAgent } = await import("undici")
    const agent = new ProxyAgent(proxyUrl)
    const wrapped = (url, init) => undiciFetch(url, { ...init, dispatcher: agent })
    SearchInformationTool.proxyFetchCache.set(proxyUrl, wrapped)
    return wrapped
  }

  constructor({
    fetchImpl = globalThis.fetch,
    progressFetchImpl = globalThis.fetch,
    progressDelayMs = 2500,
    configLoader,
    progressReplyFactory = generateContextualProgressReply
  } = {}) {
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
    if (typeof this.configLoader === 'function') return this.configLoader();
    const configPath = path.join(process.cwd(), 'plugins/shiloh-plugin/config/message.yaml');
    return YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings;
  }

  async sendContextualProgress({ config, opts, e, query, signal, isActive }) {
    const reservation = reserveProgressReply(e)
    if (!reservation) return
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
      await e?.reply?.(text);
      reservation.commit()
    } catch (error) {
      reservation.release()
      globalThis.logger?.debug?.(`[搜索进度] 生成或发送失败: ${error?.name || 'Error'}`);
    }
  }

  /**
   * 截断文本以控制 token 数量
   * @param {string} text - 需要截断的文本
   * @returns {Promise<string>} 截断后的文本
   */
  async truncateText(text) {
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
  resultToString(result) {
    // logger.error('result', result)
    if (typeof result === 'string') {
      return result;
    }

    if (result === null || result === undefined) {
      return '未找到相关搜索结果';
    }

    if (typeof result === 'object') {
      // 处理常见的结果格式
      if (result.content) {
        return String(result.content);
      }
      if (result.results && Array.isArray(result.results)) {
        return result.results.map((item, index) => {
          if (typeof item === 'string') {
            return `${index + 1}. ${item}`;
          }
          if (item.title && item.content) {
            return `${index + 1}. ${item.title}\n${item.content}`;
          }
          return `${index + 1}. ${JSON.stringify(item)}`;
        }).join('\n\n');
      }
      if (result.data.webPages.value && Array.isArray(result.data.webPages.value)) {
        return result.data.webPages.value.map((item, index) => {
          if (typeof item.snippet === 'string') {
            return `${index + 1}. ${item.snippet}`;
          }
          return `${index + 1}. ${JSON.stringify(item)}`;
        }).join('\n\n');
      }
      if (result.message) {
        return String(result.message);
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
  async func(opts, e) {
    const { query } = opts;

    if (!query?.trim()) {
      return '搜索失败：搜索关键词不能为空';
    }

    let progressTimer = null;
    let controller = null;
    let requestTimeout = null;
    let completed = false;
    let progressController = null;
    let timeoutMs = 20000;
    try {
      const config = this.loadConfig();
      
      const apiUrl = resolveChatCompletionUrl(config.searchAiConfig?.searchApiUrl || 'https://api.openai.com/v1/chat/completions')
      const apiKey = config.searchAiConfig?.searchApiKey || 'sk-xxxxxx'
      // 搜索后端域名被墙/DNS污染时,可配 searchApiProxy: http://127.0.0.1:7890 走本地代理
      const proxyUrl = String(config.searchAiConfig?.searchApiProxy || "").trim()
      const proxyFetch = proxyUrl ? await this.getProxyFetch(proxyUrl) : null

      const requestData = { "model": config.searchAiConfig?.searchApiModel || 'deepseek-r1-search', "messages": [{ "role": "user", "content": query }], "temperature": 1, "top_p": 0.1 }
      timeoutMs = Math.max(3000, Number(config.searchAiConfig?.timeoutMs) || 20000)
      controller = new AbortController()
      requestTimeout = setTimeout(() => controller.abort(), timeoutMs)
      progressTimer = setTimeout(() => {
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

      const analysis = await response.json()
      if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`)
      const content = analysis?.choices?.[0]?.message?.content
      if (!content) throw new Error('搜索服务没有返回可用结果')
      return content + '\n\n提示：如果用户想基于搜索结果制作文件，可以使用 aiMindMapTool 工具继续操作。'

    } catch (error) {
      console.error('搜索过程发生错误:', error);
      const message = error?.name === 'AbortError' ? `搜索超过 ${Math.ceil(timeoutMs / 1000)} 秒仍未返回` : error.message || '发生未知错误'
      return `搜索失败：${message}`;
    } finally {
      completed = true
      if (progressTimer) clearTimeout(progressTimer)
      if (requestTimeout) clearTimeout(requestTimeout)
      progressController?.abort?.()
      controller?.abort?.()
    }
  }
}
