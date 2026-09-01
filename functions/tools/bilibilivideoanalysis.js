import fetch from "node-fetch";
import crypto from 'crypto';
import { extractBilibiliEpisodeId, extractBilibiliUrls } from '../../utils/bilibiliMessage.js';

/**
 * B站视频解析器
 * 用于解析B站视频信息并生成格式化输出
 */
export class BilibiliParser {
  /**
   * 解析B站视频
   * @param {string} url - B站视频链接
   * @returns {Promise<{text: string, videoUrl: string}>} 返回格式化的文本和视频链接
   */
  async parseVideo(url) {
    try {
      // 提取BV号
      const { bvid } = await this.extractBvid(url);
      if (!bvid) {
        throw new Error('无效的B站视频链接');
      }

      // 获取视频详情
      const videoDetails = await this.fetchVideoDetails(bvid);
      if (!videoDetails) {
        throw new Error('获取视频信息失败');
      }

      // 获取AI总结
      const aiSummary = await this.getVideoAISummary(
        bvid,
        videoDetails.cid,
        videoDetails.owner.mid
      );

      // 获取视频链接
      const videoUrl = await this.getVideoUrl(videoDetails);

      // 生成格式化文本
      const formattedText = await this.generateFormattedText(videoDetails, aiSummary);

      return {
        text: formattedText,
        videoUrl: videoUrl
      };
    } catch (error) {
      throw new Error(`视频解析失败: ${error.message}`);
    }
  }

  /**
   * 提取BV号
   * @param {string} url - 原始URL
   * @returns {Promise<{bvid: string}>}
   */
  async extractBvid(url) {
    // 处理短链接
    if (url.includes('b23.tv')) {
      const response = await fetch(url);
      url = response.url;
    }

    const bvidMatch = url.match(/BV[A-Za-z0-9]{10}/);
    return {
      bvid: bvidMatch ? bvidMatch[0] : null
    };
  }

  /**
   * 获取视频详情
   * @param {string} bvid - BV号
   * @returns {Promise<Object>}
   */
  async fetchVideoDetails(bvid) {
    const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const response = await fetch(apiUrl);
    const data = await response.json();

    return data.code === 0 ? data.data : null;
  }

  /**
   * 获取视频AI总结
   * @param {string} bvid - BV号
   * @param {string} cid - 视频CID
   * @param {string} upMid - UP主ID
   * @returns {Promise<string>}
   */
  async getVideoAISummary(bvid, cid, upMid) {
    try {
      // 获取cookie和wts
      const biliRes = await fetch('https://www.bilibili.com');
      const cookies = biliRes.headers.raw()['set-cookie'];
      const cookieString = cookies.map(cookie => cookie.split(';')[0]).join('; ');

      // 生成 wts (当前时间戳，单位秒)
      const wts = Math.floor(Date.now() / 1000);

      // 生成 w_rid (md5 hash)
      const text = `${bvid}${cid}${upMid}${wts}`;
      const w_rid = this.generateWrid(text);  // 移除 await

      const url = new URL('https://api.bilibili.com/x/web-interface/view/conclusion/get');
      url.searchParams.set('bvid', bvid);
      url.searchParams.set('cid', cid);
      url.searchParams.set('up_mid', upMid);
      url.searchParams.set('web_location', '333.788');
      url.searchParams.set('w_rid', w_rid);
      url.searchParams.set('wts', wts.toString());

      const response = await fetch(url.toString(), {
        headers: {
          'accept': '*/*',
          'accept-language': 'zh-CN,zh;q=0.9',
          'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site',
          'cookie': cookieString,
          'referer': `https://www.bilibili.com/video/${bvid}`,
          'referrer-policy': 'strict-origin-when-cross-origin'
        }
      });

      const data = await response.json();
      return data?.data?.model_result?.summary || '暂无AI总结';
    } catch (error) {
      console.error('AI总结获取失败:', error);
      return '获取AI总结失败';
    }
  }

  /**
   * 生成 w_rid
   * @param {string} text - 要进行哈希的文本
   * @returns {string} - MD5 哈希值
   */
  generateWrid(text) {
    return crypto
      .createHash('md5')
      .update(text)
      .digest('hex');
  }
  /**
   * 获取视频播放链接
   * @param {Object} videoDetails - 视频详情
   * @returns {Promise<string>}
   */
  async getVideoUrl(videoDetails) {
    const { aid: avid, cid } = videoDetails;
    const playUrl = `https://api.bilibili.com/x/player/playurl?avid=${avid}&cid=${cid}&qn=16&type=mp4&platform=html5`;

    const response = await fetch(playUrl);
    const data = await response.json();

    if (data.code !== 0 || !data.data?.durl?.[0]?.url) {
      throw new Error('获取视频地址失败');
    }

    return data.data.durl[0].url;
  }

  /**
   * 生成格式化文本
   * @param {Object} videoDetails - 视频详情
   * @param {string} aiSummary - AI总结
   * @returns {string}
   */
  async generateFormattedText(videoDetails, aiSummary) {
    const {
      pic, title, owner, desc,
      stat,
      duration,
      pubdate,
      tname,
      view
    } = videoDetails;

    const stats = {
      like: stat?.like ?? 0,
      favorite: stat?.favorite ?? 0,
      coin: stat?.coin ?? 0,
      share: stat?.share ?? 0
    };

    return `# ${title || '无标题'} 

\`\`\`mermaid
    A[📺视频源] --> B[播放 ${this.formatNumber(view || 0)}]
    A --> C[互动 ${this.formatNumber(stats.like)}]
    A --> D[分区 ${tname || '未知'}]
\`\`\`

![封面](${pic})

## ⚡ 核心数据

\`\`\`json
{
  "视频分区": "${tname || '未知分区'}",
  "视频时长": "${this.formatDuration(duration || 0)}",
  "发布时间": "${this.formatDate(pubdate || Date.now() / 1000)}",
  "播放数据": ${view || 0}
}
\`\`\`

## 🎬 创作者档案

\`\`\`diff
@@创作者信息@@
+ 昵称：${owner?.name || '未知用户'}
+ UID：${owner?.mid || '未知'}
! 投稿分区：${tname || '未知分区'}
\`\`\`

## 📝 内容信息

\`\`\`yaml
▶视频简介:
  ${desc?.split('\n').join('\n  ') || '暂无简介'}
\`\`\`

## 📊 数据监控

\`\`\`typescript
    点赞: ${this.formatNumber(stats.like)}     
    收藏: ${this.formatNumber(stats.favorite)} 
    投币: ${this.formatNumber(stats.coin)}    
    转发: ${this.formatNumber(stats.share)}    
\`\`\`

## 🤖 智能解析

\`\`\`shell
╔════════════════════════════════════════════
║ [INIT] 正在处理...
║ [CONF] 模型: bilibili-Ai
╠════════════════════════════════════════════
${aiSummary.split('\n').map(line => `║ ${line}`).join('\n') || '║ [WARNING] No analysis data detected'}
╠════════════════════════════════════════════
║ [INFO] 分析处理完成
║ [TIME] ${new Date().toLocaleString('zh-CN', { hour12: false })}
╚════════════════════════════════════════════
\`\`\`

## 🔗 系统信息

\`\`\`bash
# 数据更新时间
Last-Update: ${new Date().toLocaleString('zh-CN', { hour12: false })}
# 数据来源
Source: Bilibili-API-v2
\`\`\`
`;
  }

  /**
   * 格式化数字
   * @param {number} num - 要格式化的数字
   * @returns {string}
   */
  formatNumber(num) {
    if (!num && num !== 0) return '0';

    if (num >= 100000000) {
      return `${(num / 100000000).toFixed(1)}亿`;
    }
    if (num >= 10000) {
      return `${(num / 10000).toFixed(1)}万`;
    }
    return num.toString();
  }

  /**
   * 格式化时长
   * @param {number} seconds - 秒数
   * @returns {string}
   */
  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  /**
   * 格式化日期
   * @param {number} timestamp - 时间戳
   * @returns {string}
   */
  formatDate(timestamp) {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}

export const bilibiliParser = async (Urls) => {
  const parser = new BilibiliParser();
  const results = [];
  const videos = extractBilibiliUrls(Urls).filter(url => !extractBilibiliEpisodeId(url));
  console.log('找到的视频链接:', videos);
  const cleanedVideos = [...new Set(videos.map(url => {
    const match = url.match(/bilibili\.com\/video\/([A-Za-z0-9]+)/);
    return match ? `https://www.bilibili.com/video/${match[1]}` : url;
  }))];
  for (const url of cleanedVideos) {
    try {
      const result = await parser.parseVideo(url);
      results.push({
        url: url,
        success: true,
        text: result.text,
        videoUrl: result.videoUrl
      });

    } catch (error) {
      results.push({
        url: url,
        success: false,
        error: error.message
      });
    }
  }

  return results;
}
