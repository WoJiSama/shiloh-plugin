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
      // B站风控：无设备指纹 cookie 的搜索请求会被 412/HTML 拦截（访问首页拿不到 cookie）。
      // 标准姿势：先从 finger/spi 拿 buvid3/buvid4 再搜索（实测可过，生产同理加固）。
      const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      let cookieHeader = '';
      try {
        const spi = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
          headers: { 'user-agent': UA, Referer: 'https://www.bilibili.com' },
        })
        const spiData = record(record(await spi.json()).data)
        const b3 = String(spiData.b_3 || ''), b4 = String(spiData.b_4 || '')
        if (b3 && b4) cookieHeader = `buvid3=${b3}; buvid4=${b4}`
      } catch { /* 拿不到指纹就裸搜，部分环境仍可过 */ }

      const searchUrl = `https://api.bilibili.com/x/web-interface/search/type?keyword=${encodeURIComponent(name)}&search_type=video`;
      const buildHeaders = (referer: string) => ({
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        Referer: referer,
        'user-agent': UA,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      })

      // 发送搜索请求（被风控页拦住时换 Referer 重试一次）
      let response = await fetch(searchUrl, { headers: buildHeaders('https://www.bilibili.com') })
      let raw = await response.text()
      if (!response.ok || raw.trimStart().startsWith('<!DOCTYPE') || raw.includes('request was banned')) {
        response = await fetch(searchUrl, { headers: buildHeaders('https://search.bilibili.com') })
        raw = await response.text()
      }
      if (!response.ok) throw new Error(`视频搜索 HTTP ${response.status}`)
      if (raw.trimStart().startsWith('<!DOCTYPE')) throw new Error('B站搜索被风控拦截（稍后再试）')
      const json = record(JSON.parse(raw))
      if (Number(json.code) === -412) throw new Error('B站搜索触发风控（稍后再试）')
      const data=record(json.data),results=Array.isArray(data.result)?data.result.map(record):[];

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
