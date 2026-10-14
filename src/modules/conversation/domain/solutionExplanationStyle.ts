function normalizeText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const TECHNICAL_DOMAIN_RE = /(?:代码|编程|开发|项目|系统|架构|模块|接口|服务|前端|后端|数据库|SQL|MySQL|PostgreSQL|Redis|MQ|消息队列|API|SDK|WPF|WinForms|Prism|Spring|Spring Boot|Node(?:\.js)?|JavaScript|TypeScript|Python|Java|C#|\.NET|C\+\+|PLC|S7|EF|Entity Framework|Docker|Kubernetes|K8s|Nginx|Linux|服务器|部署|日志|依赖|版本|构建|测试|重构|数据流|表结构|权限|认证|缓存|并发|性能|网络|协议|算法|机器学习|模型|Minecraft|\bMC\b|模组|Modrinth|CurseForge|Fabric|Forge|NeoForge|Quilt|Mixin|模组开发|\bmods?\b)/i
const SOLUTION_ACTION_RE = /(?:怎么(?:做|设计|实现|搭|写|改)|如何(?:做|设计|实现|搭|写|改)|帮(?:我)?(?:设计|实现|搭|写|改|规划|梳理)|(?:设计|实现|搭建|开发|重构|规划|梳理|拆解|写)(?:一套|一个|这个|下|一下|方案|架构|系统|项目|模块|代码)|(?:技术|实施|开发|架构|改造)方案|需求(?:分析|设计|拆解)?|给(?:我)?(?:一个|套).{0,12}(?:方案|架构|设计|代码)|(?:方案|架构|代码|模块|接口).{0,16}(?:怎么|如何|能不能|可以吗|行不行))/i
const DIAGNOSTIC_ACTION_RE = /(?:为什么|为啥|怎么回事|哪里(?:有)?问题|报错|失败|不(?:能|行|对)|异常|排查|修复|解决|卡住|崩了|没反应|慢)/i
const EXPLANATION_ACTION_RE = /(?:解释|讲解|讲讲|说明|分析|总结|整理|梳理|原理|定义|推导|对比|评价)/i

/**
 * Detect requests that benefit from a deliverable-first technical explanation.
 * The input may include quoted or forwarded content, so a short “这个怎么做”
 * can still inherit the technical subject from its visible context.
 */
export function classifySolutionExplanationRequest(text = "") {
  const content = normalizeText(text)
  if (!content || !TECHNICAL_DOMAIN_RE.test(content)) return ""
  if (SOLUTION_ACTION_RE.test(content)) return "solution"
  if (DIAGNOSTIC_ACTION_RE.test(content)) return "diagnostic"
  if (EXPLANATION_ACTION_RE.test(content)) return "explanation"
  return ""
}

export function buildSolutionExplanationStylePrompt(text = "") {
  const kind = classifySolutionExplanationRequest(text)
  if (!kind) return ""

  const common = [
    "【方案式技术解释】",
    "当前是技术方案、实现、排障或代码设计类问题。按可落地的方式回答，不要提及这段规则。",
    "- 第一行先给明确的交付或结论，直接点出你会给出什么方案、骨架或判断。可以自然说“我来给你把这个搭/拆开”，但后面必须立刻接实质内容；不要只说“收到”“我先看看”。",
    "- 把事实、已知条件和暂定假设分开；信息不全时，先给能运行的最小方案并标明假设，不要空等用户补全。",
    "- 用少量有意义的小节按层级展开：结论或选择、前置条件、核心模块或步骤、关键接口/数据流、最小验证。不要把每一句都拆成卡片，也不要为了格式凑满固定条数。",
    "- 用户在问入门路线、依赖清单或“都需要什么”时，明确分开‘必须先确定’、‘最小可运行版本’和‘后续再学’，每一项说明它解决什么问题；避免只罗列名词。",
    "- 给出版本、框架、工具链或平台选择时，说明兼容关系、取舍和一个保守的起步组合；不要把互不兼容的选项混写成同一套步骤。",
    "- 关键边界要落到具体模块、接口、字段、调用顺序或短代码示例；不确定的技术细节不能编造。",
    "- 结尾只在开放式设计题里留一个具体的下一步选择，例如要先展开哪一个模块；封闭问题答完即止。",
    "- 默认用清晰的 Markdown 层级组织内容：标题、结论、步骤、清单、提示和代码块各自独立；系统会按用户问题将科普和入门讲解渲染为结构化知识卡。用户明确要求纯文本、Markdown 原文或代码原文时，才保留原文。"
  ]

  if (kind === "diagnostic") {
    common.splice(3, 0, "- 排障时按“现象与结论 -> 可验证原因 -> 修复动作 -> 验证方式”说明，清楚区分已经确认的事实和推测；不要用泛泛的“可能是”“再试试”收尾。")
  } else if (kind === "explanation") {
    common.splice(3, 0, "- 纯技术解释先给一句结论或核心模型，再用模块、流程或例子拆开；不要只堆定义。对于游戏模组/插件开发，要额外交代目标版本、加载器或运行平台、语言与构建工具、代码与资源目录、运行侧边界，以及本地调试和最终发布路径。")
  }

  return common.join("\n")
}
