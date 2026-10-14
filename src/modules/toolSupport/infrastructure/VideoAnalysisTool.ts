import {AbstractTool} from './AbstractTool.js';
import FormData from 'form-data';
import {serializeMultipartFormData} from '../../image/infrastructure/multipartFormData.js';
import {pixivRecord as record,pixivText as text} from '../../../contracts/pixiv.js';
interface VideoPeer {getChatHistory(id:unknown,count:number):Promise<unknown>}
interface VideoBot {pickGroup?(id:string|number):VideoPeer;pickFriend?(id:string|number):VideoPeer}
export interface VideoAnalysisPorts {loadConfig():unknown;fetch?:typeof fetch;getBot(id:string|number):VideoBot|null;env?:{VIDEO_ANALYSIS_API_KEY?:string|undefined;BIGMODEL_API_KEY?:string|undefined};logger:{info(...args:unknown[]):void;debug(...args:unknown[]):void;error(...args:unknown[]):void}}
export function createVideoAnalysisTool(ports:VideoAnalysisPorts){
const transport=ports.fetch||globalThis.fetch,logger=ports.logger;
const fetch:typeof globalThis.fetch=(input,init={})=>transport(input,{...init,signal:init.signal||AbortSignal.timeout(60000)});
/**
 * 视频处理工具类，用于处理用户的视频相关请求
 */
class VideoAnalysisTool extends AbstractTool {
video:unknown;defaultApiUrl:string;defaultModel:string;
  constructor() {
    super()
    this.name = "videoAnalysisTool"
    this.description =
      "视频分析工具。当用户需要分析、解读、评价、识别视频内容时调用，例如：『分析一下这个视频』『这视频讲什么』『评价一下』。" +
      "支持三种来源：(1)当前消息中直接附带的视频；(2)引用消息（回复某条视频）中的视频；(3)合并转发或嵌套转发中的视频。" +
      "你不需要在参数里传视频链接，工具会自动从当前消息或引用消息中提取，提取不到会返回错误。"
    this.parameters = {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "用户的视频分析诉求描述。例如：『总结视频内容』『提取视频里的文字』『判断视频是否搞笑』。如果为空则做默认的视频内容分析。",
        },
      },
      additionalProperties: false,required:[],
    }

    this.video = null

    this.defaultApiUrl = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    this.defaultModel = "glm-4.1v-thinking-flash"
  }

  async Video(prompt:string, video:string) {
    try {
      const config = this.getVideoConfig()
      if (!config.apiKey) return { error: "视频分析 API Key 未配置" }

      // 获取公共可访问的视频URL
      const publicUrl = await this.getVideoUrl(video, config.apiKey)
      logger.info("最终使用的视频URL:", publicUrl)

      const requestData = {
        model: config.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "video_url",
                video_url: { url: publicUrl }, // 使用公共URL
              },
            ],
          },
        ],
      }

      const response = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestData),
      })

      if(!response.ok)throw new Error(`视频分析 HTTP ${response.status}`);return record(await response.json())
    } catch (error) {
      console.error("Video方法错误:", error)
      return { error: "视频处理失败: " + (error instanceof Error?error.message:String(error)) }
    }
  }
  getVideoConfig() {
    const runtimeConfig = this.loadConfig()
    const videoCfg = record(runtimeConfig.videoAnalysisAiConfig)
    const analysisCfg = record(runtimeConfig.analysisAiConfig)
    const apiKeys = this.normalizeArray(
      videoCfg.videoAnalysisApiKey ||
      videoCfg.videoAnalysisApiKeys ||
      analysisCfg.analysisApiKey ||
      ports.env?.VIDEO_ANALYSIS_API_KEY ||
      ports.env?.BIGMODEL_API_KEY
    ).map(key => String(key || "").trim()).filter(Boolean)

    return {
      apiUrl: text(videoCfg.videoAnalysisApiUrl) || text(analysisCfg.analysisApiUrl) || this.defaultApiUrl,
      model: text(videoCfg.videoAnalysisApiModel) || text(analysisCfg.analysisApiModel) || this.defaultModel,
      apiKey: apiKeys.length ? apiKeys[Math.floor(Math.random() * apiKeys.length)] || "" : ""
    }
  }

  loadConfig(){return record(ports.loadConfig())}

  normalizeArray(input:unknown) {
    if (Array.isArray(input)) return input.filter((value):value is string=>typeof value==='string')
    return typeof input === "string" ? [input] : []
  }

  /**
   * 从消息或引用消息中提取视频 URL
   * 兼容多种字段（NapCat/ICQQ 的字段名不一致）：url / file_url / data.url / data.file_url / file / data.file
   * @param {object} e - 消息对象
   * @returns {Promise<string[]>} - 视频 URL 数组
   */
  async getVideo(event:unknown){
    const e=record(event);
    const fromMessage=(value:unknown):string[]=>{const source=record(value);return (Array.isArray(source.message)?source.message:[]).map(record).filter(item=>item.type==='video').map(item=>{const data=record(item.data);return text(item.url)||text(item.file_url)||text(data.url)||text(data.file_url)||text(item.file)||text(data.file)}).filter(Boolean)};
    let source:unknown=null;
    try{if(typeof e.getReply==='function')source=await e.getReply.call(event);else {const id=e.self_id;if(typeof id==='string'||typeof id==='number'){const bot=ports.getBot(id),ref=record(e.source);const groupId=e.group_id,userId=e.user_id;if(e.source&&e.isGroup&&(typeof groupId==='string'||typeof groupId==='number'))source=await bot?.pickGroup?.(groupId).getChatHistory(ref.seq||e.reply_id,1);else if(e.source&&e.isPrivate&&(typeof userId==='string'||typeof userId==='number'))source=await bot?.pickFriend?.(userId).getChatHistory(ref.time||e.reply_id,1);}}}catch(error){logger.debug('获取引用源失败',String(error))}
    const assets=record(e._groupContextAssets);const contextual=(Array.isArray(assets.videos)?assets.videos:[]).map(record).map(item=>text(item.source)||text(item.url)).filter(Boolean);
    return [...new Set([...fromMessage(e),...(Array.isArray(source)?source:[source]).flatMap(fromMessage),...contextual])];
  }

  /**
   * 上传视频到免费公共存储服务
   * @param {Buffer} buffer - 视频文件的Buffer数据
   * @returns {Promise<string>} - 返回公共可访问的视频URL
   */
  async uploadToFreeService(buffer:Buffer, apiKey:string) {
    try {
      if (!apiKey) throw new Error("视频上传 API Key 未配置")
      const formData = new FormData()
      formData.append("file", buffer, {
        filename: `video_${Date.now()}.mp4`,
        contentType: "video/mp4",
        knownLength: buffer.length
      })
      const multipart = await serializeMultipartFormData(formData)

      const response = await fetch("https://www.bigmodel.cn/api/biz/file/uploadTemporaryImage", {
        method: "POST",
        body: new Uint8Array(multipart.body),
        headers: {
          ...multipart.headers,
          authorization: `Bearer ${apiKey}`,
        },
      })

      if(!response.ok)throw new Error(`视频上传 HTTP ${response.status}`);const result=record(await response.json());const url=text(result.url);if(!/^https?:\/\//.test(url))throw new Error("视频上传未返回有效URL");return url
    } catch (error) {
      throw new Error(`上传失败: ${(error instanceof Error?error.message:String(error))}`)
    }
  }

  /**
   * 获取视频的公共URL
   * @param {string} video - 视频地址
   * @returns {Promise<string>} - 公共可访问的视频URL
   */
  async getVideoUrl(video:string, apiKey:string) {
    if (!video) throw new Error("视频地址不能为空")

    try {
      // 尝试直接使用原始URL（如果已经被识别为视频）
      if (/^https?:$/.test(new URL(video).protocol) && new URL(video).pathname.toLowerCase().endsWith(".mp4")) {
        return video
      }

      // 下载视频并上传到公共存储
      const response = await fetch(video, {
        headers: {
          Referer: "https://www.qq.com/", // 绕过腾讯防盗链
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      })

      if(!response.ok)throw new Error(`视频下载 HTTP ${response.status}`);
      const maxBytes=64*1024*1024;
      if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('视频超过64MiB限制');
      if(!response.body)throw new Error('视频下载响应为空');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error('视频超过64MiB限制')}chunks.push(value)}}finally{reader.releaseLock()}
      if(!size)throw new Error('视频下载响应为空');const buffer=Buffer.concat(chunks);

      return await this.uploadToFreeService(buffer, apiKey)
    } catch (error) {
      logger.error("获取视频URL失败:", error)
      throw new Error("视频处理失败，请稍后再试")
    }
  }

  async func(opts:Record<string,unknown>, event:unknown) {
    const e=record(event);
    try {
      const videos = await this.getVideo(event)
      const video = videos[0]
      if (!video) {
        return { error: "视频分析失败: 当前消息和引用消息里都没找到视频" }
      }
      const prompt = (opts?.prompt || e.msg || "请分析这个视频内容").toString().trim() || "请分析这个视频内容"
      const res = await this.Video(prompt, video)

      const analysis=text(record(record(Array.isArray(res.choices)?res.choices[0]:null).message).content).trim();
      if(analysis)return {analysis};
      return {error:text(res.error)||text(record(res.error).message)||'视频识别未返回有效内容'}
    } catch (error) {
      logger.error?.("[VideoAnalysisTool] 分析过程异常:", error)
      return { error: `视频分析失败: ${(error instanceof Error?error.message:String(error))}` }
    }
  }
}

return VideoAnalysisTool;
}
