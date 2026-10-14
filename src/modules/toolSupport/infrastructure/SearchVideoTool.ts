import {AbstractTool} from './AbstractTool.js';
import {pixivRecord as record,pixivText as text} from '../../../contracts/pixiv.js';
import {parseDrawEvent} from './bananaDecoders.js';
import type {DrawEvent} from '../../../contracts/bananaTool.js';
export function createSearchVideoTool(ports:{fetch?:typeof globalThis.fetch;image(url:string):unknown;sendvideos(text:string,event:DrawEvent):Promise<unknown>}){
const transport=ports.fetch||globalThis.fetch;const fetch:typeof globalThis.fetch=(input,init={})=>transport(input,{...init,signal:init.signal||AbortSignal.timeout(30000)});
const {sendvideos}=ports;
/**
 * SearchVideo 工具类，用于搜索 Bilibili 视频
 */
class SearchVideoTool extends AbstractTool {
keywords:string[];intent:string;examples:string[];
  constructor() {
    super();
    this.name = 'searchVideoTool';
    this.description = '搜索视频并返回详细信息，当用户想要查找视频、了解视频内容时使用。';
    this.keywords = ['搜视频', '找视频', 'B站搜索', '视频搜索', '查找视频'];
    this.intent = '用户想要搜索或查找B站视频相关内容时的意图';
    this.examples = [
      '帮我搜索原神视频',
      '找一个关于编程的视频',
      '搜索最新的美食视频'
    ];
    this.parameters = {
      type: "object",
      properties: {
        keyword: {
          type: 'string',
          description: '搜索关键词，可以是视频标题、主题或任何相关内容',
          example: '原神'
        }
      },
      required: ['keyword']
    };
  }

  /**
   * 执行Bilibili视频搜索
   * @param {string} name - 视频关键词
   * @returns {Promise<string>} - 搜索结果或错误信息
   */
  async searchBilibili(name:string) {
    try {
      // 初始请求，获取cookie
      let biliRes = await fetch('https://www.bilibili.com', {
        // 可以根据需要添加headers
      });

      // 手动收集所有 'set-cookie' 头部
      const setCookieHeaders = biliRes.headers.getSetCookie?.() || [];
      for (const [key, value] of biliRes.headers) {
        if (!setCookieHeaders.length && key.toLowerCase() === 'set-cookie') {
          setCookieHeaders.push(value);
        }
      }

      let cookieHeader = '';
      if (setCookieHeaders.length > 0) {
        // 只取第一个 'set-cookie' 头部，如果需要多个，可以根据需求进行拼接
        cookieHeader = setCookieHeaders.map(cookie => cookie.split(';')[0]).join('; ');
      }

      // 构建请求头
      let requestHeaders = {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'accept-language': 'zh-US,en;q=0.9',
        Referer: 'https://www.bilibili.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        cookie: cookieHeader
      };

      // 发送搜索请求
      let response = await fetch(`https://api.bilibili.com/x/web-interface/search/type?keyword=${encodeURIComponent(name)}&search_type=video`, {
        headers: requestHeaders
      });
      if(!response.ok)throw new Error(`视频搜索 HTTP ${response.status}`);
      const json=record(await response.json());const data=record(json.data),results=Array.isArray(data.result)?data.result.map(record):[];

      if (results.length > 0) {
        // 随机选择一个视频
        const randomVideo = results[Math.floor(Math.random() * results.length)] || {};

        // 格式化数据
        const formatData = {
          // 格式化播放量
          formatPlay: (value:unknown) => {
            const count=Number(value)||0;
            if (count >= 10000) {
              return `${(count / 10000).toFixed(1)}万`;
            }
            return count.toString();
          },
          // 格式化时间
          formatDate: (value:unknown) => {
            const timestamp=Number(value)||0;
            return new Date(timestamp * 1000).toLocaleDateString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',timeZone:'Asia/Shanghai'
            });
          }
        };

        // 构建返回结果
        return `🎬 随机推荐视频：

📺 ${text(randomVideo.title).replace(/<[^>]+>/g, '')}
👤 UP主：${randomVideo.author}
🔢 BV号：${randomVideo.bvid}
🎯 分区：${randomVideo.typename || '未知分区'}
⏱️ 时长：${randomVideo.duration}
👁️ 播放：${formatData.formatPlay(randomVideo.play)}
💖 点赞：${formatData.formatPlay(randomVideo.like)}
📅 发布：${formatData.formatDate(randomVideo.pubdate)}

🔗 视频链接：https://www.bilibili.com/video/${randomVideo.bvid}
🖼️ 封面：${text(randomVideo.pic).startsWith('//') ? 'https:' + randomVideo.pic : randomVideo.pic}`;
      } else {
        return `❌ 未找到与"${name}"相关的视频`;
      }
    } catch (err) {
      console.error(err);
      return `⚠️ 搜索失败：${err instanceof Error?err.message:String(err)}`;
    }
  }

  /**
   * 执行搜索视频操作
   * @param {Object} opts - 参数选项
   * @param {Object} e - 事件对象
   * @returns {Promise<string>} - 搜索结果或错误信息
   */
  async func(opts:Record<string,unknown>, event:unknown) {
    const e=parseDrawEvent(event),keyword=text(opts.keyword);
    try {
      const result = await this.searchBilibili(keyword);

      function extractBVID(str:string) {
        const match = str.match(/BV号：(BV[A-Za-z0-9]+)/);
        return match ? match[1] : null;
      }

      // 如果结果中包含封面链接，先发送格式化的文本信息（不包含封面链接）
      if (result.includes('🖼️ 封面：')) {
        // 分离文本信息和封面链接
        const [textInfo, coverInfo] = result.split('🖼️ 封面：');

        // 清理封面链接
        const coverUrl = (coverInfo||'').trim();

        //const sessdata = '';

        //const VideoSummary = await common.makeForwardMsg(e, [await BilibiliVideoSummary(sessdata, extractBVID(result))], 'Ai总结+弹幕');
        //await e.reply(VideoSummary);
        // 发送图片和文本信息
        await e.reply([ports.image(coverUrl), (textInfo||'').trim()]);
        // 发送视频链接
        await sendvideos(result, e);
        return { result: result };
      }

      // 如果没有封面链接，直接发送结果
      await e.reply(result);
      return { result: result };

    } catch (err) {
      console.error(err);
      return `搜索视频失败，错误: ${String(err)}`;
    }
  }
}
return SearchVideoTool;
}
