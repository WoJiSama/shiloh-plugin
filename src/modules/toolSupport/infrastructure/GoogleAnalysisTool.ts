import { AbstractTool } from './AbstractTool.js';
import {resolveChatCompletionUrl} from '../../models/domain/chatCompletionUrl.js';
import {reserveProgressReply} from '../../conversation/domain/progressReplyBudget.js';
import type {DrawEvent, DrawOptions} from '../../../contracts/bananaTool.js';
import {parseDrawEvent,parseDrawOptions} from './bananaDecoders.js';
import {toolRecord as record} from '../../../contracts/toolExecution.js';
export interface ProgressInput {config:Record<string,unknown>;taskType:string;taskMode?:string;userText:string;stage:string;suggestedText?:string|undefined;agentContext?:string|undefined;fetchImpl:typeof fetch;signal?:AbortSignal|undefined}
export interface AnalysisPorts {loadConfig():unknown;normalizeImageUrls(images:string[]):Promise<string[]>;imageLoader(url:string,name:string):Promise<string>;progressReplyFactory(input:ProgressInput):Promise<string>;guardReply(text:string,config:unknown,context:{userText:string;botNames:unknown[]}):string;callApi(action:string,params:Record<string,unknown>):Promise<unknown>;logger:{info(...args:unknown[]):void;warn(...args:unknown[]):void}}
interface AnalysisOptions {fetchImpl?:typeof fetch;progressFetchImpl?:typeof fetch;progressReplyFactory?:AnalysisPorts['progressReplyFactory'];progressDelayMs?:number;imageLoader?:AnalysisPorts['imageLoader']}
interface Failure {provider:string;code:string;status?:number;message:string;elapsedMs:number}
interface AnalysisResult {analysis?:string;provider?:string;imageIndex:number;failures:Failure[]}
function errorText(error:unknown):string{return error instanceof Error?error.message:String(error)}
function text(value:unknown):string{return typeof value==='string'?value:''}
export function createGoogleImageAnalysisTool(ports:AnalysisPorts){
const {normalizeImageUrls}=ports;
const getBase64Image=ports.imageLoader;
const generateContextualProgressReply=ports.progressReplyFactory;
const DEFAULT_ANALYSIS_TIMEOUT_MS = 45000;

function redactErrorMessage(error:unknown) {
    return errorText(error)
        .replace(/https?:\/\/\S+/g, '[url]')
        .replace(/sk-[A-Za-z0-9_-]+/g, '[key]')
        .slice(0, 240);
}

function imageIdentity(url = '') {
    try {
        const parsed = new URL(url);
        if(parsed.searchParams.has('fileid'))return `${parsed.origin}${parsed.pathname}?fileid=${parsed.searchParams.get('fileid')}`;
        parsed.searchParams.delete('rkey');return parsed.href;
    } catch {
        return String(url || '');
    }
}

function dedupeImageUrls(urls:string[] = []) {
    const seen = new Set();
    return (Array.isArray(urls) ? urls : []).filter(url => {
        const key = imageIdentity(url);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * 图片处理工具类，用于处理用户的图片相关请求
 */
class GoogleImageAnalysisTool extends AbstractTool {
    fetchImpl:typeof fetch; progressFetchImpl:typeof fetch; progressReplyFactory:AnalysisPorts['progressReplyFactory']; progressDelayMs:number; imageLoader:AnalysisPorts['imageLoader'];
    constructor({
        fetchImpl = globalThis.fetch,
        progressFetchImpl = globalThis.fetch,
        progressReplyFactory = generateContextualProgressReply,
        progressDelayMs = 2500,
        imageLoader = getBase64Image
    }:AnalysisOptions = {}) {
        super();
        this.name = 'googleImageAnalysisTool';
        this.description = '进行图像分析, 当用户识别图片内容时使用此工具。支持多图片分析，可提取图片中的文字信息并进行理解分析。注意：所有图片URL必须保持完整原始形式，不得修改或简化URL参数。当用户要求查看QQ头像时（如"看下我的头像"、"看下他的头像"、"看下张三的头像"），使用头像URL格式：https://q1.qlogo.cn/g?b=qq&nk={QQ号}&s=640';
        this.parameters = {
            type: "object",
            properties: {
                prompt: {
                    type: 'string',
                    description: '用户的图片处理需求描述，如果为空则进行默认的图片分析',
                },
                progressText: {
                    type: 'string',
                    description: '可选：根据当前对话生成一句自然的识图接话，需要说清用户想看什么；不能只说“我先看看这张图”，也不能编造识别结果',
                },
                images: {
                    type: 'array',
                    description: '需要处理的图片链接数组。重要：必须保持原始URL的完整性，包括所有查询参数。\n' +
                        'QQ头像链接格式：https://q1.qlogo.cn/g?b=qq&nk={QQ号}&s=640\n' +
                        '示例链接：\n' +
                        '1. QQ头像: "https://q1.qlogo.cn/g?b=qq&nk=123456789&s=640"\n' +
                        '2. 腾讯图床: "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=xxx&spec=0&rkey=xxx"\n' +
                        '3. QQ图片: "https://gchat.qpic.cn/gchatpic_new/xxx/0?term=2&is_origin=0"\n' +
                        '以上链接中的所有参数都必须完整保留，不得简化或修改',
                    items: {
                        type: 'string',
                        description: '完整的图片URL，必须与原始输入完全一致。示例：\n' +
                            '"https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhSpon0PNM0ysZkSasHTTFhNhPkn2xiM9ogCIP8KKPTzyfGXgYsDMgRwcm9kUIC9owFaELWsiGLkylkWILRwFGxE3cQ&spec=0&rkey=CAQSOAB6JWENi5LM1F9SWC-_lnNTz6V9r7O2ev3HX_QmYpr_odrwSXfUpXfNIyIowntqLF3KoE8inPMs"',
                        // examples: [
                        //     "https://gchat.qpic.cn/gchatpic_new/2119611465/782312429-2903731874-87B79F5B839EA2F3AD0AD48DD539D946/0?term=2&is_origin=0",
                        //     "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhSpon0PNM0ysZkSasHTTFhNhPkn2xiM9ogCIP8KKPTzyfGXgYsDMgRwcm9kUIC9owFaELWsiGLkylkWILRwFGxE3cQ&spec=0&rkey=CAQSOAB6JWENi5LM1F9SWC-_lnNTz6V9r7O2ev3HX_QmYpr_odrwSXfUpXfNIyIowntqLF3KoE8inPMs"
                        // ]
                    }
                }
            },
            required: ['images'], additionalProperties:false
        };
        this.fetchImpl = fetchImpl;
        this.progressFetchImpl = progressFetchImpl;
        this.progressReplyFactory = progressReplyFactory;
        this.progressDelayMs = Math.max(0, Number(progressDelayMs) || 0);
        this.imageLoader = imageLoader;

    }

    async processImageUrl(url:string) {
        if (!url) return null;

        // 处理腾讯图床链接
        if (url.includes('qq.com')) {
            const fid = url.match(/fileid=([^&]+)/)?.[1];
            const rkey = await this.getRKey(url);
            const host = await this.extractDomain(url);

            if (fid && rkey && host) {
                // 尝试不同的 appid
                for (let appid = 1408; appid >= 1403; appid--) {
                    const newUrl = `${host}/download?appid=${appid}&fileid=${fid}&spec=0&rkey=${rkey}`;
                    if (await this.isUrlAvailable(newUrl)) {
                        return newUrl;
                    }
                }
            }
        }

        return url;
    }

    async isUrlAvailable(url:string) {try {const response=await this.fetchImpl(url,{signal:AbortSignal.timeout(5000)});if(!response.ok)return false;const bytes=new Uint8Array(await response.arrayBuffer());return [[255,216],[137,80,78,71],[71,73,70],[82,73,70,70],[66,77]].some(signature=>signature.every((byte,index)=>bytes[index]===byte));}catch{return false;}}
    async callApi(action:string,params:Record<string,unknown>={}){return ports.callApi(action,params);}
    async getRKey(url:string) {
        // 检查URL是否包含rkey参数
        const rkeyMatch = url.match(/rkey=([^&]+)/);
        if (!rkeyMatch) return null;

        try {
            const response = record(await this.callApi('nc_get_rkey'));
            if (response?.status === 'ok' && Array.isArray(response.data) && response.data.length >= 2) {
                // 取数组中第二个元素的rkey，去掉开头的"&rkey="
                const rkeyValue = text(record(response.data[1]).rkey);
                return rkeyValue.replace(/^&rkey=/, '');
            }
        } catch (error) {
            console.error('获取rkey失败:', error);
        }

        // 如果接口调用失败，返回原始rkey
        return rkeyMatch[1];
    }

    extractDomain(url:string) {
        try {
            const urlObj = new URL(url);
            return urlObj.origin;
        } catch {
            return null;
        }
    }

    async func(input:Record<string,unknown>, event:unknown) {
        const opts=parseDrawOptions(input),e=parseDrawEvent(event);
        let progressController:AbortController|null = null;
        let progressTimer:ReturnType<typeof setTimeout>|null = null;
        try {
            const config = record(ports.loadConfig());
            // 确保 opts.images 是数组并处理每个URL
            const rawImages = Array.isArray(opts.images) ? opts.images :
                typeof opts.images === 'string' ? [opts.images] : [];

            if (rawImages.length === 0) {
                return { error: '未检测到有效的图片链接' };
            }

            progressTimer = setTimeout(() => {
                progressController = new AbortController();
                void this.sendProgress(e, {
                    config,
                    opts,
                    signal: progressController.signal
                });
            }, this.progressDelayMs);

            // 处理所有图片URL
            const images = dedupeImageUrls(await normalizeImageUrls(rawImages));
            const prompt = opts.prompt;

            if (images.length === 0) {
                return { error: '未检测到有效的图片链接' };
            }

            const instruction = {
                "type": "text",
                "text": prompt || '分析图片的大致情况，详细描述, 200字概括, 如果图片含有大量的文本信息，先提取，再理解分析'
            };
            const imageContents = [];

            // 处理每张图片
            for (let url of images) {
                const filetypes = "other.png";
                const img_urls = await this.imageLoader(url, filetypes);

                if (img_urls.includes("该图片链接已过期")) {
                    return { kind: 'tool_outcome', status: 'error', tool: this.name, error: { code: 'image_link_expired', message: '该图片下载链接已过期，请重新上传' } };
                }
                if (img_urls.includes("无效的图片下载链接")) {
                    return { kind: 'tool_outcome', status: 'error', tool: this.name, error: { code: 'image_download_failed', message: '无效的图片下载链接，请确保适配器支持且图片未过期' } };
                }

                const mimeType = 'image/png';
                const isImage = mimeType.startsWith('image/');

                imageContents.push(isImage ? {
                    "type": "image_url",
                    "image_url": { url: img_urls }
                } : {
                    "type": "file",
                    "file_url": { url: img_urls }
                });
            }

            try {
                const analysisConfig = record(config.analysisAiConfig);
                const candidates = [analysisConfig, ...(Array.isArray(analysisConfig.providers) ? analysisConfig.providers.map(record) : [])]
                    .map((item, index) => ({
                        apiUrl: resolveChatCompletionUrl(text(item.analysisApiUrl) || text(item.apiUrl) || 'https://api.openai.com/v1/chat/completions'),
                        apiKey: text(item.analysisApiKey) || text(item.apiKey) || '',
                        model: text(item.analysisApiModel) || text(item.model) || 'gemini-3-pro-image-preview',
                        timeoutMs: Math.max(3000, Number(item.timeoutMs || analysisConfig.timeoutMs) || DEFAULT_ANALYSIS_TIMEOUT_MS),
                        label: index === 0 ? 'primary' : `fallback_${index}`
                    }))
                    .filter((item, index, list) => item.apiKey && list.findIndex(other => `${other.apiUrl}:${other.model}` === `${item.apiUrl}:${item.model}`) === index);
                const requestAnalysis = async ({ content, imageCount, imageIndex }:{content:unknown[];imageCount:number;imageIndex:number}):Promise<AnalysisResult> => {
                    const failures:Failure[] = [];
                    for (const candidate of candidates) {
                        const attemptStartedAt = Date.now();
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), candidate.timeoutMs);
                        try {
                            const response = await this.fetchImpl(candidate.apiUrl, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", Authorization: `Bearer ${candidate.apiKey}` },
                                body: JSON.stringify({ model: candidate.model, messages: [{ role: "user", content }] }),
                                signal: controller.signal
                            });
                            const raw = await response.text();
                            if (!response.ok) throw Object.assign(new Error(`vision HTTP ${response.status}: ${raw.replace(/\s+/g, " ").slice(0, 140)}`), { code: 'vision_http', status: response.status });
                            let analysis:Record<string,unknown>;
                            try { analysis = record(JSON.parse(raw)); } catch { throw Object.assign(new Error('vision response is not JSON'), { code: 'vision_invalid_response' }); }
                            const result = record(record(Array.isArray(analysis.choices)?analysis.choices[0]:null).message).content;
                            if (typeof result!=='string'||!result.trim()) throw Object.assign(new Error('vision response has no content'), { code: 'vision_empty_response' });
                            ports.logger.info(`[图片识别] provider=${candidate.label} model=${candidate.model} images=${imageCount} index=${imageIndex ?? 0} success`);
                            return { analysis: String(result).trim(), provider: candidate.label, imageIndex, failures };
                        } catch (error) {
                            const code = record(error).name === 'AbortError' ? 'vision_timeout' : text(record(error).code) || 'vision_request_failed';
                            failures.push({
                                provider: candidate.label,
                                code,
                                ...(Number.isFinite(Number(record(error).status)) ? { status: Number(record(error).status) } : {}),
                                message: redactErrorMessage(error).slice(0, 160),
                                elapsedMs: Date.now() - attemptStartedAt
                            });
                            this.logWarn(`[图片识别] provider=${candidate.label} model=${candidate.model} images=${imageCount} index=${imageIndex ?? 0} code=${code} error=${redactErrorMessage(error)}`);
                        } finally {
                            clearTimeout(timer);
                        }
                    }
                    return { imageIndex, failures };
                };

                // 一次请求塞入多张截图会显著放大视觉模型的排队与处理时间。
                // 按原顺序并行逐张识别，允许其中一张失败而其余图片仍可交付事实结果。
                const requests = imageContents.length > 1
                    ? imageContents.map((image, index) => requestAnalysis({
                        imageCount: 1,
                        imageIndex: index + 1,
                        content: [{
                            ...instruction,
                            text: `${instruction.text}\n当前是第 ${index + 1} 张，共 ${imageContents.length} 张。只描述这一张实际可见的信息。`
                        }, image]
                    }))
                    : [requestAnalysis({ content: [instruction, imageContents[0]], imageCount: 1, imageIndex: 1 })];
                const results = await Promise.all(requests);
                const successful = results.filter(result => result.analysis);
                const failures = results.flatMap(result => result.failures || []);
                if (successful.length) {
                    const failedImageIndexes = results.filter(result => !result.analysis).map(result => result.imageIndex);
                    const analysis = imageContents.length > 1
                        ? [
                            ...successful.map(result => `【第${result.imageIndex}张】\n${result.analysis}`),
                            ...(failedImageIndexes.length
                                ? [`【识别状态】共 ${images.length} 张，已读到第 ${successful.map(result => result.imageIndex).join("、")} 张；第 ${failedImageIndexes.join("、")} 张本轮未读到内容。`]
                                : [])
                        ].join("\n\n")
                        : successful[0]?.analysis;
                    return {
                        analysis,
                        evidence: {
                            kind: 'tool_outcome',
                            status: 'success',
                            tool: this.name,
                            imageCount: images.length,
                            analyzedImageIndexes: successful.map(result => result.imageIndex),
                            ...(failedImageIndexes.length ? { partial: true, failedImageIndexes } : {}),
                            providers: [...new Set(successful.map(result => result.provider))]
                        }
                    };
                }
                const lastFailure = failures.at(-1);
                return {
                    kind: 'tool_outcome',
                    status: 'error',
                    tool: this.name,
                    error: {
                        code: lastFailure?.code || 'vision_unavailable',
                        ...(lastFailure?.status ? { status: lastFailure?.status } : {}),
                        message: '图片识别没有返回可用内容'
                    },
                    evidence: { imageCount: images.length, attempts: failures }
                };

                // const apiUrl = "https://api.pearktrue.cn/api/airecognizeimg/"
                // const response = await fetch(apiUrl, {
                //     method: "POST",
                //     headers: {
                //         'Content-Type': 'application/json', // 明确声明 JSON 格式
                //     },
                //     body: JSON.stringify({
                //         file: images[0],
                //     }),
                // })
                // const analysis = await response.json()
                // return {
                //     analysis: analysis
                // };
            } catch (error) {
                console.error('图片分析过程发生错误:', error);
                return { error: `图片分析失败: ${errorText(error)}` };
            }
        }
        catch (error) {
            console.error('图片分析过程发生错误:', error);
            return { error: `图片分析失败: ${errorText(error)}` };
        }
        finally {
            if (progressTimer) clearTimeout(progressTimer);
            const controller:unknown=progressController;if(controller instanceof AbortController)controller.abort();
        }
    }

    logWarn(...args:unknown[]) {ports.logger.warn(...args);}

    async sendProgress(e:DrawEvent, { config = {}, opts = {}, signal }:{config?:Record<string,unknown>;opts?:DrawOptions;signal?:AbortSignal} = {}) {
        if (!e?.reply || signal?.aborted) return false;
        const reservation = reserveProgressReply(e);
        if (!reservation) return false;
        let deliveryAttempted=false;
        try {
            const text = await this.progressReplyFactory({
                config,
                taskType: '图片识别',
                userText: e?.msg || e?.raw_message || opts?.prompt || '识别这张图片',
                stage: '已收到图片引用，正在读取并等待识别结果',
                suggestedText: opts?.progressText,
                agentContext: opts?.agentContext,
                fetchImpl: this.progressFetchImpl,
                signal
            });
            if (!text || signal?.aborted) {
                reservation.release();
                return false;
            }
            const guardedText = ports.guardReply(text, config?.personaGuard, {
                userText: e?.msg || e?.raw_message || opts?.prompt || '',
                botNames: [record(config.persona).name]
            });
            if (!guardedText) {
                reservation.release();
                return false;
            }
            deliveryAttempted=true;
            await e.reply(guardedText);
            reservation.commit();
            return true;
        } catch (error) {
            if(deliveryAttempted)reservation.commit();else reservation.release();
            this.logWarn(`[图片分析] 发送进度提示失败: ${errorText(error)}`);
            return false;
        }
    }

}

return GoogleImageAnalysisTool;
}
