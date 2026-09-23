import { classifyEmojiToolExposure, getEmojiToolIntentPatterns } from "./emojiToolPolicy.js"
import { buildExcelToolParams } from "./excelRequestPolicy.js"
import { parseModrinthRequestOptions } from "./modrinth.js"
import { extractGroupKnowledgeForgetTarget, isExplicitGroupKnowledgeForgetRequest } from "./groupKnowledgeForgetPolicy.js"
import { extractValidBtihMagnetUri } from "./torrentDownload.js"
import { parsePixivDownloadRequest } from "./pixivIntent.js"

function normalizeText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    // TRSS strips a configured bot alias before this layer. Preserve the request
    // while removing the punctuation left by forms such as "希洛，查一下...".
    .replace(/^\s*[，,、。:：;；!?！？]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
}

const TOOL_INTENT_MANIFESTS = {
  deltaForceTool: {
    triggers: [
      /三角洲/,
      /改枪码|改枪方案|方案码|枪码/,
      /特勤处|制造利润|利润排行/,
      /价格历史|历史价格|价格走势|折线图|趋势图/,
      /今日密码|每日密码/
    ],
    disclosure: [
      "【deltaForceTool 详细用法】",
      "用途：查询三角洲行动相关接口数据。",
      "不要被“今天的/最新的/发一下”干扰，先看用户真正要查的子功能。",
      "operation 选择规则：",
      "- 改枪码、改枪方案、方案码、枪码 -> operation=solution_list",
      "- 价格历史、历史价格、价格走势、价格曲线、折线图、趋势图 -> operation=price_history",
      "- 物品价值、价格、多少钱、值多少 -> operation=object_value",
      "- 特勤处利润、制造利润 -> operation=place_profit",
      "- 利润排行、利润榜 -> operation=profit_rank",
      "- 今日密码、每日密码、口令 -> operation=daily_keyword",
      "keyword 抽取规则：",
      "- “我要和277有关的”“关于 H70 的”“查 M4A1 相关”里的 277/H70/M4A1 是 keyword。",
      "- “名字有 非洲 的物品价格”“名称包含 非洲 的物品价值”里的 非洲 是 keyword；不要把“名字有/物品/价格”放进 keyword。",
      "- 对 solution_list，keyword 可选但有关键词就必须填写。",
      "- 对 object_value，keyword 必填；缺关键词时不要乱填，应选择 chat 追问。",
      "- 对 price_history，keyword 必填；days 默认 30；limit 表示要给几个匹配物品画图，默认 5。",
      "等价例子：",
      "- “希洛发一下今天的三角洲的改枪码，我要和277有关的” -> {\"operation\":\"solution_list\",\"keyword\":\"277\"}",
      "- “三角洲 H70 现在多少钱” -> {\"operation\":\"object_value\",\"keyword\":\"H70\"}",
      "- “三角洲显卡最近价格走势折线图” -> {\"operation\":\"price_history\",\"keyword\":\"显卡\"}",
      "- “希洛告诉我今天的三角洲的名字有 非洲 的物品的价格” -> {\"operation\":\"object_value\",\"keyword\":\"非洲\"}",
      "- “看下三角洲工作台利润排行前5” -> {\"operation\":\"profit_rank\",\"place\":\"工作台\",\"limit\":5}",
      "- “三角洲今日密码” -> {\"operation\":\"daily_keyword\"}"
    ].join("\n")
  },
  reminderTool: {
    triggers: [
      /提醒我|叫我|到点|定个?闹钟|设个?提醒|别忘了|待会儿|过\d+秒|过\d+分钟|过\d+小时|\d+点.*提醒/
    ],
    disclosure: [
      "【reminderTool 详细用法】",
      "用途：创建、查看、取消定时提醒。",
      "operation/action 选择规则：",
      "- 用户说“提醒我/叫我/到点告诉我/定个提醒” -> action=create",
      "- 用户说“我的提醒/提醒列表/有哪些提醒” -> action=list",
      "- 用户说“取消提醒/删掉提醒” -> action=cancel；没有 reminder_id 时选 chat 追问。",
      "时间抽取规则：",
      "- 相对时间必须根据当前北京时间换算成 ISO 8601，并带 +08:00。",
      "- “10分钟后提醒我喝水” -> reminder_time 为当前时间 +10 分钟，content=喝水。",
      "- reminder_message 要像群友自然提醒，不要写成正式系统通知。",
      "等价例子：",
      "- “半小时后提醒我收菜” -> {\"action\":\"create\",\"content\":\"收菜\",\"reminder_message\":\"该收菜啦\",\"reminder_time\":\"按当前北京时间+30分钟\"}",
      "- “看看我的提醒” -> {\"action\":\"list\"}"
    ].join("\n")
  },
  searchMusicTool: {
    triggers: [
      /点歌|放首|听歌|来首|唱一首|播放.+歌|想听|随机.*歌/
    ],
    disclosure: [
      "【searchMusicTool 详细用法】",
      "用途：搜索并发送 QQ 音乐卡片。",
      "keyword 抽取规则：",
      "- 指定歌曲时 keyword=歌曲名或 歌曲名+歌手。",
      "- 只给歌手名或“来首周杰伦的歌”时 isArtistOnly=true，keyword=歌手名。",
      "- 不要把“放首/点歌/想听”等动词放入 keyword。",
      "等价例子：",
      "- “希洛点一首晴天” -> {\"keyword\":\"晴天\",\"isArtistOnly\":false}",
      "- “来首周杰伦的” -> {\"keyword\":\"周杰伦\",\"isArtistOnly\":true}"
    ].join("\n")
  },
  voiceTool: {
    triggers: [
      /语音|发条语音|用语音|念出来|读出来|说给我听|录一段/
    ],
    disclosure: [
      "【voiceTool 详细用法】",
      "用途：发送短 QQ 语音。",
      "调用边界：",
      "- 只有用户明确要求语音/念出来/读出来时调用。",
      "- 不要用它读长文、代码、列表、搜索结果或工具结果。",
      "参数规则：",
      "- text 必须是短句、纯口播文字，不要 Markdown、代码或动作描写。",
      "- style 可选 normal/shy/tease/serious/sleepy；不确定就省略。",
      "等价例子：",
      "- “希洛用语音说晚安” -> {\"text\":\"晚安，早点睡哦\",\"style\":\"sleepy\"}"
    ].join("\n")
  },
  sendLocalEmojiTool: {
    triggers: getEmojiToolIntentPatterns(),
    disclosure: [
      "【sendLocalEmojiTool 详细用法】",
      "用途：从本地表情包库挑一张合适的表情包发送。",
      "它是主对话的一种回复形态：不调用=纯文字；不填配文=纯表情；leadText 在表情前说，followUpText 在表情后补。请先规划整轮节奏，不要机械地每轮调用。",
      "调用边界：",
      "- 用户明确要表情包/斗图/发个表情时优先调用。",
      "- 普通轻松闲聊中，如果表情比文字更自然，可以主动调用。",
      "- 表情已经足够表达当前情绪时，只发表情包，不要填写任何配文。",
      "- 需要先抛一句再甩图时填 leadText；表情之后仍有事实、行动或转折必须补充时填 followUpText。",
      "- leadText 和 followUpText 默认只选一个；只有两段含义不同且表情放在中间明显更自然时才两边都填。",
      "- 严肃问答、技术排查、长说明、工具结果汇报、群管理处理时不要调用。",
      "参数规则：",
      "- tags 按相关度填写 1-5 个真实情绪标签，第一个是主情绪；例如无语、震惊、笑死、吐槽、尴尬、疲惫、委屈、安慰。",
      "- useCases 可补 1-4 个真实场景；例如无言以对、看到离谱、接梗吐槽、群友翻车、场面尴尬、安慰对方。",
      "- query 只补充标签未覆盖的短关键词，不要写完整场景长句。",
      "- leadText/followUpText 都不超过 80 字，不要把一个句子的主谓宾拆到表情两侧。",
      "- 一次只发一张，别连发刷屏。",
      "等价例子：",
      "- “来个无语表情包” -> {\"tags\":[\"无语\",\"震惊\"],\"useCases\":[\"无言以对\",\"看到离谱\"]}",
      "- 群友翻车时只想甩图 -> {\"tags\":[\"笑死\",\"吐槽\"],\"useCases\":[\"群友翻车\",\"接梗吐槽\"]}",
      "- 先吐槽再甩图 -> {\"tags\":[\"无语\",\"吐槽\"],\"leadText\":\"你又来了\"}",
      "- 甩图后补充到达信息 -> {\"tags\":[\"认怂\",\"无奈\"],\"useCases\":[\"认怂求饶\"],\"followUpText\":\"我马上到\"}"
    ].join("\n")
  },
  mentionMembersTool: {
    triggers: [
      /(?:帮(?:我|忙)?|麻烦|请|可以|能不能)?[^\n]{0,40}(?:艾特|@|通知|喊(?:一下|人)?|叫(?:一下|人)?)/i
    ],
    disclosure: [
      "【mentionMembersTool 详细用法】",
      "用途：在当前群里真实艾特指定成员并发送通知。",
      "调用边界：",
      "- 只在用户明确要求通知/@具体成员，或已教会的群工作流明确匹配且当前用户要求执行时调用。",
      "- targets 优先填可靠上下文给出的 QQ 号；没有明确对象时不要猜。",
      "- 不要把普通讨论当作通知命令。",
      "等价例子：",
      "- ‘有人要挂团，帮我艾特’ -> 按群工作流提供的 targets 通知",
      "- ‘通知 @小明和@小红开会’ -> targets=[小明,小红], message=开会"
    ].join("\n")
  },
  mentionAdminsTool: {
    triggers: [
      /(?:艾特|@|通知|喊(?:一下|人)?|叫(?:一下|人)?).{0,32}(?:(?:所有|全部|全体).{0,8}(?:管理员|管理|群管)|(?:管理员|管理|群管)(?:们|全体)|(?:管理们|群管们)|(?:除了?|除去).{0,40}(?:管理员|管理|群管))/iu
    ],
    disclosure: [
      "【mentionAdminsTool 详细用法】",
      "用途：在当前群真实艾特一个管理员集合并发送通知。",
      "调用边界：",
      "- 只有‘所有管理员’‘管理员们’‘管理们’‘全体群管’或明确排除一部分管理员等集合措辞才能调用。",
      "- ‘群主’是唯一角色，绝不能用此工具；应由 mentionMembersTool 精确艾特当前群主。",
      "- message 只保留要传达的通知内容；includeOwner 仅在用户明确说管理员集合还要包含群主时为 true。",
      "等价例子：",
      "- ‘艾特所有管理员说有人要挂团’ -> {\"message\":\"有人要挂团\",\"includeOwner\":false}",
      "- ‘通知全体群管和群主开会’ -> {\"message\":\"开会\",\"includeOwner\":true}"
    ].join("\n")
  },
  forgetGroupKnowledgeTool: {
    triggers: [
      /(?:忘(?:掉|记)?|删(?:掉|除)?|清除|移除).{0,48}(?:记忆|群知识|记住|教会|定义|我的|我之前)/u,
      /(?:我的|我之前|群里的?).{0,48}(?:记忆|群知识|记住|教会|定义)?.{0,24}(?:忘(?:掉|记)?|删(?:掉|除)?|清除|移除)/u
    ],
    disclosure: [
      "【forgetGroupKnowledgeTool 详细用法】",
      "用途：删除当前群由语义教学提交的某一条群知识、别名或通知规则。",
      "调用边界：",
      "- 只有用户明确说忘掉、删除、清除自己之前教会的群知识时调用。",
      "- memory 填用户要忘掉的称呼；‘我的星怒’里的‘我的’必须保留。",
      "- 普通成员只删除自己创建的唯一匹配项；群主、管理员或主人可处理其他人的精确条目。找不到或多条候选时不会删除。",
      "- 不能用于聊天记录、群文件本体、其他人的记忆或泛泛的‘忘了吧’。",
      "等价例子：",
      "- ‘忘掉我的星怒’ -> {\"memory\":\"我的星怒\"}",
      "- ‘把我之前教你的地图删掉’ -> {\"memory\":\"地图\"}"
    ].join("\n")
  },
  emojiSearchTool: {
    triggers: [
      /搜.*表情包|网上.*表情包|堆糖.*表情/
    ],
    disclosure: [
      "【emojiSearchTool 详细用法】",
      "用途：从远程网站按关键词搜索表情包。只有用户明确要网上搜索表情包时使用；普通发图优先 sendLocalEmojiTool。",
      "参数规则：",
      "- keyword 是表情主题，如 猫猫、无语、开心、抱抱。",
      "- count 默认 1；范围 1-10。"
    ].join("\n")
  },
  searchInformationTool: {
    triggers: [
      /搜索|查一下|搜一下|最新|今天.*新闻|现在.*(?:价格|天气|政策|消息)|实时|资料|百科/
    ],
    disclosure: [
      "【searchInformationTool 详细用法】",
      "用途：需要实时信息、外部资料、新闻、政策、当前价格、搜索结果时调用。",
      "调用边界：",
      "- 普通知识、闲聊、已有上下文能回答时不要调用。",
      "- 用户给了具体网页 URL 并要解析网页内容，优先 webParserTool。",
      "- 用户给了 GitHub 仓库链接并问仓库信息，优先 githubRepoTool。",
      "参数规则：",
      "- query 写完整搜索词，保留关键限定词，如日期、地区、产品名。",
      "等价例子：",
      "- “查一下今天 OpenAI 有什么新闻” -> {\"query\":\"今天 OpenAI 新闻\"}"
    ].join("\n")
  },
  webParserTool: {
    triggers: [
      /https?:\/\/\S+|www\.\S+|解析.*网页|总结.*链接|看看.*链接|这个网址/
    ],
    disclosure: [
      "【webParserTool 详细用法】",
      "用途：解析用户给出的网页链接内容并提取关键信息。",
      "调用边界：",
      "- 用户只给搜索需求但没有 URL 时不要调用，改用 searchInformationTool。",
      "- GitHub 仓库 URL 且用户问仓库信息时优先 githubRepoTool。",
      "参数规则：",
      "- url 只填写单个网页 URL；如果用户给多个链接，优先处理最相关的一个或选 chat 追问。",
      "等价例子：",
      "- “帮我总结 https://example.com 这个页面” -> {\"url\":\"https://example.com\"}"
    ].join("\n")
  },
  githubRepoTool: {
    triggers: [
      /github\.com\/[^/\s]+\/[^/\s]+|GitHub.*仓库|仓库.*star|repo/
    ],
    disclosure: [
      "【githubRepoTool 详细用法】",
      "用途：获取 GitHub 仓库基本信息、提交、issue、PR、贡献者等。",
      "调用边界：",
      "- 只有明确是 GitHub 仓库 URL 或询问仓库信息时调用。",
      "- 普通网页链接不要调用，改用 webParserTool。",
      "参数规则：",
      "- repoUrl 必须是 GitHub 仓库 URL，不要填 issue、release、文件路径以外的普通网页。",
      "等价例子：",
      "- “看看 https://github.com/user/repo 这个仓库怎么样” -> {\"repoUrl\":\"https://github.com/user/repo\"}"
    ].join("\n")
  },
  aiMindMapTool: {
    triggers: [
      /思维导图|脑图|mind ?map|整理成导图|生成导图|知识结构图/
    ],
    disclosure: [
      "【aiMindMapTool 详细用法】",
      "用途：把主题、材料或说明整理成 Markmap 思维导图图片。",
      "参数规则：",
      "- prompt 写要整理成导图的主题和内容。",
      "- 不确定尺寸时不要填 width/height。",
      "- 用户只是要普通总结/列表，不要调用；明确要导图/脑图才调用。",
      "等价例子：",
      "- “把这段 Java 学习路线做成思维导图” -> {\"prompt\":\"Java 学习路线...\"}"
    ].join("\n")
  },
  excelWorkbookTool: {
    triggers: [
      /Excel|\.xlsx\b|\.xlsm\b|工作簿|工作表|sheet|tab页|单元格/i,
      /(?:表格|文件).{0,24}\b[A-Z]{1,3}[1-9]\d{0,6}\b/i,
      /(?:查|看|读|告诉我).{0,20}\b[A-Z]{1,3}[1-9]\d{0,6}\b/i,
      /(?:附近|周围|相邻).{0,20}(?:单元格|格子)|(?:单元格|格子).{0,30}(?:开头|结尾|包含|等于)/i
    ],
    disclosure: [
      "【excelWorkbookTool 详细用法】",
      "用途：读取用户当前、引用、最近上传或当前群文件仓库中的 .xlsx/.xlsm 工作簿；查询 tab、单元格、区域或搜索内容。",
      "操作选择：",
      "- 问群文件里有哪些 Excel/列出群文件表格 -> operation=list_group_excels，可用 query 过滤文件名",
      "- 问有哪些 tab/sheet/工作表 -> operation=list_sheets",
      "- 问某个格子（如 Sheet1 的 B7） -> operation=read_cell，sheetName=Sheet1，cell=B7",
      "- 问一小块区域 -> operation=read_range，range=A1:D10",
      "- 在某个 tab 里找文字、数字或公式 -> operation=find，query=关键词，可填 sheetName",
      "- 用户说‘开头是/结尾是/完全等于/包含’时，把语义分别映射为 matchMode=starts_with/ends_with/exact/contains。不要要求用户改成固定格式。",
      "- 用户说‘某个单元格附近/周围’时，从当前对话和上一轮 Excel 结果理解中心格，使用 operation=find + anchorCell；rowRadius/columnRadius 控制邻域。若用户明确给区域则改填 range。",
      "- 用户只说‘附近’但上下文没有任何中心单元格时，不要编一个地址；省略 anchorCell，搜索指定 sheet 或整个工作簿。",
      "- sheetName 既可填名称，也可填从 1 开始的序号；用户说第二个 tab 时直接填 sheetName=2，不要先 list_sheets。",
      "- 用户问“与某概念相关”且原词可能不会字面出现时，可填写 relatedTerms；工具会区分原词精确命中与关联词命中。",
      "结果规则：",
      "- read_cell 会返回精确公式、工作簿保存的计算值和显示值；最终回复必须原样列出公式和值，禁止自行改写公式或猜计算结果。",
      "- 用户上传/引用了文件时不要填写 fileUrl；工具会自动找文件。用户说“群文件里的预算.xlsx”时填写 fileName=预算.xlsx；同名时再填 folderPath。",
      "- 只有用户明确给 HTTP/HTTPS Excel 链接时才填写 fileUrl。",
      "- 如果用户既没说 sheet 名也没说序号，且工作簿有多个 tab，才先 list_sheets；明确说第几个时直接用序号。",
      "- 旧版 .xls 不支持，提示另存为 .xlsx。",
      "等价例子：",
      "- “查一下预算表这个 tab 的 C12，公式和值都给我” -> {\"operation\":\"read_cell\",\"sheetName\":\"预算表\",\"cell\":\"C12\"}",
      "- “在明细这个 sheet 里找订单 20260715” -> {\"operation\":\"find\",\"sheetName\":\"明细\",\"query\":\"20260715\",\"searchIn\":\"all\"}",
      "- “这个 Excel 有哪些 tab” -> {\"operation\":\"list_sheets\"}",
      "- “群文件里有哪些 Excel” -> {\"operation\":\"list_group_excels\"}",
      "- “第二个 tab 里找跟 .st 有关的内容” -> {\"operation\":\"find\",\"sheetName\":\"2\",\"query\":\".st\",\"relatedTerms\":[\"属性\",\"技能\",\"STR\",\"CON\",\"DEX\",\"POW\",\"EDU\",\"SAN\"]}",
      "- 上一轮刚查过 B40，用户接着说‘看附近有没有一个是尚虹叙开头的，告诉我单元格’ -> {\"operation\":\"find\",\"query\":\"尚虹叙\",\"matchMode\":\"starts_with\",\"anchorCell\":\"B40\",\"rowRadius\":10,\"columnRadius\":5}",
      "- “查群文件预算.xlsx里预算表的 C12” -> {\"operation\":\"read_cell\",\"fileName\":\"预算.xlsx\",\"sheetName\":\"预算表\",\"cell\":\"C12\"}"
    ].join("\n")
  },
  modrinthTool: {
    triggers: [
      /(?:^|[\s（(，,])Modrinth(?=.{0,36}(?:模组|mods?|排行|排名|前\s*\d+|热门|下载量|关注|版本|Fabric|Forge|NeoForge|Quilt))/i,
      /(?:查|看|搜|告诉我|给我说|发我).{0,6}Modrinth(?=.{0,36}(?:模组|mods?|排行|排名|前\s*\d+|热门|下载量|关注|版本|Fabric|Forge|NeoForge|Quilt))/i,
      /(?:MC|Minecraft|我的世界).{0,24}(?:模组|mod).{0,24}(?:排行|排名|前\s*\d+|热门|下载量|关注)/i,
      /(?:MC|Minecraft|我的世界).{0,24}(?:榜|排行|排名|前\s*\d+|热门|下载量|关注).{0,24}(?:模组|mod)/i,
      /(?:名字|名称).{0,24}(?:带有|包含|含有|有).{0,48}(?:MC|Minecraft).{0,8}(?:模组|mod)/i,
      /(?:模组|mod).{0,24}(?:排行|排名|前\s*\d+|热门|下载量|关注).{0,24}(?:MC|Minecraft|我的世界|Fabric|Forge|NeoForge|Quilt)/i
    ],
    disclosure: [
      "【modrinthTool 详细用法】",
      "用途：查询 Modrinth Minecraft 模组公开排名和英文原始简介。",
      "参数规则：",
      "- 默认 sort=downloads、limit=5。用户说下载量最高/热门前几 -> sort=downloads；关注最多 -> follows；最新发布 -> newest；最近更新 -> updated；带关键词找模组 -> relevance + query。",
      "- 用户给出 MC 版本时填写 gameVersion，例如 1.21.1；给出 Fabric/Forge/NeoForge/Quilt 时填写 loader。",
      "- 用户要求优化、冒险、装饰等分类时填写 Modrinth category slug，例如 optimization/adventure/decoration。",
      "- 工具返回的是英文官方简介。最终每个项目必须同时展示英文简介和‘中文翻译（希洛）’，中文只能忠实翻译英文，不能自行补充功能或兼容结论。",
      "- 只发项目页，绝不自动下载或发送 jar 文件。",
      "等价例子：",
      "- ‘查一下 Modrinth 1.21.1 Fabric 下载量前五的优化模组’ -> {\"sort\":\"downloads\",\"limit\":5,\"gameVersion\":\"1.21.1\",\"loader\":\"fabric\",\"category\":\"optimization\"}",
      "- ‘Modrinth 最近更新的机械模组前 3 个’ -> {\"sort\":\"updated\",\"limit\":3,\"query\":\"technology\"}"
    ].join("\n")
  },
  pixivSearchTool: {
    triggers: [
      /p站|pixiv/i,
      /(?:查|搜|找|寻|看看|看下)[^，,。！!？?\n]{0,6}(?:的)?(?:插画|作品|画师|同人图|美图|图集)/i,
      /(?:来点|来几张)[^，,。！!？?\n]{0,12}(?:的)?(?:图|插画|作品|立绘)/i,
      /(?:搜|查|找)[^，,。！!？?\n]{0,14}(?:的)?(?:图|插画|立绘)/i
    ],
    disclosure: [
      "【pixivSearchTool 详细用法】",
      "用途：搜索 Pixiv 插画并发送带缩略图的结果列表卡面。",
      "与必应图搜的分工(重要)：用户要插画/二次元图/同人图/画师作品时必须选本工具;bingImageSearchTool 只用于照片/实拍/截图/素材类找图。",
      "调用边界：",
      "- 用户想找现成的插画/作品/某画师的作品时调用；不是画图(画/生成新图走生图工具)、不是看图识图。",
      "- 找表情包时不要调用(走表情包工具)。",
      "keyword 抽取规则(最重要,逐条检查):",
      "- keyword 只保留搜索主体本身:角色名/画师名/作品名/标签,例如 wlop、海琴烟、初音未来、翠月。",
      "- 去掉所有框架词:「查一下/搜搜/帮我找/来点/看看」等动词、「跟X有关的图」只留X、「关于X」只留X、「的图/的作品/的插画」后缀、「一些/热门的/人气最高的」等修饰。",
      "- “找一下跟翠月有关的图” -> keyword=翠月;“来几张热门的海琴烟” -> keyword=海琴烟;“搜搜初音未来的图” -> keyword=初音未来。",
      "- 用户原话里的角色叫法优先保留(翠月/海琴烟/中文名都可以,搜索端会自动翻译匹配)。",
      "searchType:用户想看某位画师本人的作品(如「查wlop的作品」「看看XX画师」)传 artist;一般找图/找角色传 artworks(默认)。",
      "orderBy:默认 newest(最新);用户说热门/人气/最受欢迎/收藏最多传 popular;说最早/最旧传 oldest。",
      "等价例子：",
      "- “查一下wlop的作品” -> {\"keyword\":\"wlop\",\"searchType\":\"artist\"}",
      "- “找一下跟翠月有关的图” -> {\"keyword\":\"翠月\",\"searchType\":\"artworks\"}",
      "- “p站搜海琴烟” -> {\"keyword\":\"海琴烟\",\"searchType\":\"artworks\"}",
      "- “搜一些热门的初音未来同人图” -> {\"keyword\":\"初音未来 同人\",\"searchType\":\"artworks\",\"orderBy\":\"popular\"}",
      "搜索后引导用户:回复「下载 序号」(如 下载 1)或「下载 作品ID」即可搬运对应作品。"
    ].join("\n")
  },
  pixivDownloadTool: {
    triggers: [
      /(?:下载|下|搬运)\s*(?:第\s*)?\d{1,2}\s*(?:张|个|幅|图)?\s*(?:$|[。!！?？])/i,
      /(?:下载|下|搬运)\s*(?:id|ID|Id)?\s*\d{5,12}/i
    ],
    disclosure: [
      "【pixivDownloadTool 详细用法】",
      "用途：下载并搬运一张 Pixiv 插画到群里。",
      "调用边界：",
      "- 只在用户针对 Pixiv 搜索列表说「下载 N」「下载 作品ID」时调用。",
      "- 磁链、BT、多选编号(下载 1,3)走磁链下载工具,与本工具无关。",
      "参数规则：",
      "- target 是搜索列表里的序号(如 3)或作品ID(纯数字);不要带「下载/id」等字样。",
      "等价例子：",
      "- 搜索列表后“下载 2” -> {\"target\":\"2\"}",
      "- “下载 126649495” -> {\"target\":\"126649495\"}"
    ].join("\n")
  },
  torrentDownloadTool: {
    triggers: [
      /magnet:\?xt=urn:btih:/i,
      /(?:下载|下下来|搬运|发我|传我).{0,48}(?:磁链|磁力链接)/i,
      /(?:下载|下|选择|选)\s*(?:第\s*)?\d+(?:\s*(?:,|，|、)\s*(?:第\s*)?\d+)*/i
    ],
    disclosure: [
      "【torrentDownloadTool 详细用法】",
      "用途：下载用户当前消息中明确提供的 BT magnet 磁链，将符合限制的内容打成一个 ZIP 上传，并发送目录与压缩包说明的合并转发。若完整磁链超限，发起人可从工具列出的文件清单中选择部分文件。",
      "调用边界：",
      "- 只接受当前用户原样给出的 magnet:?xt=urn:btih: 磁链；HTTP 链接、种子网址、口头 hash 或猜测内容都不能用。",
      "- 群里出现有效 BTIH 磁链时会自动处理，行为与视频分享一致；无效磁链不调用。",
      "- 工具会先读取元数据并强制检查总大小、单文件大小、文件数和 ZIP 上传上限。超限时正文下载不会开始；无元数据、下载超时、打包或发送失败时不要声称已下载。",
      "参数规则：",
      "- magnet 逐字复制用户当前消息中的完整 magnet URI；不得缩短、改写或替换 tracker 参数。",
      "- 只有当前群内同一发起人在 30 分钟内收到过文件清单时，才可传 selection（1 起始编号数组）；例如用户说‘下载 1,3’则传 {\"selection\":[1,3]}。没有清单时不猜文件。",
      "等价例子：",
      "- ‘帮我下载 magnet:?xt=urn:btih:AF4B684892182408E4AE9DF0C8FFE9E49CCBF171’ -> {\"magnet\":\"用户原样磁链\"}",
      "- 已收到清单后：‘下载第2个’ -> {\"selection\":[2]}"
    ].join("\n")
  },
  textImageTool: {
    triggers: [
      /转成图片|生成图片版|长图|发成图|做成图|代码.*图片|Markdown.*图片|避免刷屏/
    ],
    disclosure: [
      "【textImageTool 详细用法】",
      "用途：把文字、Markdown、代码、长篇讲解渲染成图片发送。",
      "调用边界：",
      "- 用户要求写代码、Markdown 文档、长篇结构化内容时，适合调用。",
      "- 普通短回复不要调用。",
      "参数规则：",
      "- text 放完整要渲染的内容。",
      "- template: 短聊天气泡用 chat；长文、讲解、代码、Markdown 用 document。",
      "等价例子：",
      "- “把这段代码发成图片” -> {\"text\":\"完整代码\",\"template\":\"document\"}"
    ].join("\n")
  },
  pokeTool: {
    triggers: [
      /戳一戳|戳戳|戳一下|poke/
    ],
    disclosure: [
      "【pokeTool 详细用法】",
      "用途：对群成员发送戳一戳。",
      "参数规则：",
      "- target 是 QQ 号、群名片或昵称数组；被 @ 时优先用被 @ 人。",
      "- times 默认 1，最大 10。",
      "- 用户说随机戳人时 random=true。",
      "等价例子：",
      "- “戳一下小明” -> {\"target\":[\"小明\"],\"times\":1}"
    ].join("\n")
  },
  likeTool: {
    triggers: [
      /点赞|给.*赞|赞一下|QQ赞|名片赞/
    ],
    disclosure: [
      "【likeTool 详细用法】",
      "用途：给 QQ 用户点赞。",
      "参数规则：",
      "- qq 留空时默认给发送者或 @ 对象点赞。",
      "- count 默认 10，最多 20。",
      "- 随机点赞时 random=true。",
      "等价例子：",
      "- “给我点20个赞” -> {\"count\":20}"
    ].join("\n")
  },
  changeCardTool: {
    triggers: [
      /改群名片|改名片|改昵称|群昵称|把.*名字改成|改.*群名|群名片.{0,12}(?:改成|改为|换成|换为)/
    ],
    disclosure: [
      "【changeCardTool 详细用法】",
      "用途：修改群名片/群昵称。",
      "参数规则：",
      "- target 是目标用户；“把我改成X”时 target 填发送者/我。",
      "- cardName 是要改成的新群名片。",
      "- senderRole 按当前发送者身份 owner/admin/member 填写。",
      "等价例子：",
      "- “把我群名片改成小希” -> {\"target\":\"我\",\"cardName\":\"小希\",\"senderRole\":\"按发送者身份\"}"
    ].join("\n")
  },
  jinyanTool: {
    triggers: [
      /禁言|闭嘴|解除禁言|解禁|mute|全体禁言/
    ],
    disclosure: [
      "【jinyanTool 详细用法】",
      "用途：群禁言/解禁，属于权限敏感操作。",
      "调用边界：",
      "- 用户明确要求禁言/解禁，或明显违规且需要自主处理时才调用。",
      "- 不要因为普通玩笑、争论或轻微情绪就自主禁言。",
      "参数规则：",
      "- target 是目标 QQ/昵称数组；不要把时间词混进 target。",
      "- time 单位秒；解除禁言 time=0。",
      "- 被用户要求执行时 selfDecision=false；机器人自主处理违规时 selfDecision=true。",
      "- 全体禁言必须有明确请求和 confirm=true。",
      "等价例子：",
      "- “禁言小明一分钟” -> {\"target\":[\"小明\"],\"time\":60,\"selfDecision\":false}",
      "- “解除小明禁言” -> {\"target\":[\"小明\"],\"time\":0,\"selfDecision\":false}"
    ].join("\n")
  }
}

export function selectToolIntentCandidates(text = "", availableToolNames = [], context = {}) {
  const content = normalizeText(text)
  if (!content) return []
  const available = new Set(availableToolNames)
  const candidates = []
  for (const [toolName, manifest] of Object.entries(TOOL_INTENT_MANIFESTS)) {
    if (!available.has(toolName)) continue
    if (toolName === "sendLocalEmojiTool") {
      if (classifyEmojiToolExposure(content) !== "none") candidates.push(toolName)
      continue
    }
    if (manifest.triggers.some(pattern => pattern.test(content))) candidates.push(toolName)
  }
  return resolveCandidateConflicts(candidates, content, context)
}

function resolveCandidateConflicts(candidates = [], content = "", context = {}) {
  let resolved = [...candidates]

  // A reaction image must never turn an explicit operational request back into
  // a free-form chat turn. Explicitly asking for an emoji remains an override.
  if (resolved.includes("sendLocalEmojiTool") && classifyEmojiToolExposure(content) !== "explicit") {
    const hasOperationalTool = resolved.some(name => name !== "sendLocalEmojiTool")
    if (hasOperationalTool) {
      resolved = resolved.filter(name => name !== "sendLocalEmojiTool")
    }
  }

  // 「下载 N」在磁链选择与 Pixiv 列表之间有歧义:
  // - 磁链或多选编号始终归磁链工具;
  // - 5 位以上纯数字更像 Pixiv 作品ID;
  // - 短序号看哪边有活跃会话( Pixiv 侧用进程内存同步检查)。
  if (resolved.includes("pixivDownloadTool") && resolved.includes("torrentDownloadTool")) {
    const looksTorrent = /magnet:\?|磁链|磁力链接/.test(content) || /(?:下载|下|选择|选)\s*(?:第\s*)?\d+(?:\s*(?:,|，|、)\s*(?:第\s*)?\d+)+/.test(content)
    const looksPixivId = /(?:下载|下|搬运)\s*(?:id|ID)?\s*\d{5,12}/i.test(content)
    const preferPixiv = !looksTorrent && (looksPixivId || context.hasPixivSearchSession === true)
    resolved = resolved.filter(name => (preferPixiv ? name !== "torrentDownloadTool" : name !== "pixivDownloadTool"))
  }

  if (resolved.includes("githubRepoTool")) {
    resolved = resolved.filter(name => name !== "webParserTool" && name !== "searchInformationTool")
  }
  if (resolved.includes("modrinthTool")) {
    resolved = resolved.filter(name => name !== "webParserTool" && name !== "searchInformationTool")
  }
  if (resolved.includes("mentionAdminsTool")) {
    resolved = resolved.filter(name => name !== "mentionMembersTool")
  }

  const specificTools = resolved.filter(name => !["searchInformationTool", "webParserTool"].includes(name))
  if (specificTools.length) {
    resolved = resolved.filter(name => name !== "searchInformationTool")
  }

  return resolved
}

export function buildToolIntentDisclosure(toolNames = []) {
  const parts = []
  for (const name of toolNames) {
    const text = TOOL_INTENT_MANIFESTS[name]?.disclosure
    if (text) parts.push(text)
  }
  return parts.join("\n\n")
}

export function hasToolIntentManifest(toolName = "") {
  return Boolean(TOOL_INTENT_MANIFESTS[toolName])
}

function extractSingleUrl(text = "") {
  const urls = String(text || "").match(/https?:\/\/[^\s<>"']+/gi) || []
  if (urls.length !== 1) return ""
  return urls[0].replace(/[，。！？、；：,.!?;:]+$/u, "")
}

const DETERMINISTIC_TOOL_RESOLVERS = {
  torrentDownloadTool: text => {
    const magnet = extractValidBtihMagnetUri(text)
    if (magnet) return { magnet }
    const selectionText = String(text || "").match(/(?:下载|下|选择|选)\s*([\s\S]{1,80})$/i)?.[1] || ""
    const indexes = [...selectionText.matchAll(/(?:^|[,，、\s])(?:第\s*)?(\d+)(?:个|项|号)?/g)]
      .map(match => Number(match[1]))
      .filter(value => Number.isSafeInteger(value) && value >= 1)
    return indexes.length ? { selection: indexes } : null
  },
  // pixivSearchTool 的关键词抽取不走正则快路:自然语言措辞无穷多
  // ("跟翠月有关的图"),统一交给语义规划器的低模型按下面的详细规则拆解。
  pixivDownloadTool: text => parsePixivDownloadRequest(text),
  forgetGroupKnowledgeTool: text => {
    const memory = extractGroupKnowledgeForgetTarget(text)
    return memory ? { memory } : null
  },
  excelWorkbookTool: (text, context) => buildExcelToolParams(text, {
    hasExcelContext: context.hasExcelContext === true
  }),
  modrinthTool: text => parseModrinthRequestOptions(text),
  githubRepoTool: text => {
    const repoUrl = extractSingleUrl(text)
    return /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+/i.test(repoUrl) ? { repoUrl } : null
  },
  webParserTool: text => {
    const url = extractSingleUrl(text)
    return url && /(?:解析|总结|读取|看看|看下|提取|网页|页面|链接)/i.test(text) ? { url } : null
  }
}

export function resolveDeterministicToolIntent(text = "", availableToolNames = [], context = {}) {
  const candidates = selectToolIntentCandidates(text, availableToolNames, context)
  if (candidates.length !== 1) return null
  const toolName = candidates[0]
  const resolver = DETERMINISTIC_TOOL_RESOLVERS[toolName]
  if (!resolver) return null
  const params = resolver(normalizeText(text), context)
  if (!params || typeof params !== "object") return null
  return { intent: "tool", toolName, params, reason: "deterministic_manifest" }
}

export function resolveToolRequestMergeMs(text = "", availableToolNames = [], options = {}) {
  const defaultValue = Number(options.defaultMs)
  const defaultMs = Number.isFinite(defaultValue) ? Math.max(0, defaultValue) : 3000
  const fastValue = Number(options.fastMs)
  const fastMs = Number.isFinite(fastValue) ? Math.max(0, fastValue) : 600
  return resolveDeterministicToolIntent(text, availableToolNames, options) ? fastMs : defaultMs
}
