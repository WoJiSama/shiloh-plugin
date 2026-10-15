import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
import {VolcengineVoiceProvider, type VoiceProviderConfig, type VoiceStyle} from './VolcengineVoiceProvider.js'
import {getVoiceStyleConfig,sanitizeVoiceText,scheduleVoiceFileCleanup,selectVoiceStyle} from '../../platform/infrastructure/qqVoiceAudio.js'
import {parseDrawEvent} from '../../toolSupport/infrastructure/bananaDecoders.js'
import type {DrawEvent} from '../../../contracts/bananaTool.js'
import {extractDeliveryMessageId} from '../../messaging/domain/deliveryObservability.js'
import {withPersonaSnapshot} from '../../conversation/domain/personaSnapshotConfig.js'
function record(value: unknown): Record<string, unknown> {return value && typeof value==='object'?value as Record<string,unknown>:{}}
function parseVoiceStyle(value: unknown): VoiceStyle {
 const raw=record(value),result:VoiceStyle={}
 for(const key of ['format','voiceType','emotion','prompt','resourceId'] as const) if(typeof raw[key]==='string')result[key]=raw[key]
 for(const key of ['sampleRate','speedRatio','pitchRatio','volumeRatio'] as const) if(typeof raw[key]==='number'&&Number.isFinite(raw[key]))result[key]=raw[key]
 return result
}
export interface VoiceSystemConfig {enabled?: boolean; provider?: string; volcengine?: VoiceProviderConfig; maxTextLength?: number; cleanupDelayMs?: number; styles?: Record<string,Record<string,unknown>>}
export interface VoiceBridge {config?:{voiceSystem?:VoiceSystemConfig;personaGuard?:unknown;persona?:{name?:string}};getPersonaFor?(event:DrawEvent):{name?:string}}
export function createVoiceTool(ports:{getBridge():VoiceBridge|null;guardReply(text:string,config:unknown,context:{userText:string;botNames:(string|undefined)[]}):string;record(path:string):unknown}) {
class VoiceTool extends AbstractTool {
  constructor() {
    super()
    this.name = "voiceTool"
    this.description = [
      "发送一条 QQ 语音消息。只有用户明确要求语音、念出来、用语音说，或非常适合用短语音表达时才调用。",
      "语音内容必须短、自然、适合口播；不要读长篇科普、代码、列表或工具结果。"
    ].join("")
    this.parameters = {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "要说出来的短句，必须是纯口播文字，不要包含 Markdown、代码、表情符号或舞台动作。"
        },
        style: {
          type: "string",
          description: "语气风格，可选 normal/shy/tease/serious/sleepy；不确定就省略。"
        }
      },
      required: ["text"]
    }
  }

  getVoiceSystemConfig() {
    return ports.getBridge()?.config?.voiceSystem || {}
  }

  buildProvider(config: VoiceSystemConfig) {
    const provider = String(config.provider || "volcengine").toLowerCase()
    if (provider !== "volcengine") {
      throw new Error(`暂不支持语音供应商: ${provider}`)
    }
    return new VolcengineVoiceProvider(config.volcengine || {})
  }

  async func(input: unknown, event: unknown) {
    const opts=record(input), e=parseDrawEvent(event)
    const config = this.getVoiceSystemConfig()
    if (config.enabled !== true) {
      return "语音系统还没开启，先用文字回复。"
    }

    const rawText = String(opts.text || "")
    const bridge = ports.getBridge()
    const personaConfig = withPersonaSnapshot(bridge?.config || {}, e)
    const persona = e._personaSnapshot ? personaConfig.persona : bridge?.getPersonaFor?.(e) ?? personaConfig.persona
    const guardedText = ports.guardReply(rawText, personaConfig.personaGuard, {
      userText: e?.msg || "",
      botNames: [persona?.name, e?.bot?.nickname]
    })
    const text = sanitizeVoiceText(guardedText, config.maxTextLength || 80)
    if (!text) return "语音内容为空，先不发语音。"

    const styleName = String(opts.style || "") || selectVoiceStyle(text, config.styles || {})
    const style = parseVoiceStyle(getVoiceStyleConfig(config, styleName))
    let filePath = ""
    try {
      const provider = this.buildProvider(config)
      const result = await provider.synthesizeToFile({ text, style })
      filePath = result.filePath
      const receipt = await e.reply(ports.record(filePath))
      scheduleVoiceFileCleanup(filePath, config.cleanupDelayMs || 5 * 60 * 1000)
      if (extractDeliveryMessageId(receipt) === null) return "语音投递结果未确认，请勿重复发送这段语音。"
      return `语音已发送。语音内容是：${text}。后续不要再用文字重复这段语音。`
    } catch (error) {
      if (filePath) scheduleVoiceFileCleanup(filePath, 1000)
      return `发送语音失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

return VoiceTool
}
