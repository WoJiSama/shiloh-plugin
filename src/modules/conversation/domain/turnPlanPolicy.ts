const DELIBERATE_REASONING_RE = /严格证明|完整推导|逐步推导|严谨分析|多步推理|证明(?:一下|下)?|计算过程|(?:对比|比较|区别|差异|优劣).{0,24}(?:和|还是|与)|(?:和|还是|与).{0,24}(?:哪个更|怎么选|选哪个|哪个好)|(?:对比|比较)一下.{0,24}(?:选哪个|哪个好|哪个更|怎么选)|(?:报错|失败|异常|崩了|崩溃|卡住|没反应|连不上|不生效|没用).{0,24}(?:为什么|为啥|怎么回事|怎么办|怎么|如何)|(?:为什么|为啥|怎么回事).{0,24}(?:报错|失败|异常|崩了|崩溃|卡住|没反应)|(?:方案|计划|规划|步骤|流程).{0,16}(?:怎么|如何|怎么做|怎么排)/

export function needsDeliberateReasoning(text = "") {
  const content = String(text || "")
  if (DELIBERATE_REASONING_RE.test(content)) return true
  const questionSignals = (content.match(/为什么|为啥|怎么回事|怎么办|如何/g) || []).length +
    (content.match(/[?？]/g) || []).length
  return questionSignals >= 3
}

export function isCasualChatTurn(text = "") {
  const content = String(text || "").replace(/\s+/g, " ").trim()
  if (!content || content.length > 48) return false
  return !/(为什么|为啥|怎么回事|怎么做|如何|解释|讲解|分析|比较|总结|规划|代码|报错|配置|接口|API|算法|推导|证明|搜索|查询)/i.test(content)
}

