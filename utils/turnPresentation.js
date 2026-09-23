// 回合呈现判定:从 apps/test.js 原样迁出的纯函数,供主链路与提示词组装共用。
import { normalizeIntentText } from "../core/intent/messageIntent.js"
import { isNarrativeWritingRequest } from "./narrativeReply.js"

export function isCodeOrMarkdownRequest(text = "") {
  const content = String(text || "").toLowerCase()
  return /写.*(代码|算法|函数|脚本|程序|markdown|md|文档)|给.*(代码|示例代码|算法|markdown|md文档)|实现.*(算法|函数|代码|脚本|程序)|生成.*(代码|markdown|md文档|文档)|编写.*(代码|markdown|md|文档)|代码给我|md文档|markdown文档|代码截图/.test(content)
}

export function isEducationalExplanationRequest(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  if (/(为什么|为何).{0,12}(失败|没回|没反应|报错|不能|不行|画不出来|发不出来|撤回|崩了|卡住)|怎么配置|怎么设置|接口|API|api|key|token|上游|日志/.test(content)) {
    return false
  }
  if (/(表情包|表情|插件|机器人|文件|导入|删除|重启|禁言|群名片)/.test(content)) {
    return false
  }
  return /(科普|讲解|讲讲|解释|解释一下|推导|证明|总结|整理|梳理|公式|原理|定义|概念|知识点|例题|举例|怎么理解|常见.*公式|什么是).{0,60}/.test(content) ||
    /(导数|微积分|极限|积分|函数|定理|物理|化学|生物|历史|地理|天文|宇宙|经济|哲学|语法|算法|机器学习).{0,30}(讲|解释|公式|原理|定义|推导|证明|总结|科普)/.test(content)
}

export function resolveCardPresentation(userText = "", responseKind = "chat") {
  if (isNarrativeWritingRequest(userText)) return "narrative"
  if (responseKind === "knowledge" && normalizeIntentText(userText).length >= 12) return "knowledge"
  if (isCodeOrMarkdownRequest(userText)) return "document"
  return ""
}
