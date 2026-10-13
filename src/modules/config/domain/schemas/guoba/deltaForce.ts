import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'
const schema: ConfigSchemaItem[] = [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "三角洲行动"
  },
  { component: "Divider", label: "第三方 API" },
  {
    field: "deltaForceSystem.enabled",
    label: "启用三角洲工具",
    component: "Switch",
    bottomHelpMessage: "开启后可使用 .三角洲 和 .三角洲 今日密码"
  },
  {
    field: "deltaForceSystem.apiBaseUrl",
    label: "API Base URL",
    component: "Input",
    bottomHelpMessage: "第三方 API 域名，例如 https://example.com；请求路径会自动拼接 /api/v1/df/..."
  },
  {
    field: "deltaForceSystem.apiKey",
    label: "三角洲 API Key",
    component: "InputPassword",
    bottomHelpMessage: "每个三角洲接口请求都会放入 Header：X-API-Key"
  },
  {
    field: "deltaForceSystem.timeoutMs",
    label: "请求超时（毫秒）",
    component: "InputNumber",
    bottomHelpMessage: "默认 10000；第三方接口慢或不稳定时可适当调大",
    componentProps: { min: 1000, max: 60000, step: 1000, placeholder: "10000" }
  },
  { component: "Divider", label: "物品字典缓存" },
  {
    field: "deltaForceSystem.objectCacheEnabled",
    label: "启用物品字典缓存",
    component: "Switch",
    bottomHelpMessage: "缓存 /api/v1/df/object/list，用于把 objectID 翻译成物品名"
  },
  {
    field: "deltaForceSystem.objectCacheRefreshMinutes",
    label: "物品缓存刷新间隔（分钟）",
    component: "InputNumber",
    bottomHelpMessage: "默认 360 分钟；缓存会落盘到 database/delta-force-objects.json",
    componentProps: { min: 10, max: 1440, step: 10, placeholder: "360" }
  }
]

export default schema
