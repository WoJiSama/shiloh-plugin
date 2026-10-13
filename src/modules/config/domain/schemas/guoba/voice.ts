import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'
const schema: ConfigSchemaItem[] = [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "希洛语音"
  },
  { component: "Divider", label: "语音系统" },
  {
    field: "voiceSystem.enabled",
    label: "启用语音系统",
    component: "Switch",
    bottomHelpMessage: "阶段一为 QQ 语音消息；阶段三实时通话会复用同一套 provider 配置"
  },
  {
    field: "voiceSystem.provider",
    label: "语音供应商",
    component: "Select",
    componentProps: {
      options: [{ label: "火山引擎 / 豆包声音复刻", value: "volcengine" }]
    }
  },
  {
    field: "voiceSystem.maxTextLength",
    label: "单条语音最大字数",
    component: "InputNumber",
    bottomHelpMessage: "语音消息适合短句，过长会被截断成口播短句",
    componentProps: { min: 8, max: 300, step: 1, placeholder: "80" }
  },
  { component: "Divider", label: "火山引擎 V3" },
  {
    field: "voiceSystem.volcengine.endpoint",
    label: "V3 接口地址",
    component: "Input",
    componentProps: { placeholder: "https://openspeech.bytedance.com/api/v3/tts/unidirectional" }
  },
  {
    field: "voiceSystem.volcengine.appId",
    label: "App ID",
    component: "Input"
  },
  {
    field: "voiceSystem.volcengine.accessToken",
    label: "Access Token",
    component: "InputPassword"
  },
  {
    field: "voiceSystem.volcengine.resourceId",
    label: "Resource ID",
    component: "Input",
    bottomHelpMessage: "火山 V3 资源 ID，按火山控制台/文档给出的值填写"
  },
  {
    field: "voiceSystem.volcengine.voiceType",
    label: "希洛音色 ID",
    component: "Input",
    bottomHelpMessage: "声音复刻完成后得到的音色标识"
  },
  {
    field: "voiceSystem.volcengine.format",
    label: "音频格式",
    component: "Select",
    componentProps: {
      options: [
        { label: "mp3", value: "mp3" },
        { label: "wav", value: "wav" },
        { label: "ogg", value: "ogg" }
      ]
    }
  },
  {
    field: "voiceSystem.volcengine.sampleRate",
    label: "采样率",
    component: "InputNumber",
    componentProps: { min: 8000, max: 48000, step: 1000, placeholder: "24000" }
  },
  {
    field: "voiceSystem.volcengine.speedRatio",
    label: "默认语速",
    component: "InputNumber",
    componentProps: { min: 0.5, max: 2, step: 0.05, placeholder: "1.0" }
  },
  {
    field: "voiceSystem.volcengine.pitchRatio",
    label: "默认音高",
    component: "InputNumber",
    componentProps: { min: 0.5, max: 2, step: 0.05, placeholder: "1.0" }
  },
  {
    field: "voiceSystem.volcengine.volumeRatio",
    label: "默认音量",
    component: "InputNumber",
    componentProps: { min: 0.1, max: 3, step: 0.1, placeholder: "1.0" }
  },
  {
    field: "voiceSystem.volcengine.emotion",
    label: "默认情绪",
    component: "Input",
    bottomHelpMessage: "可留空；如果火山音色支持情绪参数，再按控制台能力填写"
  },
  {
    field: "voiceSystem.volcengine.stylePrompt",
    label: "默认风格提示",
    component: "InputTextArea",
    bottomHelpMessage: "可留空；用于后续支持的声音风格提示"
  }
]

export default schema
