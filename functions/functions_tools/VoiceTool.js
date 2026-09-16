import { AbstractTool } from "./AbstractTool.js"
import { pluginBridge } from "../../utils/pluginBridge.js"
import { personaFeedbackManager } from "../../domains/memory/PersonaFeedbackManager.js"
import { VolcengineVoiceProvider } from "../../utils/VolcengineVoiceProvider.js"
import {
  getVoiceStyleConfig,
  sanitizeVoiceText,
  scheduleVoiceFileCleanup,
  selectVoiceStyle
} from "../../utils/qqVoiceAudio.js"

export class VoiceTool extends AbstractTool {
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
          description: "要用希洛声音说出来的短句，必须是纯口播文字，不要包含 Markdown、代码、表情符号或舞台动作。"
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
    return pluginBridge.instance?.config?.voiceSystem || {}
  }

  buildProvider(config) {
    const provider = String(config.provider || "volcengine").toLowerCase()
    if (provider !== "volcengine") {
      throw new Error(`暂不支持语音供应商: ${provider}`)
    }
    return new VolcengineVoiceProvider(config.volcengine || {})
  }

  async func(opts, e) {
    const config = this.getVoiceSystemConfig()
    if (config.enabled !== true) {
      return "语音系统还没开启，先用文字回复。"
    }

    const rawText = opts?.text || ""
    const guardedText = personaFeedbackManager.guardReply(rawText, pluginBridge.instance?.config?.personaGuard, {
      userText: e?.msg || "",
      botNames: [e?.bot?.nickname, pluginBridge.instance?.config?.persona?.name]
    })
    const text = sanitizeVoiceText(guardedText, config.maxTextLength || 80)
    if (!text) return "语音内容为空，先不发语音。"

    const styleName = opts?.style || selectVoiceStyle(text, config.styles || {})
    const style = getVoiceStyleConfig(config, styleName)
    let filePath = ""
    try {
      const provider = this.buildProvider(config)
      const result = await provider.synthesizeToFile({ text, style })
      filePath = result.filePath
      await e.reply(segment.record(filePath))
      scheduleVoiceFileCleanup(filePath, config.cleanupDelayMs || 5 * 60 * 1000)
      return `语音已发送。语音内容是：${text}。后续不要再用文字重复这段语音。`
    } catch (error) {
      if (filePath) scheduleVoiceFileCleanup(filePath, 1000)
      return `发送语音失败: ${error.message}`
    }
  }
}
