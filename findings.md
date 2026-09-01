## 2026-08-07 对外失败提示审计

## 2026-08-10 人设与模型路由
- 群 `240837518` 在 16:40:18 收到“希洛也是ai吗”；模型正常调用后生成“别给我扣 AI 帽子嘛...”，没有 `[Repeat]` 日志，因此不是群复读功能或发送层回显。
- `apps/test.js` 的希洛口吻提示包含“别给我扣机器人帽子...我只是话多一点”的示例，模型把它扩写并复用。应改为原则性约束并禁止复用示例措辞。
- 生产聊天模型与工具模型均已配置且模型名不同。普通闲聊日志仍为 `mode=tool`，原因是请求仍携带可选工具；`utils/apiClient.js#YTapi` 以 `config.useTools && requestHasTools` 作为硬分流条件，直接覆盖请求的模型为 `toolsAiConfig.toolsAiModel`。
- 正确边界应由入口在无必需工具动作时清空工具并传 `tool_choice: "none"`，使文本请求进入 `chatAiConfig`；工具调用和复杂、明确需要工具的请求仍进入 `toolsAiConfig`。
- 更精确地说，`sendLocalEmojiTool` 在普通闲聊中会作为 casual 候选出现；`createTurnPlan()` 将它放入 `requiredCapabilities`，因此错误产生 `requested_action`。非显式表情候选必须保留在 optional 集合。
- 当前配置没有通用短聊模型位，`trackAiConfig` 仅用于回话判断，不应隐式拿来生成回复。新增显式 `taskAiConfig.casual`，未填时仍回退 `chatAiConfig`；生产可显式将该位指向已配置的轻量模型。
- 边界复核：`sendLocalEmojiTool` 仅在用户明确索要表情时为必需能力；强制/锁定工具调用仍为必需能力。只因闲聊可用表情而出现的候选会保留为 optional，并在初始请求前移除，不再触发工具模型。

## 2026-08-11 长对话卡面 Markdown
- 用户反馈长对话卡面把 Java 代码连同说明文本直接排为普通文本，未解析 Markdown。渲染入口为 `functions/functions_tools/TextImageTool.js`，现有 `tests/textImageDocument.test.js` 可作为最小回归面。
- 宽泛源码搜索中的围栏符号发生 shell 转义错误；未读取错误结果、未改动工作区，后续改为直接检查目标渲染器和测试。
- `TextImageTool` 已有围栏代码、列表和行内 Markdown 解析，但只从整个输入识别无围栏代码，且语言候选没有 Java。用户给出的内容是说明正文混有以 `java` 开头的 Java enum 片段，没有有效围栏，因而会完整落入正文块。
- 修复将在 Markdown 解析前把明确的独立语言标记及后续连续代码行规范化为内部围栏，让 document、knowledge 和 chat 的既有代码渲染路径复用同一语义。
- 首次实际截图发现 Java enum 常量如 `SUCCESS(...),` 仅以逗号结尾，早期代码行判定错误地在首个常量截断。将枚举常量模式加入 Java 行判定，并以完整 enum 内容必须处于同一 `code-block` 的断言防回归。

## 2026-08-11 YouTube 授权后台配置
- 生产已安装 `yt-dlp`，但 `youtubeRelay` 当前只有代理、时长、大小和超时设置；没有 Cookie、PO Token 或其他 YouTube 授权配置。当前视频的“需要登录、会员资格或没有公开访问权限”来自下载器错误分类，不是缺少普通 API token。
- 元数据请求目前只从 `youtubeRelay` 传递 binary、timeout、proxy；下载请求传整个对象。新授权字段必须同时透传两条路径。
- Cookie/PO Token 不应以 `--add-header` 或 `--extractor-args` 直接放进 `yt-dlp` 的 argv，避免在进程列表中泄露。应生成权限为 owner-only 的临时 cookie jar/yt-dlp config 文件，调用结束后删除。
- 已上线：生产 `yt-dlp` 可用，运行配置补入空的 `cookieHeader`/`poToken` 字段；Cookie/PO Token 会通过 `0600` 临时文件传给元数据和下载调用，调用结束后递归删除临时目录。生产定向回归 6/6、schema 断言、文件哈希和服务启动均通过。

## 2026-08-11 YouTube 失败卡片信息修正
- `MediaOutbox.formatInfo()` 统一将平台标签与适配器文本用冒号拼接；`formatYoutubeHistoryText()` 又以“分享了 YouTube 视频”开头，导致用户看到重复语义。元数据失败的 card 保留原始链接识别字段，仍由同一成功格式化器显示“未命名视频”，这是错误呈现而非视频真实标题。
- 生产实测 `0JZtdAtJiyk` 的原始下载器错误为“Sign in to confirm you’re not a bot. Use --cookies…”，且线上 Cookie/PO Token 均未配置。它不是会员或私享视频结论。已将此类错误映射为“要求通过账号 Cookie 完成访问验证”，并让失败卡片只显示“视频信息未获取”和稳定视频 ID。

## 2026-08-12 叙事卡片前言与正文呈现诊断
- `apps/test.js` 在最终发送前调用 `splitNarrativeReply()`；若拿到 lead，会先 `sendSegmentedMessage(lead)`，然后强制将正文以 document 卡面发出。因此前半句不是卡面渲染器额外产生，而是模型回复被设计为单独发出的开场。
- 当前 prompt 已建议空两行后使用 `# 标题`。但解析器只接受半角 `#` 和标题独占行；示例中的全角 `＃五个月` 紧接正文未识别，造成整段故事进入卡面。
- 推荐修正是双层：prompt 规定单独一行的半角 `# 标题`；解析器同时兼容全角 `＃` 和标题正文同一行，保证模型偶尔格式偏差也不影响展示。

## 2026-08-12 卡面即时确认与完整正文
- 用户确认保留前言的目的，是在耗时模型/渲染开始时立即证明收到，而不是让模型的创作说明成为内容。确认应由发送层在模型请求前发送；模型输出与卡面只承载完成内容。
- 可在请求前稳定识别的卡面类别为故事创作、知识解释和用户明确要求代码/Markdown 文档。将统一走一条纯函数的呈现决策，避免确认消息与最终卡面模板发生漂移。
- 生产当前 `apps/test.js` 比本地工作区少一条尚未上线的人设提示调整，因此部署使用生产文件定点补丁而非整文件覆盖。确认本次仅新增卡面呈现决策、模型提示边界、请求前确认和旧叙事格式兼容，不带入其他工作区变更。
- `apps/test.js#getFriendlyFailureMessage()` 已能把主聊天错误分类，但图片分析、检索、Modrinth 等仍丢弃真实错误，直接命令中大量 catch 只发“失败，请看日志”。
- `chatFailureReply` 已有聊天专用脱敏逻辑，但未被图片、媒体、骰娘、知识库和命令模块复用；应提升为通用工具，确保不会外泄 token、签名参数、磁链、内部路径和 stack。
- 优先改动所有会向群直接发送异常的高频入口，保留格式提示、权限拒绝和业务状态文本，避免把正常用户错误改成技术报错。

## 2026-08-09 YouTube 与 Pixiv 自动媒体解析
- `MessagePipeline` 在富化前通过 `findRawMedia()` 将 B 站/抖音事件投递到媒体 outbox；新平台必须在这里同步识别，才能不依赖后续聊天模型或富化成功。
- `mediaOutbox` 已承担按群有序投递、合并转发、跨群文件工件复用与文件清理；YouTube/Pixiv 应以平台适配器接入其稳定 ID、富化和 relay builder，而不是复制发送流程。
- `MediaOutbox` 的当前分支仅显式处理 `bilibili`/`douyin`，平台判断分散在准入、稳定 ID、富化、relay、信息文案、清理及视频内联阶段；本轮会收敛为平台适配表，避免后续新增平台再复制条件分支。
- 本地没有 `yt-dlp`、`youtube-dl` 或 `ffmpeg` 可执行文件；YouTube 适配器必须将缺少下载器作为可读的真实降级，并在生产验证实际依赖。
- 归档也有 B 站/抖音专用的序列化、富化和渲染分支；必须同步扩展，否则机器人实时能搬运但后续上下文丢失作品信息。
- Pixiv 图片可直接作为合并转发信息节点的 image 段交付；无需绕过现有 `inlineForwardVideoSegment()`，只有 YouTube 视频段才需走该视频编码/共享文件路径。
- 平台适配已设计为 `stableId/enrich/build/cleanup/format/resolvedStatuses` 表，入口只接受已启用适配器。YouTube 和 Pixiv 配置将通过 runtime 注入 builder，硬上限仍由模块内部约束，配置只能收紧。
- 生产已安装 `yt-dlp 2025.04.30` 和既有 `ffmpeg`，但实测 YouTube 元数据请求在 IPv4/socket-timeout 路径仍无响应并超时，说明当前主机到 YouTube 的网络可达性是完整搬运的外部限制。代码已在 15 秒元数据窗口内保留页面并显示“YouTube 元数据请求超时”，不会卡住 outbox 或假称完成。

## 2026-08-05 统一群记忆链路审计
- 群共享持久状态当前至少有五个独立来源：`knowledge`、`workflows`、alias、群事实和实体事实。群知识的新语义裁决只覆盖第一个，`explicitTeachingFacts` 仍会在回复后把匹配到的 `@成员 是/叫/指的是` 直接写入 alias。
- `extractMentionTeachingFacts()` 对带 @ 的关系不要求用户明确要求保存；它在 `updateEnhancedSystems()` 中通过 `addAliasMapping()` 落库，因此故事设定仍可能绕开群知识修复。
- 群工作流仍由 `TEACHING_PATTERN` 正则直接写入，且工作流是可执行的 @ 行为，必须纳入同一语义裁决与权限策略。
- 删除目前按存储类型分裂：`forgetGroupKnowledge()` 只删 knowledge，不会删除同源 alias/fact/workflow；同一错误关系可继续通过其他 prompt 注入。
- 群知识裁决在主链路上直接 await，配置的 2.5 秒会真实增加首回复延迟。裁决应带 accepted/rejected/unavailable 状态，并与主回复并发；只有 accepted 才允许确认“记住了”。
- 共享定义按 subject 直接覆盖，缺少来源、版本和作者冲突策略；普通成员可改写既有共享定义。
- 当前 runtime 虽已有语义输出，但顺序 await 裁决、知识写入、工作流写入和别名写入，最多叠加一次模型等待和三段存储操作；统一网关应读取三个文档后在同一群队列中一次性提交。
- `membersFromContext()` 只按文本匹配成员名，无法把 `@` 段和发言者带入裁决候选，导致模型即便理解了目标也可能无法落库。
- 已实现 `commitGroupMemoryDecision()`：同一群队列内并行读取三个文档、统一做授权/冲突/幂等判定并按需写回。每条新记录共享 `proposalId`（默认原消息 ID），删除其中任一可唯一定位的条目会级联移除同源 alias、knowledge、workflow。
- runtime 只在 180 ms 短窗口内等待语义裁决+提交；未及时完成时正常聊天继续且不注入“已保存”提示，后台完成后下一轮可用。总裁决超时默认从 2500 ms 降为 900 ms。
- 发现并修复遗留的 `explicitTeachingPrompt` 未定义引用：旧正则链路已不再赋值但仍参与提示词拼接，会导致正常聊天在该路径出现 `ReferenceError`。

## 2026-07-29 群 821466122 异常会话审计
- 用户反馈群 `821466122` 中希洛出现多类错误。以线上部署 `/opt/trss-yunzai/plugins/bl-chat-plugin`、消息归档和 systemd 日志为唯一事实来源；本轮先读后分析，不改线上。

## 2026-07-29 工具等待回复去机器人化
- 正常主聊天已拿到完整 `systemContent`，可自然回应；慢工具的 `contextualProgressReply` 只携带 `persona.name/tone/speechStyle` 并走快速模型，因此最容易退化为“正在按要求修改图片”“正在编辑图片”这类任务状态播报。
- `BananaTool` 已对进度文字调用 `personaFeedbackManager.guardReply`，但 `GoogleImageEditTool` 与 `GoogleImageAnalysisTool` 漏掉了同一守卫。守卫不负责强行卖萌，只负责清除客服/身份硬辩/非自愿亲密等已知坏模式。
- 修复方向：把纯执行状态短句作为无效进度回复要求模型重写，提示中明确要求像熟人接住具体话题、非暧昧且不假称已经看过图片；两个漏接出口统一应用现有守卫。工具失败文案保持可验证但改为第一人称自然表达。
- 已实现：`正在按要求修改图片`、`正在调整图片中的领口`、`正在编辑图片` 等纯状态短句会被拒绝，即使来自工具参数也会触发紧凑模型重写；未提供快速模型或两次生成均不合格时仍保持静默，不用固定口头禅兜底。
- 已上线：生产定向回归 18/18，四个运行模块线上 SHA-256 与本地一致；服务安全重启后插件初始化一次、加载 34 个插件，OneBotv11 已重连。备份位于 `/opt/trss-yunzai-backups/bl-chat-plugin-tone-progress-20260729-232330`。

## 2026-08-03 群 609235590 合并转发可读性核查
- 最新合并转发为 14:30:55 的 `CQ:forward,id=7669689123275068986`。`ytbot:message_pipeline:event:v1:3094088525:message:group:609235590:1962531612` 和当天归档均只有该 ID；没有可读节点文本、图片或文件元数据。
- 生产日志明确记录 `Prefilter ... skip kind=empty_content reason=no_text`。这发生在 `groupContextResolver` 的 `group.getForwardMsg()` 展开之前，说明“仅合并转发”仍会被总过滤器遮蔽；不是转发实际没有内容。
- NapCat 当前仅主动以 WebSocket 连接 TRSS，未开放 HTTP/WS OneBot 动作服务；无法从外部补调 `get_forward_msg`，且机器人没有在收到时持久化节点，故无法事后还原这条具体内容。
- 既有记录确认 `apps/test.js` 已有统一 `[Delivery]` 出站回执和短聊/工具路由观测，图片、媒体、工具和模型错误应能按时间线区分。

## 2026-08-03 磁链按文件选择下载
- 当前 `torrentDownload` 已先做元数据解析，并用 `itorrents.net` 返回的 bencoded `info` SHA-1 对 BTIH 做可信校验；此次选择功能不改变该安全边界。
- 初次解析的种子若整体超 50 MB，应保存短期、按 `groupId + userId` 隔离的文件选择会话，向发起人展示编号、名称和大小；后续选择再重新读取并验证元数据。
- aria2 支持 `--select-file` 的 1-based 索引，可确保仅下载被选文件；归档与下载后核验必须使用同一份已筛选文件列表。
- 实现已将选择会话以 `ytbot:torrent_download_selection:v1:<群或私聊>:user:<发起人>` 保存，默认 TTL 1800 秒；Redis 暂不可用时仅回退当前进程内短期记录，且会记录警告。
- 重新下载时会重新获取种子、校验 BTIH 和元数据指纹；仅把所选索引交给 aria2 的 `--select-file`，ZIP 参数也只包含已选路径。
- 清单只列出单文件本身可通过单文件、总大小和 ZIP 预留校验的条目；组合超限会拒绝并保留会话，让用户重新选，不会先下载。
- 生产服务 active，PID `1281625`，自 2026-07-28 19:21 CST 运行；当前可从 `journalctl -u trss-yunzai.service` 获取该群完整入站、工具、出站和 Delivery 回执。
- 2026-07-29 21:44-22:15 已确认至少三类异常：21:53:58 对明确文生图错误回复“图片编辑通道不可用”；22:11:56-22:11:58 两条“图片编辑通道不可用”后又错误声称“刚刚重启了一下…继续画”；22:09-22:14 多轮普通闲聊把“宝宝/害羞/气质”作为默认互动，明显偏离自然群聊人格边界。
- 已定位文生图误归类：`BananaTool.performDraw()` 以 `rawImages.length > 0` 直接决定 image-edit。群友头像参考会作为 `images` 传入且 `referencePurpose=member_avatar`，因此“根据群友头像生成新图”被错误送至编辑通道；生产状态 `1249859808` 和 `1784521067` 均记录为 `tool_failed`、错误内容为全部图片编辑通道超时。
- 已定位假“重启恢复”：任务 `350035123` 完成后，排队任务 `76323409` 先被内存队列正常启动，同时异步 durable queue 恢复扫描又把该仍在 Redis 中的排队任务认作重启遗留项，发送“刚刚我这边重启了一下”并第二次执行。服务没有重启，PID 和 active 时间未变化。
- 出站汇总显示该竞态在 21:56-22:12 连续触发多次，造成假重启提示、重复成图和同一用户的多次排队提示；不能视为偶发上游失败。
- 排队提示直接使用 `sender.card`。该群中 QQ 事件提供的卡片文字是“[有人@我]ooseven回应了你的消息”，被机器人原样展示为正在绘图的群成员名称，属于未规范化展示身份。
- 线上 persona 一面禁止暧昧，一面又要求“有点害羞”“被亲近称呼时害羞”，而 guard 未禁止“宝宝/不好意思/气质”这类轻度拟人亲密话术；加上群表达状态收集了近期“宝宝”等用户词，最终模型在 22:09-22:14 连续采用了不自然的暧昧回应。
- 21:44 “执行一次上面的内容”明确引用了上一条绘图提示词，但工具过滤只以当前短句分类为普通闲聊，最终只暴露 `sendLocalEmojiTool`；语义工具规划不再获得引用内的可执行图像意图，模型只能基于长历史自由文字回复“不能生成图片”。这是“引用/上下文已解析的意图”没有参与工具路由的根因。

## 修复优先级
1. P0：将 `member_avatar` / 风格参考固定为 `reference_generation`，从配置筛选、比例、执行与错误文案全链路走文生图；真正用户原图编辑才走 image-edit。
2. P0：为 durable 绘图任务加入原子 claim/运行中标记，并让内存队列与恢复扫描互斥；只能在进程启动恢复且实际领取成功后发恢复提示，正常队列绝不提“重启”。
3. P0：工具路由使用“当前文本 + 已解析引用/最近指代”的合成意图；有可执行引用时禁止短聊表情过滤遮蔽原任务工具。
4. P1：成员展示名过滤 `[有人@我]...` 等传输层卡片文本，优先真实昵称，退化为 QQ 号，不能在对外文案泄漏内部展示文本。
5. P1：persona 改为“可自然致谢、但不主动使用亲昵称谓/害羞/暧昧回应”；persona guard 对“宝宝”等非用户明确设定的亲密称谓重写或拒绝。表达学习只提供节奏，不能把单次群友亲昵称谓作为机器人可模仿用词。

## 实现决定
- 保留群友头像作为真实视觉参考输入，不能为了避免“编辑”字样而丢弃头像。新增独立 `reference_generation` 操作语义：底层可使用支持参考图的渠道，但日志、成功状态、比例和失败文案均按“生成新图”处理；只有用户提供/指定已有原图的修改才是 `image_edit`。
- 队列竞态的最小修复是把 `activeTask` 的声明移动到 `persistDrawJob()` 之前。异步队列启动在第一个 `await` 前就可见运行占位，随后 durable scan 会直接退出；不移除崩溃后的恢复链路。

## 2026-07-20 自然语言遗忘群知识
- 线上手动删除确认：`ytbot:mem:g:953676639:knowledge` 中唯一一条“星野是我的星怒”关系已精确移除；键保留为空数组，未删除其他 Redis 键。
- 现有命令删除入口与 Agent 工具链尚待核对；新能力必须复用结构化群知识条目而非对全文记忆或聊天归档做模糊删除。
- 当前实现以 `forgetGroupKnowledgeTool` 作为 Agent skill 接入，只有明确遗忘请求才会暴露/执行；MemoryManager 在同一群串行队列内按创建者、第一人称所有者和精确别名删除，歧义或未命中均不写入。
- 本机定向 19/19 通过；完整 `LocalToolRegistry` 实例化受既有本机缺少 `js-tiktoken` 阻断，需在生产完整依赖环境复验注册。
- 线上完整依赖定向 19/19 通过；新工具已在真实 `LocalToolRegistry` 注册，配置 `oneapi_tools` 已启用。安全重启后服务 active、34 插件和 OneBotv11 WebSocket 正常。

# 2026-07-17 回复节奏与表情包编排

## 2026-07-20 对话延迟优化
- 生产服务当前负载 0.07、Yunzai CPU 约 1.6%、可用内存约 3GB，慢回复不是主机资源耗尽。
- 普通对话的语义工具分类实测 2.5-8.1 秒；该分类即使最终为 chat 也会先走一次模型。当前触发正则含“看看/看一下/搜/查/找/群友”等过宽词，是首要可消除等待。
- 明确 @/前缀的连续消息合并原为 3000ms，已热更新到 1000ms；工具请求合并保持 600ms。
- 搜索工具实测 17.1 秒，Banana 图片生成出现 78.7/277.7/390.6 秒上游耗时，视频冷链路总计 16-17 秒且 QQ 上传占 11-14 秒；这些需要后台执行与即时开场，不能靠缩短聊天模型解决。
- 已上线：直接点名不再强制 `forcePlanning`；只有媒体、显式工具/搜索/实时请求或已命中 Agent Skill 才调用语义分类器。短独立闲聊采用 6/2/8 的历史预算，引用、指代、媒体与工具请求不降级。

## 2026-07-20 Embedding 语义表达召回
- `GlobalStyleLearnerManager` 已有脱敏样本池、全局规则学习和同步 `buildPrompt()`；这是合适的承载位置，不新增独立且竞争的表达系统。
- 现有 `embeddingAiConfig` 使用 OpenAI 兼容 `/embeddings` 请求；`utils/memory/embeddings.js` 已有零向量/维度安全的余弦相似度语义。
- 回复组装点当前顺序读取情绪、记忆、工作流、知识和表达 prompt；语义召回应在这些异步读取开始时并发启动，最终只追加匿名句式指引。
- 实现将向量化观察放入最多 2 并发、64 项待处理的后台队列；向量请求/查询失败后冷却 60 秒，避免坏端点对群消息重复刷日志或叠加请求。
- 新索引落盘字段仅为 hash、embedding、patterns、sequence、时间；旧 `samplePool` 仅作为首次后台回填输入，不能出现在最终 prompt。
- 线上配置为 `BAAI/bge-m3`，真实健康请求 200/1024 维；服务重启后 34 插件及 OneBotv11 正常。

## 2026-07-21 语义表达质量与可靠性升级
- 线上已经有 240 条语义向量、索引不含 `text`，但只有 6 种抽象模式；现行向量来自脱敏消息内容，话题相近不等于对话动作相近。
- 现行代码没有记录语义查询耗时、缓存命中、命中分数或拒绝原因；日志中的一次真实对话主模型为 6355ms、整轮为 13263ms，尚不能把差额归因给语义层。
- `PersonaFeedbackManager` 已限制 `.希洛反馈` 仅主人可用，并持有对应机器人最近回复；当前只总结成全局 guard 规则，没有进入按场景的风格学习。
- 现有回填只在进程内做一次调度；临时 Embedding 故障会让本进程剩余历史样本不再自动补齐，需要可恢复批次。
- 已实现 schema v2：Embedding 输入改为有限的匿名场景和固定表达目标；场景原型按 key 去重，查询按首二场景分差过滤，默认只注入一条策略。
- 新增持久化统计 query/hit/cache/failure/timeout/耗时，不保存原话；`.表达学习 状态` 和报告可直接看到这些指标及回填游标。
- 主人 `.希洛反馈` 仍是唯一反馈入口；只有它的预定义分类会转换成带权重的匿名场景策略，普通群聊不自动升级为长期反馈。
- 回填故障重置游标，按 75 秒退避重新扫描；provider 故障按 endpoint+model 单独冷却，避免一个通道影响别的配置。

## 2026-07-21 自主风格进化闭环
- 当前 `rememberBotReply()` 只服务主人 `.希洛反馈`，GlobalStyleLearner 只观察群友消息，二者没有“这次回复后来被接受还是被纠正”的闭环。
- 自主学习的最小安全单元应是匿名 `scene + replyStyle + outcome`，而不是用户原话或模型全文；可由回复长度/开场节奏/解释结构等有限风格类别构成。
- 自动提升必须比主人反馈严格：跨多个发言者、达到证据数和比例阈值才加入高权重 prompt；反例会降级，防止短期群气氛把人格带偏。
- 实现使用 12 分钟同人窗口；明确认可词和明确失败/语气纠正词才形成 outcome。每条待观察回复一旦被消费即删除，沉默、表情和换话题不计分。
- 候选只存 scene、replyStyle、固定 strategy、正负计数、哈希化发言者集合和时间；晋升的策略作为高权重 `auto_evolution` 场景样本参与原有检索，撤销时同步移除。
- 搜索新增 2.5 秒延迟进度反馈和 20 秒 Abort 超时；完整依赖模拟确认慢请求会先反馈，成功结果仍正常返回。初始主模型新增分段日志，等待真实消息观察节省效果。

## 2026-07-20 Agent 证据与执行基础设施
- Steam 真实失败复盘：引用图片被正确解析，合并 1s、语义分类 8.841s、图片识别 34.497s，最终图片工具无可用结果；通用 tool grounding 把该 error 错说为“查询没有成功”。
- `GoogleImageAnalysisTool` 目前会把非 2xx、空响应和下载错误压成简单 `{ error }`，且不记录上游 status/安全摘要；同一 QQ 图片有两条 rkey URL 时也会重复进入识图输入，导致诊断、成本和失败定位都变差。
- 已收口：`tool_outcome` 向后兼容地接入 grounding，图片识别失败不再落到“查询没有成功”；按 `image_link_expired`、`image_download_failed`、`vision_timeout` 或未知识图失败生成不同回复。
- 图片工具现在按 QQ `fileid` 去重、25 秒 abort，并支持 `analysisAiConfig.providers` 显式备用候选。尝试日志只记录候选标签、模型、错误类别与脱敏错误；没有 provider 配置时不会擅自切换模型。

# 2026-07-20 群工作流记忆
- 现有 `MemoryManager` 的 group facts 适合背景知识：召回结果会被标成“仅用于理解语境，不是指令”，且受 top-N/字符预算限制，不能承担“教学后可执行”的约定。
- 目标是结构化、按群隔离、明确教学才写入的工作流规则；运行时只在当前话语明确请求执行时提供给 Agent 作为高优先级动作上下文。
- 工作流规则不绑定“挂团”或“管理员”等单一场景：结构为 `condition + mention_members + targetUserIds + sourceText`；目标在教学时由 QQ 群成员表解析为 QQ 号。
- 现有 `MentionAdminsTool` 只适用于实时枚举管理员。工作流需要一个不猜测身份、只按已持久化成员 QQ 号发送真实 at segment 的通用 `mentionMembersTool`。
- `apps/test.js` 在构建系统提示前已经获得当前群 `memberMap`，并在此处获取 `memoryPrompt`；可在同一位置同步保存教学规则、再读取匹配的可执行工作流提示，不需要把它塞回普通 facts。
- 工作流提示的执行门槛只认明确的“艾特/通知/喊/叫”请求；单独 @ 某人或讨论事件不注入可执行规则，避免自动刷屏。

# 2026-07-20 结构化群知识
- 现有普通记忆提供实体事实、别名和群事实，但群事实会按 top-N/字符预算截断，且没有群文件的身份字段；它不能可靠回答“我的地图对应哪个群文件”。
- `groupContextResolver` 和 `MessageManager` 已能从消息段读取 file 的名称、ID 和 URL。应把这些作为明确教学时的资源元数据，而不是重新做群文件下载或单独的地图逻辑。
- 实现只持久化文件名、文件 ID、路径和来源；临时 URL 不写入知识条目。第一人称查询会按所有者 QQ 限定，避免其他群友问“我的地图”误命中。

# 2026-07-20 成员艾特失败归因
- 真实请求“@一下绘梨衣的星怒”被正确路由到 `mentionMembersTool`，但群成员表没有该文本的精确匹配；工具结果是本地 `当前群未找到要艾特的成员`，不是回答服务或模型失败。
- 终态工具统一失败出口此前把这一结果落入通用聊天失败文案，造成错误且机械的“回答服务请求失败”。现为成员艾特增加专用自然失败回复，保留原因和“直接 @ 对方”这一可操作路径。

# 2026-07-20 群知识代词解析
- “星野是我的星怒你记住了”必须保存为发言者 QQ 的“星怒 = 星野”，不能把“我的星怒”作为脱离说话人的纯字符串。
- 明确教学含“记住/定义”等信号时，使用记忆模型将我/我的/本人解析为发言者、你/你的/希洛解析为机器人；模型输出的成员名称必须再由当前群成员表解析为真实 QQ，不能接受模型虚构目标。
- 模型不可用时，结构化解析仍识别第一人称关系，保证核心“我的 X”不会退化为原始代词文本。模型输入只含原话中命中的至多 12 名成员候选，避免大群成员表带来额外延迟。
- 用户反馈问题属于整轮发送编排：单条生成质量之外，还要约束多条文字、表情包与补话的相对位置和总消息数。
- 现有 `followUpText` 实际在表情包之前发送，字段语义与发送顺序相反；普通短文字即使有两段也不会拆，长文字则最多可拆 3 条。
- 新策略把表情回复显式建模为纯图、文字→图、图→文字、文字→图→文字；默认纯图或两段，只有两侧文本含义独立时允许三段，总数最多 3。
- 普通文字默认一条；只有模型用空行给出两段、第一段是完整短反应、第二段是完整独立补话且非技术/严肃结构时，才发成两条。长文最大分段从 3 收紧到 2。
- 全局表达学习原先只观察单条消息；现已按群+发送者保存 20 秒内最多 3 条的序列样本，并用 `[下一条]` / `[表情包]` 记录节奏位置，不跨发送者拼接。
- 独立 `ExpressionLearner` 仍有两个同名 `updateGroupExpressions(groupId, content)`；JavaScript 后定义覆盖前定义，当前实际只缓存字符串单条，AI schema 也只有 `situation/expressions`，没有整轮节奏和表情位置。
- `apps/test.js` 仅在 `expressionLearning.enabled && e.msg` 时调用独立学习器，纯表情包事件通常没有可用文本，因此无法进入该学习链路。
- 独立学习器需要兼容旧 Redis 结构，并新增按群+发送者的短时序列观察；普通图片不能误当表情包，序列学习也不能变成每轮强制拆消息。
- `GlobalStyleLearnerManager` 已有一套私有 `isLikelyEmojiSegment/extractSequenceStyleText`，只识别 `image` 的 `sub_type=1` 或带“表情/梗图/反应图”摘要；独立学习器若再复制会造成两套判定漂移，应该抽成共享观察工具。

---

# 2026-07-17 Agent 智能度提升
- 线上普通回复模型为 `deepseek-v4-flash`，工具模型为 `deepseek-v4-pro`，群历史上限 30；近期请求 prompt tokens 约 8400-10900。
- 当前 `formatMessages()` 把多人历史压成单条 user 消息，并插入虚拟 assistant “收到，我会……”；这会损失真实轮次和指代边界。
- 当前工具最多 2 轮。进一步核对发现主会话的 `MessageManager` 实例显式使用 `messageMaxLength=9999`，所以历史并非按类默认值 200 截断；真正风险是不同工具结果无预算区分，过长结果会反过来挤占上下文。
- 当前已有语义工具分类器，且图片、Excel、头像、最近成图等资源路径有高置信确定性约束；合理改造是统一 Planner 输入和决策结果，而不是删除这些边界。
- `YTapi()` 的工具模型分支此前只保留 `tool_calls`；如果 Pro 模型直接产出文字，会丢弃这段回答，再调用 Flash 重答。这是确定性的质量损失和额外延迟，现已改为保留 Pro 原始文字。
- 上下文选择采用最近 10 条、最多 6 条相关旧消息、引用消息及相邻消息强保留，最终默认不超过 18 条；历史作为明确标注的群聊记录单独传入，不再插入虚拟 assistant 确认句。

---

# 2026-07-17 image_generation tool choice 400
- 线上 01:10:23 的 `gpt-image-2` 图片编辑首通道返回 `Tool choice 'image_generation' not found in 'tools' parameter`，之后直接切到 Krill fallback 并成功；未出现同通道的无 `response_format` 重试日志。
- 本地 `shouldRetryWithoutUrlResponseFormat()` 已包含 `tool choice.*image_generation`，需继续确认线上文件版本以及异常是否从 `adapter.request()` 直接抛出，从而绕过只对 `parseResponse()` 返回结果执行的兼容判断。
- 线上磁盘代码与本地一致，文件更新时间早于当前服务进程启动时间，排除旧模块未加载；01:10 与 02:34 均复现于 Sou `https://www.souimagery.fun/v1/images/edits` 主编辑通道。
- 该错误与 `response_format` 无关：插件请求体没有 `tool_choice`，是 Sou 上游图片工具契约内部不一致。旧正则把它误归到 `response_format`，会无效地重复请求同一通道后才切 Krill。
- 修复策略：收窄无 `response_format` 重试只匹配 `response_format`/`b64_json` 本身；单独识别图片工具契约错误并直接进入下一候选。线上再通过 message.yaml 热更新把已成功的 Krill 提为图片编辑主通道，不需重启。

---

# 记忆稳定性发现

## 2026-07-14 图片编辑 503 失败链路
- 该回复不是图片模型认定提示词有问题，而是当前 `gpt-image-2` 编辑通道返回 `503 No available channel for model gpt-image-2 under group codex (distributor)`。
- 请求已正确识别为图片生成并解析到 QQ 头像参考图；携带参考图后 Banana 使用单一 `imageEditAiConfig`，当前没有同能力 provider 回退。
- 现有错误分类没有识别 `503`、`No available channel`、`service/channel unavailable`，最终落入泛化“画崩了、换个说法”文案，形成错误归因。
- 修复应同时覆盖共享失败分类和编辑 provider 回退；fallback 必须复用完全相同的原 prompt，不能恢复已删除的自动改词机制。
- 当前 `imageFailurePolicy.js` 只把 `bad_response_status_code/openai_error/provider error` 识别为 `provider_error`，没有覆盖裸 `503` 和 `No available channel`；`empty_image` 与默认文案仍含“换个更稳的说法/调整后重新来”，与原话透传目标冲突。
- `BananaTool.performDraw()` 在有参考图且 `imageEditAiConfig` 是 edits 端点时只调用一次 `generateImageEdit()`；失败直接被外层 catch 包成 `图片生成失败`，没有读取 `imageGenerationAiConfig.providers` 作为同能力候选。
- 队列任务还有独立 `getQueuedFailureMessage()`，硬编码“你换个说法再叫我一次”，即使底层是通道 503 也会再次错误归因；该出口也必须收口到共享图片失败文案。
- 文生图已有 `utils/imageGenerationFallback.js` 的候选规范化、优先级、去重和逐个尝试模式，图片编辑适合在同一模块新增 edits 专用解析，但模型筛选必须比文生图严格。
- 当前配置模型允许多个 `imageGenerationAiConfig.providers`，其中 provider 常用通用 `apiUrl/model/apiKey/size/priority` 字段；编辑候选解析需要兼容这些字段，并把 `/v1`、`/images/generations` 转成 `/images/edits`。
- 兼容性边界：`imageEditAiConfig` 本身就是显式编辑配置，应始终作为第一候选；额外 provider 只有显式 edits 端点、显式编辑能力标记，或模型名明确属于 `gpt-image-*` / `image-2` 时才加入。
- `apps/test.js` 对 Banana 自己维护一套失败文案映射，默认分支正是用户看到的“画崩了、换个说法”；最稳妥的收口是 Banana 统一调用 `buildImageFailureReply()`，不再并行维护第二套错误归因。
- 全仓残留扫描又发现 `buildInternalStatusSafeReply()` 仍有一处图片失败“换个说法”，以及 safety 分类仍声称“我帮你换个更合适的说法”；这两处同样属于自动改词/错误归因残留，已纳入本轮删除范围。
- 默认配置的 `imageEditAiConfig` 仍可能是 Gemini `/chat/completions`，不能因为配置名含 edit 就强制改成 OpenAI `/images/edits`；只有非 chat 的显式编辑端点或明确支持 edits 的模型才进入 multipart provider fallback，原聊天图片接口保持原路径。
- 同类入口审计确认 `GoogleImageEditTool` 也存在两个问题：只使用单一 `imageEditAiConfig`；空结果后会调用 `buildEmptyImageRetryPrompt()` 添加“必须返回成图/可插画化融合”等新要求并切换模型。这正是用户要求全部删除的图片用词自动修复残留。
- `GoogleImageEditTool` 应保留当前 chat 图片接口为第一候选，但其失败或空结果后只能用完全相同的原 prompt 切换到共享 edits provider 候选，不能再生成 retry prompt 或提示“换一种更明确的改法”。
- Guoba 的 AI provider 配置结构允许各 config 自己维护 `providers`；因此共享 edits 解析不能只读文生图 provider，还应先读 `imageEditAiConfig.providers`，再补充 `imageGenerationAiConfig.providers` 中明确支持 edits 的候选。
- 线上当前真实配置最终解析为两个 edits 候选：souimagery `gpt-image-2` 主通道、Krill `gpt-image-2` 备用通道；Grok 模型因为没有明确 edits 能力被跳过，Sou 的 generation provider 与主编辑通道去重。
- 最终错误出口已经统一：Banana 主聊天失败、排队后台失败和 Google 图片编辑失败都使用共享分类；`503 No available channel` 不再落入未知错误，也不会再要求用户换词。
- Google 的空图重试不再构造“必须返回成图/可插画化融合”的新 prompt；当前 chat 通道失败后，fallback 收到的仍是同一个字符串对象内容和同一组参考图。

## 当前结论
- 知识库已有命令管理，真实数据在 `database/knowledge-db.ndjson`。
- 长期记忆已有命令管理，核心逻辑在 `utils/MemoryManager.js`。
- Guoba 当前标准集成是配置 schema，适合开关/阈值，不适合直接做真实数据 CRUD。
- 本轮改进重点转为：抽取质量、召回质量、注入稳定性。

## 2026-06-12 代码链路
- `apps/test.js` 在回复前调用 `memoryManager.getMemoryPromptForUser()`、`getGroupMemoryPrompt()`、`getGroupAliasPrompt()`，再调用 `personProfileInjector.build()`。
- `utils/MemoryManager.js` 的 `MemoryRetriever.retrieve()` 会对所有 fact 打分；当前带 query 时，即使 relevance 为 0，高 importance/recency/confidence 的旧记忆仍可能被选入。
- `normalizeConfig()` 里 `promptMaxUserFacts`、`promptMaxGroupFacts` 使用 `Math.max(1, ...)`，和 Guoba schema 的 min 0 不一致。
- `PersonProfileInjector` 只注入固定画像和最近发言，没有统一长度预算，也没有显式避免与长期记忆重复。

## 2026-07-04 赛马娘小游戏发现
- `index.js` 会自动 import `apps/*.js`，新增小游戏适合做独立 app 文件，不需要改插件入口。
- 现有配置集中在 `config_default/message.yaml` 的 `pluginSettings` 下，Guoba schema 通过 `models/Guoba/schemas/index.js` 聚合。
- 积分需求是“每一个群互通，只绑定 QQ 号”，适合使用全局 QQ 号 key 的持久 JSON 文件；比赛房间运行态可以按群存在内存中，避免不同群比赛互相影响。

## 2026-07-06 赛马娘玩法增强
- 用户认可随机赛道和比赛事件，希望加入一点决策因素，但不想让第一次玩的人理解专业术语。
- 决策采用轻量自然语言策略：稳一点、拼一把、留体力、抢内道；报名不填则默认正常跑。
- 每局开局先公布赛道条件；策略会影响属性权重、适性加成、波动和失误风险，结算仍然单条汇总输出。

## 2026-07-07 COC 骰娘需求
- 用户明确要求“正常骰娘”的 COC 跑团能力，不需要 AI 功能。
- 实现方向应为独立 app 插件和纯命令解析；不要接入 `oneapi_tools`、工具决策模型或自然语言意图识别。
- 用户希望后续完整支持常见 COC 骰娘能力，并需要 Guoba 管理页微调输出模板，例如 `.ra xx xxx` 时希洛回复什么。
- 现有项目适合沿用 `apps/UmaRacePlugin.js` + `utils/*Manager.js` + `models/Guoba/schemas/*.js` 的结构；`index.js` 自动导入 `apps/*.js`。

## 2026-07-12 图片任务仿真初始假设
- 最近线上问题包含两个独立维度：主动作被参考素材描述抢占，以及文字分析被误渲染成文档卡面。
- 100 场景需要分别统计意图路由、编辑素材角色/顺序、回复输出形态，单一通过率不足以说明稳定性。

## 2026-07-12 首轮 100 场景仿真
- 总通过 76/100。
- 续改类仅 5/10，说明“上一张/刚画的/继续”与编辑动作的组合覆盖不足。
- 回复形态类路由 0/10，卡面策略本身符合预期，但自然语言图片分析分类覆盖不足。
- “我想换衣服出门”被误判为缺图编辑，证明不能仅凭“衣服+换”判断，必须要求图片上下文或已有图片。
- 外貌参考解析对“像某人的样子”覆盖不足，应从头像关键词扩大到人物外貌语义，但仍要求唯一群成员匹配。

## 2026-07-12 最终 100 场景仿真结论
- 最终 100/100；十个分类均为 10/10。
- 修复采用语义类别规则：视觉编辑动作+图片上下文、最近成图续改、自然语言图片分析、诊断截图卡面白名单。
- 生活语义“我想换衣服出门”保持为普通聊天，说明降低误报没有依靠放宽所有“换衣服”表达。
- 仿真只能证明这 100 条确定性路由和素材清单符合预期，不能证明上游生图模型、网络和 QQ 发送永不失败。

## 2026-07-12 三套仿真首轮
- 总计 275/300（91.7%）。
- 图片来源/续改素材选择 100/100。
- 工具路由 80/100：自然语言看图、最近成图续改，以及缺少 manifest 的视频/天气场景失败。
- 错误与发送 95/100：5 条“正常文字分析结果”被测试模型当作错误，属于场景状态建模问题，不是生产失败。

## 2026-07-14 机器人身份硬辩排查
- 当前主聊天最终文本会经过 `PersonaFeedbackManager.guardReply()`，但守卫没有用户语境，`真人`匹配过宽，会误伤“这是真人照片”等事实内容。
- 默认人设仍存在冲突指令：`persona.boundaries` 写“不承认自己是 AI”，`systemContent` 写“被要求暴露 AI 身份就拒绝”；这会诱导模型正面否认身份，与新增的“用熟人玩笑带过”规则冲突。
- 普通聊天和工具总结走 `handleTextResponse()`，会经过共享守卫；但模型生成并直接发送的 `sendLocalEmojiTool.followUpText`、`voiceTool.text`、Banana 绘图开场，以及直接渲染的 `textImageTool.text` 不全部经过同一守卫。
- 正确收口应区分“用户在挑战 bot 身份”和“用户在讨论图片/他人/业务里的 AI 或真人”：只有前者才改写第一人称硬否认。
- 线上实际 `config/message.yaml` 是本次问题的主要诱因，包含“不承认自己是 AI”“你不是 AI”“你是一个真人”等比默认配置更强的对抗性措辞；修复必须同时改线上配置，单改仓库默认值不足以改变当前行为。
- 模型直发出口中，表情 `followUpText`、语音 `text`、Banana 开场和 TextImage 内容都可能携带模型生成的人设文本，因此需要复用同一个带语境守卫，而不是各写一套字符串替换。

## 2026-07-14 群内上下文素材排查
- `buildMessageContent()` 已能读取引用文字，并递归展开当前消息或引用消息中的合并转发文字；引用内媒体目前主要只写成“几张图片/一段视频”的摘要。
- `TakeImages()` 在存在引用时优先读取引用消息，而且只返回引用中的第一张图片；这会忽略当前消息同时附带的图片，也不会读取合并转发和嵌套转发里的图片。
- `resolveAvatarEditBase()` 已支持当前文本中的唯一群成员昵称和显式 `@`，但没有接收引用消息发送者；协议不自动附带 `@` 时，“回复某人：把他的头像改成……”会漏掉目标。
- `resolveAvatarInspectionTargets()` 和 `resolveAvatarDrawReference()` 已有引用发送者处理，说明引用对象解析应下沉为共享上下文，而不是继续在各功能重复实现。
- 群成员资料提示仅在“谁/哪位”句式下触发；“某某的资料/头像/群名片/头衔”没有统一进入成员资料提示。
- 新的 `groupContextResolver.js` 统一输出当前、引用、合并转发和嵌套转发中的文本、图片、视频、语音和文件来源；图片位置按当前消息、引用消息、转发记录顺序编号，转发循环和重复媒体会去重。
- 图片工具 prompt 会带群内图片来源清单，避免把引用对象、转发图片或群友头像误认成当前发言者；视频分析工具也从同一上下文读取合并转发视频。
- 引用发送者的 QQ 已下沉为 `replyTargetUserId`，头像编辑和“用他的头像替换”两类路径都能在没有自动 `@` 的协议下工作。

## 2026-07-14 绘图开场回复排查
- 线上 12:44 的真实请求携带两张参考图，`bananaTool` 已正常开始并最终发图，但中途没有任何开场发送日志。
- 根因在 `BananaTool.performDraw()`：普通开场只在 `!images.length && imageGenerationConfigs.length` 时发送，因此带参考图、只配置图片编辑接口、聊天图片接口等路径会直接跳过。
- 当前动态开场还依赖一次额外聊天模型请求，最长可等待 8 秒；“先回一句”不应依赖额外上游，应使用本地即时文案，动态模型只会增加延迟和故障面。
- `sendProgress()` 捕获异常后完全静默，也不检查 `e.reply()` 的 retcode；即使平台拒绝发送，日志里也无法区分“没调用”和“调用失败”。
- 最终规则是：任务直接开始时立即发送本地开场；安全改写发送安全说明；已排队任务以排队提示作为首次反馈，并保持 `skipProgressNotice` 避免轮到时重复刷屏。
- 开场发送现在检查 NapCat/Yunzai 返回结果并输出 `[图片进度提示] 已发送/发送失败/发送异常`，可直接从线上日志判断首次反馈是否真正发出。

## 2026-07-14 群聊割裂与阴阳怪气排查
- 群 `953676639` 中用户 `925640859` 发送“你跟哪学的,怎么感觉阴阳怪气的”后，主聊天请求先报 `400 Bad Request: messages[1].content: unexpected end of hex escape`，随后才发送“刚刚一下子没接住……你刚才是叫我吗？”。
- 理解增强卡片的近期消息文本末尾出现孤立的 `\\ud83d`；代码中存在多个直接按 UTF-16 code unit 执行 `slice/substring` 的 prompt 截断点，emoji 在边界被切半后会形成非法代理字符。
- 当前 `getFriendlyFailureMessage()` 把 `_mergedMessageCount` 与短招呼并列，只要消息合并就返回“你刚才是叫我吗”，会把明确的语气反馈错误改写成招呼。
- 真实上文连续出现“你别教我做事呀”“别气嘛”“不跟你犟了”“你舍得嘛”以及 `😋/❤`；在用户纠正、批评或生气时，这些顶嘴、调情和安抚话术会显得阴阳怪气。
- 正确修复需要三层收口：共享 Unicode 安全截断；API JSON 请求边界递归净化文本；被批评场景的明确承认与禁止反击/调情规则。
- 已新增 `utils/unicodeText.js`：安全按 Unicode code point 截断、替换孤立高/低代理字符，并递归净化 JSON 消息；`YTapi` 的工具模型请求和最终聊天请求都在发送前净化。
- 已把理解增强近期上下文、绘图 prompt、群内引用/转发上下文、用户画像、长期记忆 prompt 等关键截断点迁移到共享安全截断。
- 已新增共享失败回复分类：语气批评优先简短承认，只有真实短招呼才问“你刚才是叫我吗”，普通失败只请用户重发；`_mergedMessageCount` 不再影响语义。
- `PersonaFeedbackManager.guardReply()` 现在会识别明确语气批评，移除挑衅/暧昧 emoji；若模型仍在顶嘴、抬杠或调情，发送前统一改为自然承认。正常玩笑场景保持不变。
- 全仓截断审计继续覆盖了消息历史与归档、MCP 工具结果、群管证据、文件内容、思考内容、长消息分段和图片提示词；数组分页、哈希/日期、纯日志预览不进入 prompt，未做无意义替换。
- 线上实际 `systemContent` 原本已经写了“不要阴阳怪气/暧昧”，但没有规定被批评时的具体行为，仍会被“熟人感/害羞/接梗”覆盖；已补充明确场景规则和可用承认句。
- macOS tar 会生成 `._*` AppleDouble 文件，Yunzai 会把 `apps/._test.js` 当插件扫描并报语法错；部署后已删除全部此类文件，后续 tar 应设置 `COPYFILE_DISABLE=1`。

## 2026-07-14 长绘图指令误报缺少原图排查
- 线上 15:24:51 的原始消息是纯文本，没有 `CQ:image`、引用消息或合并转发；用户 `925640859` 从 14:30 到该请求前也没有上传图片，因而当前、引用、近期同用户图片来源均为空。
- 文本虽然以“帮我生成图片”开头，但同时包含“将图中人物的姿势变成”“参考图少女面部”“五官贴合度高需要认得出是本人”等明确依赖参考人物的编辑语义。
- `hasExplicitImageEditAction()` 会因“变成”命中编辑动作、因“图中/人物/脸/衣服”命中视觉对象和图片上下文；生产策略对完整原文返回 `image_edit_missing_base`。
- `apps/test.js` 的缺少编辑原图守卫位于文生图强制路由之前：图片来源为空且编辑动作命中时，会直接发送“没有找到可以编辑的原图”并结束，不再走后面的 `isImageGenerationRequest()`。
- 这次不是安全审核、模型拒绝或图片读取回归，而是确定性路由结果。若目标是保持某个真人/角色可识别，确实必须提供参考图；若目标是从零生成泛化少女，文本应避免“图中人物/参考图/认得出本人”等依赖已有图的说法。
- 当前回复的主要可改进点是提示文案：与其笼统说“你想改图”，更准确的说法应是“你的要求里提到了参考人物和本人五官，但没有收到参考图”。本轮用户只问原因，尚未修改代码。
- 用户确认修复后，最终策略改为区分两种“图中”：明确说“生成图片/画一张”，且没有实际图片、近期成图或“这张/上一张/我刚才发的图”等已有图锚点时，“图中人物”按未来输出画面理解，直接走文生图。
- 如果文本明确指向“这张图、原图、上一张、刚才发的照片、引用的图”等已有素材，仍会查找近期同用户图片，并在确实找不到时要求补图。
- 语义分类器在共享规则确认应优先生图时不再参与抢路由，避免规则层放行后又被模型分类成 `image_edit`。

## 2026-07-14 图片用词自动改写排查
- `BananaTool.performDraw()` 当前先执行敏感词安全改写，再做短 prompt 本地质量词补充或额外调用聊天模型优化提示词；文生图失败时还有一次安全改写重试。
- `utils/promptCompiler.js` 会自动补风格、情绪、构图、光线和质量词，并把部分亲密/服装描述改为全年龄或清爽夏装表达。
- 语义分类器已经明确要求保留原话，图片编辑接口本身也直接接收传入 prompt；主要改词点集中在 Banana 和 promptCompiler。
- 应保留图片素材 manifest、引用/转发上下文和“参考图用途”结构信息，因为它们解决素材错配，不属于修改用户用词。
- Banana 现在直接使用收到的 prompt：不再检测敏感词、不再发送“我帮你改含蓄”的提示、不再请求聊天模型优化、不再给短 prompt 补质量词，也不再失败后换词重试。
- promptCompiler 现在只封装任务类型、用户原话、引用原文、明确指代时的近期原文和参考图片存在信息，并明确要求下游不得改写；原有风格/情绪/构图/光线推导及服装、亲密内容软化已删除。
- 图片安全类上游失败文案已改为明确说明“插件没有修改原话”，不再谎称已经替用户收敛描述。

## 2026-07-14 主动表情工具暴露排查
- 线上表情系统和素材均正常：主开关开启、自动收集开启、200 条数据库记录、203 个文件，且近 24 小时没有任何表情工具调用，因此不是限流、空库或发送失败。
- `SendLocalEmojiTool` 描述和 `toolIntentManifests` 都允许在笑死、无语、离谱、绷不住、安慰、接梗等轻松场景主动调用。
- `shouldExposeToolsForMessage()` 只认可媒体、实时/搜索和 `isExplicitToolIntent()`；后者目前只覆盖图片分析表达，不包含轻松表情语气。
- `shouldUseSemanticToolIntent()` 的 hint 正则只含“表情”字面量，不含 manifest 中的“笑死/离谱/无语”等主动触发词，所以候选选择器经常根本不会运行。
- 最终 `filterToolsForMessageIntent()` 在普通闲聊直接返回空数组；正确修复需要在过滤之前识别共享的表情意图，并将返回工具收窄为仅 `sendLocalEmojiTool`。
- 新策略把“网上搜表情包”留给 `emojiSearchTool`，避免本地表情工具抢占；“禁言他太无语/查一下离谱新闻/接口为什么报错”等操作或求助语境也不会因情绪词误开本地表情。
- 明确说“这个报错先别分析，给我发个无语表情包”时，explicit 请求优先于严肃场景抑制，仍会开放本地表情工具。
- 中文子串容易误判：裸 `/草|乐|抱抱/` 会命中“草莓、乐队、抱抱枕”；共享策略已用边界/后缀约束消除这些误触发。
- 上线后的最终权限路径有两层保障：前置语义分类现在会因共享 casual 规则运行并只披露表情工具；即使分类器选择 chat，最终主模型请求仍只保留 `sendLocalEmojiTool`，不再回落为空工具数组。
- 当前 `SendLocalEmojiTool` 描述明确写着“默认一句短文字 + 一张表情”“优先通过 followUpText”，即使工具权限修好，模型仍会倾向先说文字；这与用户的新期望直接冲突，需要独立的回复模式策略和工具层强制收口。
- 62 场景基线为 23/62。失败不是单一词表问题：一部分日常情绪没有进入 exposure，另一部分虽然进入工具却被默认配文契约变成“文字+表情”；因此必须同时扩展情绪覆盖和新增 reply mode，不能只补更多正则。
- “你觉得这个方案是不是很离谱”证明情绪词不能压过真实问句；reply mode/exposure 都应先识别需要回答的问题，再决定是否允许纯表情。
- 工具提示词改变还不够：模型即使错误填写 followUpText，`SendLocalEmojiTool` 也必须根据原始 `e.msg` 重新判定模式并在 emoji-only 场景清空配文，才能稳定实现“表情替代文字”。
- 最终 62 场景分布为 emoji-only 38、emoji-with-text 4、text 20；这不是随机概率，而是先判断表情能否完整承载当前回复，再由库内语义匹配选择具体图片。
- 线上真实依赖测试证明工具边界收口有效：模型参数里的冗余 `followUpText` 不再决定是否先发文字，最终模式以原始用户消息的共享策略为准。
- 若只使用 `tool_choice=auto`，模型即使只看到表情工具也仍可能直接生成文字；用户要求的是“表情足够时替代文字”，因此高置信 emoji-only 应走确定性 forced tool call，emoji-with-text 和 text 才保留模型决策。
- forced tool call 的选图 query 不能只传“开心/无语”两个字；共享策略按情绪类别生成带场景的自然描述，继续复用 EmojiPackManager 的 embedding/标签语义匹配。
- 最终生产行为不再依赖模型是否愿意调用：38 类高置信日常反应直接进入本地表情选择并以 emoji-only 发送；4 类明确配文和 20 类需要文字/其他工具的场景不被强制。

## 2026-07-14 表情选图关键词与真实标签对齐
- 已只读取得线上 `/opt/trss-yunzai/plugins/bl-chat-plugin/database/emoji-packs.ndjson` 快照：共 200 条，200 条都有 tags、useCases 和 description；共有 114 个唯一 tag、398 个唯一 useCase。
- 高频真实 tag 为：吐槽 64、得意 58、无奈 58、卖萌 56、嘲讽 47、崩溃 44、无语 44、敷衍 33、震惊 28、委屈 27、傲娇 23、心动 20；另有笑死 12、尴尬 13、疲惫 5、害羞 5、认怂 8、安慰 1 等可作更精确主标签。
- 高频真实 useCase 为：看到离谱 95、无言以对 65、接梗吐槽 34、轻微嘲讽 28、想装无辜 24、被人夸奖 23、群友翻车 13；其余如安慰对方、场面尴尬、认怂求饶、拒绝加班等更稀疏但区分度更高。
- 当前 `localRelevanceScore()` 会把 query 切成所有 2-4 字中文片段并逐项累加，最后封顶 1；长场景句会产生大量泛化片段和满分并列。实测旧笑类长句让 119/200 张进入 L0，旧无语震惊长句让 112/200 张进入 L0。
- 仅把长句换成空格关键词仍不够：多个关键词继续累加封顶，且高频 tag 会制造大量满分候选。forced emoji 路径应传结构化、有优先级的 `tags/useCases`，管理器对精确字段匹配单独打分；自由文本 query 只作为低权重兜底并兼容旧调用。
- 标签映射必须按具体话语拆细：例如“笑死”主标签为 `笑死`，“无语”主标签为 `无语`，“真的假的/看傻”主标签为 `震惊/疑惑/懵逼`，“委屈”主标签为 `委屈`，“害羞”主标签为 `害羞`，“抱抱/哄我”优先 `安慰 + 安慰对方`，不能把整个大类统一塞进一串宽泛词。
- 用户进一步澄清了更上层的设计：表情包是主对话的回复形态，不应由正则策略先决定 `emoji_only`。主模型不调用工具即纯文字，调用工具且不传 `followUpText` 即纯表情，调用并传 `followUpText` 即混合回复。
- 因此 `apps/test.js` 的 forced `sendLocalEmojiTool` 路由和 `SendLocalEmojiTool` 根据原消息清空配文的逻辑都应撤掉。共享策略只决定“表情工具是否可见”，并在严肃、技术、求助场景隐藏；选图字段由已经理解完整对话的主模型填写。
- 线上真实 tools 模型 12 组探针证明三种形态都能自主出现：普通招呼选择纯文字；离谱、尴尬、抱抱、晚安、明确要无语表情选择纯表情；群友翻车、下雨、疲惫、拿到 offer、明确“再说我马上到”和上下文接梗选择文字加表情。
- 探针也暴露了参数契约仍需收紧：模型会创造库内不存在的 tag/useCase（如“温暖、群友喜讯、庆祝、撒娇互动、群友晚安、告别”）。虽然同次调用通常也带有真实主标签，未知词不会精确命中，但要真正做到“基于库内标签”，schema 应提供真实枚举，管理器执行前也应按当前目录词表过滤未知字段。
- 工具 schema 现在启动时从实际 ndjson 读取词表：线上当前暴露 125 个真实 tags、120 个优先 useCases；管理器再按完整 200 条库过滤模型偶尔越界的字段。实测输入 `无语/温暖/震惊 + 无言以对/群友晚安` 会收口为 `无语/震惊 + 无言以对`，并以 `tag_scene` 0.992 选中 `[震惊,无语,懵住,惊讶]`。
- 普通短聊开放表情工具后必须反查兄弟工具，否则会把未列入排除词表的操作请求误缩成“只给表情工具”。14 类 manifest 审计发现文字转图片和“群名片...改成”自然语序缺口，已同时补 emoji 排除与 changeCard manifest 触发。

## 2026-07-15 Excel 工作簿工具排查
- 当前 `processUploadedFile.js -> textract` 会把上传文件抽成纯文本，无法可靠保留 sheet、单元格地址、公式和 cached result，不适合“查 Sheet1!B7 的公式和值”。
- `utils/fileUtils.js` 已有当前/引用文件 URL 获取，但实现偏旧且只覆盖部分 `reply_id/source` 形态；`groupContextResolver` 能枚举 file 媒体，但只保留可直接识别的 URL，file_id/fid-only 的 QQ 文件可能丢失。
- 新 Excel 工具应自己统一解析当前消息、引用消息、`_groupContextAssets` 和当前用户近期消息中的 file segment；有 file_id/fid 时通过 group/friend `getFileUrl` 或 OneBot `get_group_file_url/get_private_file_url` 按需换取链接。
- 解析库选择 `exceljs`：支持 xlsx/xlsm 类 OOXML 工作簿、sheet、单元格公式和 `result` 缓存值，且不会执行 VBA/宏或外部链接。旧二进制 `.xls` 不应假装支持，需提示另存为 `.xlsx`。
- 公式库不负责完整 Excel 计算引擎；正确语义是返回 `cell.formula` 和工作簿内保存的 `cell.result`/显示文本。若没有 cached result，应明确“文件未保存计算结果”，而不是服务器自行猜值。
- 最小操作应覆盖：`list_sheets`、`read_cell`、`read_range`、`find`；范围和搜索必须限量，下载要限制大小、超时并防止访问内网地址。
- 工具不应设为 terminal：读取结果回到主对话模型，让希洛自然回答，但工具输出必须结构化包含精确公式、值、显示值和地址，提示模型不得改写公式。
- 线上实际 tools 模型对 4 种说法均能正确抽参：单格 -> `read_cell/sheetName=预算表/cell=C12`，列 tab -> `list_sheets`，sheet 内搜索 -> `find/sheetName=明细/query=20260715`，附文件后短问 B7 -> `read_cell/cell=B7`；均没有凭空要求 fileUrl。
- ExcelJS 最终按插件 workspace importer 安装，根项目的临时重复依赖已移除；从 `plugins/bl-chat-plugin` 解析成功，避免把插件依赖永久污染 root package.json。
- 用户追加的“群文件”指 OneBot 群文件仓库，而不是聊天消息 file segment。NapCat/OneBot 可通过 `get_group_root_files` 获取根文件与文件夹、`get_group_files_by_folder` 递归子目录，再用 `get_group_file_url(group_id,file_id,busid)` 换下载链接。
- 群文件仓库可能存在同名文件和深层目录，正确策略是精确文件名优先、再做唯一模糊匹配；多个候选必须返回完整目录路径。无文件名时只能在群内恰好一个 Excel 时自动选择，否则先列出候选。
- OneBot 群文件读取需要组合 `get_group_root_files`、`get_group_files_by_folder` 和 `get_group_file_url`；下载 URL 请求必须把文件记录中的 `busid` 一并传回，不能只传 `file_id`。
- 群文件仓库采用有界广度优先遍历：默认最多 5 层、100 个目录、500 个 Excel 文件；子目录 API 失败只跳过该目录，根目录 API 失败则明确报错。
- 文件定位优先当前消息、引用和近期上传；这些来源都没有可用工作簿时才查当前群文件。指定文件名时先精确匹配，再允许唯一模糊匹配；同名或多候选必须返回完整目录让用户消歧。
- 新增 `list_group_excels` 后，模型可以先回答“群文件里有哪些 Excel”，再用 `fileName` 和可选 `folderPath` 执行 `read_cell/read_range/find/list_sheets`。
- 群文件增强本地语法检查通过，Excel、manifest、群上下文定向回归 28/28。
- 线上同组定向回归同样为 28/28；真实 tools 模型对“群文件里有哪些 Excel”和“查群文件预算.xlsx里预算表的 C12”两条探针均正确调用 `excelWorkbookTool`，参数分别为 `list_group_excels` 和 `read_cell/fileName/sheetName/cell`。
- 重启后 live 配置中 `excelWorkbookTool` 恰好启用一次，运行时注册表包含该工具，operation enum 已包含 `list_group_excels`；服务、Guoba、36 插件和 OneBotv11 均正常。

## 2026-07-15 Excel 查询慢与不准确诊断
- 线上真实请求为 13:15:00 的“引用阿兹海默-霍亨索伦.xlsx，找第二个 tab 里面跟 .st 有关的内容”。最终 13:15:23 才发送回复，总耗时约 23 秒。
- 其中固定消息合并等待约 3 秒；前置语义工具分类从 13:15:03.750 到 13:15:16.752，单独耗时约 13 秒，是最大延迟来源。
- 分类器没有执行用户真正要的搜索，而是生成 `excelWorkbookTool({operation:"list_sheets"})`，理由是“第二个 tab 没有具体 sheet 名”。但 `resolveExcelWorksheet()` 本身早已支持数字字符串 `"2"`，schema/详细规则没有告诉模型可直接用序号。
- `list_sheets` 成功返回第二个 sheet 为“人物卡”，随后工具轮把合成的 assistant tool call 重新交给 thinking 工具模型；该调用不是模型原生生成，因而没有可回传的 `reasoning_content`，上游返回 400：`The reasoning_content in the thinking mode must be passed back`。
- 400 后流程退回普通聊天模型做最终总结，携带约 7548 个 prompt token；它只能看到 sheet 列表，无法继续调用 `find`，却回复“我先筛一下告诉你”，形成未实际搜索的承诺和不准确答案。
- 用同一 950475 字节工作簿在线上实测：下载 413ms、ExcelJS 解析 1196ms、在第二个 sheet 扫描 15747 格查找 982ms，总计约 2.59 秒。Excel 读取本身不是 23 秒的主因。
- 对该文件做原始 xlsx ZIP/XML 扫描，整个工作簿中 `.st` 字面量为 0；当前 `find` 仅做值/显示文本/公式的字面子串搜索，不理解“COC 的 .st 命令所关联的属性/技能内容”这种语义关系。
- 第二个 sheet 有 7089 个非空坐标，包含大量合并单元格；搜索目前按坐标遍历，合并区域会重复命中同一 master，部分 ExcelJS 公式/合并显示文本会呈现 `[object Object]`，会进一步造成结果噪声和不准确。
- 正确修复顺序应是：先让 Excel 常见请求走本地确定性抽参并支持 sheet 序号，避免 13 秒分类；再让一次工具调用直接完成 `find`；修复合成 tool call 的 reasoning/multi-round 边界；为短期工作簿加缓存；最后增加去重后的结构/语义搜索，并用紧凑结果直接回复，避免 7548-token 总结。
- 已新增共享 `excelRequestPolicy`：真实原句稳定解析为单次 `find(sheetName="2", query=".st")`，并为 `.st` 生成文件内检索用的属性/技能/STR/CON/DEX/POW/EDU/SAN 等关联词；普通“第二个方案”不会误触发。
- 工作表解析原本就支持数字序号，现在 schema、manifest 和本地策略统一暴露该能力；明确说“第二个 tab”不再先调用 `list_sheets`。
- Excel 工具增加 5 分钟、最多 8 项、按群和文件身份隔离的进程内缓存；同一文件连续 `list/find/read` 只下载和解析一次，失败条目立即删除，不落盘。
- 查找改为按合并区域 master 去重，并修复公式/合并格显示文本的 `[object Object]`；关联搜索按原词、值/显示文本、公式分层评分，并明确输出“原词精确命中数”和“关联词命中”，避免把语义相关伪装成字面命中。
- 新增共享 `toolContinuationPolicy`：Excel 使用精确结果直接回复；其他由本地/语义规则合成的工具调用在执行后走无工具聊天总结，不再重新进入要求原始 `reasoning_content` 的 thinking 工具模型；模型原生 tool call 仍保留正常多轮。
- 本地 Excel、参数策略、续轮策略、manifest 和群上下文回归 38/38。
- 真实 0.91MB 工作簿上线前复验：第一次完整下载、解析、构建去重索引和关联搜索为 2523ms；相同文件后续查询复用工作簿和搜索索引，分别为 8ms、6ms。
- 新结果在“人物卡”中优先返回力量 STR、敏捷 DEX、意志 POW、体质 CON、外貌 APP、教育 EDU、体型 SIZ、幸运 Luck、理智 SAN、技能表等文件内真实内容；明确标注 `.st` 原词精确命中 0，不再谎称找到了字面量，也不再出现 `[object Object]`。
- 为明确可确定解析的 Excel 请求关闭 3 秒点名/工具合并等待；普通聊天和其他需要合并的请求保持原配置，不全局关闭 debounce。
- 最终线上相关回归 38/38，服务重启后 active、Guoba 正常、加载插件 36 个、OneBotv11 已连接，未见 ExcelJS、语法、载入或 `reasoning_content` 新错误。

## 2026-07-15 引用 Excel 被误路由为图片识别
- 群 `609235590` 在 14:09:57 的请求是“引用 xlsx，告诉第二个 tab 的 B40”；14:11:03 又明确问“简化卡 tab 的 B40”。两次实际均调用 `googleImageAnalysisTool`，传入的所谓图片正是 QQ Excel 下载链接。
- 根因位于旧 `TakeImages()`：它无条件接受 `type === "file"` 的 URL，完全不检查文件名、扩展名或内容签名；因此 xlsx/pdf 等任何引用文件都会污染 `images`。
- 图片分析确定性路由位于 Excel 本地解析之前，`images.length && isImageAnalysisRequest()` 又会把“告诉我内容”识别为看图，导致 Excel 策略根本没有执行。
- 图片工具完成后，聊天总结模型从旧历史错误“回忆”出 B40 是“闪避 80”；日志证明该回复不是任何 Excel 工具结果。
- 真实文件读取结果：第二个 tab 为“人物卡”，B40 的值和显示值均为 `☐`；“简化卡”的 B40 公式为 `=附表!S24`，cached/display value 是完整的 `.st 力量60str60...炮术10` 指令文本。
- 已新增共享媒体类型策略：明确图片扩展名的 file segment 仍作为图片；xlsx/pdf 等明确非图片文件直接排除；无扩展名文件只有内容签名验证为图片后才进入图片链路。
- Excel 参数解析现在在图片/视频路由前执行；“第二个 tab B40”和“简化卡 tab B40”分别稳定生成 `read_cell(sheetName="2", cell="B40")` 与 `read_cell(sheetName="简化卡", cell="B40")`。
- 本地与线上相关回归扩展为 42/42；线上运行级 `TakeImages` 验证 xlsx 返回 0 张图片、png file 返回 1 张图片。

## 2026-07-15 工具未命中禁止编造
- 线上完整请求体证明刚才 `googleImageAnalysisTool` 的真实结果是空对象 `{}`；旧 `isToolResultError()` 只识别 error/失败字样，把 `{}` 误判成成功。
- 空结果随后与 7000+ token 的人设和聊天历史一起进入总结模型，旧历史中恰好有先前错误回复，模型因此“回忆”出 B40=`闪避 80`。这是明确的无证据补全，不是识图或 Excel 结果。
- 已新增共享 `toolResultGrounding`，统一分类 `success / empty / not_found / error`；空字符串、`{}`、`[]`、`null`、空 analysis/content/data、未找到、0 匹配和错误均有确定语义。
- 当本轮所有非终态工具均无可用结果时，主流程直接发送“没有拿到/没有找到，不猜”的确定性回复，不再请求任何聊天模型，因此历史内容没有机会补空白。
- 当多工具轮只有部分结果可用时，会注入共享事实边界：最终回复只能陈述本轮工具结果明确出现的事实；聊天历史、旧回复、记忆和常识不得替代失败或未命中的工具证据。
- `GoogleImageAnalysisTool` 已把空 content 转成明确 error，并删除“识图失败后不必透露、正常回复”的危险诱导语。
- 本地和线上相关回归扩展为 46/46；服务重启后 active、Guoba 正常、36 插件加载、OneBotv11 已连接，未见语法或模块错误。

## 2026-07-17 线上图片编辑失败复核
- 线上当前进程 PID=3781000，service active，启动于 17:57:03；当前配置不是本地默认值。
- `imageGenerationAiConfig.providers` 当前为 `grok -> Krill / grok-imagine-image / priority 10` 与 `gpt-image-2 -> Sou / gpt-image-2 / priority 1`；`imageEditAiConfig` 仍是独立旧配置 `Krill / gpt-image-2`，没有配置 `grok-imagine-image-edit`。
- 17:59 群 609235590 的实际请求是“用 grok 画”，语义路由与 bananaTool 均判定为文生图并严格锁定 grok；上游首错为 `400 Invalid request format`。
- 该文生图失败后，终态回复却写成“这次图片编辑没有完成……按原图……再试”，属于失败文案任务类型错配，不是请求真的被路由成编辑。
- 23:46 与 23:59 两次未指定 Grok 的真实图片编辑均走 `googleImageEditTool`，正确读取引用图，约 55-115 秒后收到 `b64_json` 并成功发到群；当前 `imageEditAiConfig` 链路可用但较慢。
- 需要分开修复：Grok 文生图因当前渠道权限/模型暴露而 400；终态失败提示把生成误称为编辑；普通 `gpt-image-2` 编辑已有成功证据。
- 重新用线上当前两把 Key 请求 Krill `/v1/models`：Grok provider 的 Key 只返回 `grok-4.5`；独立图片编辑 Key 返回并包含 `gpt-image-2`，但不包含任何 `grok-imagine-image*`。这与真实行为完全一致：Grok 生成 400，`gpt-image-2` 编辑成功。
- 因此不能把线上编辑模型直接改成 `grok-imagine-image-edit`：当前两把 Key 都没有暴露该模型，而且用户给出的编辑示例没有参考图字段；贸然改配置只会把当前可用的编辑链路改坏。
- 代码根因也已定位：`apps/test.js#getFriendlyFailureMessage()` 对 `bananaTool` 无条件传 `operation: "edit"`；`BananaTool#getQueuedFailureMessage()` 同样无条件标记 edit。bananaTool 实际同时承担文生图和带参考图编辑，导致所有文生图未知错误都可能被说成“图片编辑失败”。
- 修复后由错误文本中的强任务证据自动决定 generate/edit；BananaTool 自身异常也按是否携带参考图分别包装“图片生成失败/图片编辑失败”。
- `400 Invalid request format` 新增独立 `request_contract` 分类，不再当作暂时性未知错误；生成场景明确回复“图片生成渠道当前没有接通，原样重试也不会解决”。
- 线上运行模块已用原始 17:59 错误回放，得到预期生成文案；不再出现“图片编辑、原图、稍后重试”。

## 2026-07-18 B站视频聊天记录富化
- 线上服务器当前时间 00:23，TRSS PID=3869216、service active；00:19 重启后的 journal 和 `command.2026-07-18.log` 尚未出现群 609235590 或 bilibili/BV/b23/CQ:json/CQ:video 命中。
- 不能据此断言用户没有发送：B站卡片可能位于重启前日志、Redis/MessageArchive，或以当前过滤词未覆盖的 OneBot 卡片段进入。下一步直接检查结构化聊天记录和原始消息持久化。
- 当前存在两套聊天记录：`utils/MessageManager.js` 将最近消息存入 Redis `ytbot:messages:<type>:<id>`，供群聊上下文使用；`utils/MessageArchiveManager.js` 将完整记录追加到 NDJSON，供新的 `.群聊天记录` 查询。
- Redis 格式化对 `json/xml` 只写“发送了卡片消息”，对 `video` 只写“发送了一个视频”；虽然 Redis 记录还附带 `message` 原始数组，但模型主要读取 `content`，无法获知卡片标题、作者、封面或页面链接。
- NDJSON 的 `normalizeMessageSegments()` 只保留少数字段，JSON 卡片关键 payload 通常位于 `data.data`，当前未保留；`renderSegment()` 又把 JSON 固定渲染为 `[json消息]`。因此新的聊天归档甚至可能丢失原始卡片内容。
- 需要抽取一个共享 B站消息解析器，同时接入 Redis content 与 NDJSON 结构化记录/可读渲染，避免两套记录再次漂移。
- 已在线上 Redis 找到用户 00:11:56 的真实消息，message_id=579041999：OneBot 类型为 `json`，payload 是“哔哩哔哩”QQ小程序卡片，卡片 desc 为“听星野呜嘿伊呀8小时纯享”，preview 为 QQ 临时封面，qqdocurl 为 `https://b23.tv/JvNsiRF?...`。
- 当前 Redis `content` 确实只有“发送了卡片消息”；NDJSON 记录的 `message` 只剩 `{type:"json"}`，但 `raw_message` 仍保存完整 CQ JSON，因此现有记录尚可回填，未来记录应直接结构化保存。
- 该短链实时解析为 `BV1H7Gq6zEiC`。B站 view API 返回标题“听星野呜嘿伊呀8小时纯享”、UP主“最喜歡星野啦”、aid=116622337511895、cid=38547883096、总时长 21795 秒、正式封面和 3 个分P；player/v2 当前无字幕。
- 不应把有时效的 CDN 播放流永久写进聊天记录；适合长期保存的是 B站页面 URL、BV/AV/CID、分P、时长、标题、UP主、描述、正式封面。后续真要分析画面时再按 BV/CID 现场解析播放资源。
- 已实现共享 `bilibiliMessage.js`：识别 QQ小程序 JSON/原始 CQ JSON/BV 链接，短链跳转和 view API 共用 30 分钟 Promise 缓存、5 秒总超时；网络失败保留卡片标题、临时封面和短链。
- Redis 新记录会把 B站 JSON 段替换成结构化 `bilibili` 段，content 包含标题、UP、BV、时长、分P、视频页面和封面；NDJSON 同样保存结构化字段并可搜索/渲染。普通原生 video 段的 URL 也不再在可读归档中丢失。
- 提供精确回填脚本，可按群号和消息 ID 更新既有 Redis/NDJSON 记录，并保留 Redis 原 TTL；不会下载视频文件。
- 线上 b23 最终页对服务器返回 412，但响应最终 URL 已包含 BV；view API 正常 200。解析器现先利用最终 URL 提取 BV，再决定是否把非 2xx 当失败，兼容 B站的反爬页面状态。
- 现有 message_id=579041999 已成功回填为 resolved：标题、UP、BV1H7Gq6zEiC、aid、cid、6:03:15、3 个分P、正式封面和稳定视频页面均已进入 Redis 与 NDJSON。
- 用户明确只要求“搬运”，不需要视频总结；本轮不接入 VideoAnalysisTool，不生成字幕/画面摘要，也不下载整段视频。
- B站 `x/player/playurl` 可按 BV/CID 返回 MP4 durl；当前长视频 P1 在 480p 约 81.8MB、时长约 2 小时。请求 qn=16 时服务仍可能实际返回较大的文件。
- bilivideo CDN 直链不带 B站 Referer 实测 403，带 Referer 才 200，因此不能把 durl 直接交给 NapCat；<=30 分钟的视频本体需要查询时带 Referer 下载到临时文件，再作为本地视频段发送，发送后清理。
- 30 分钟规则按 `duration` 总时长执行：1800 秒允许，1801 秒在调用 playurl 前直接返回空，保证超长视频不会触发下载。
- 查询渲染会始终附带封面；短视频按分P现场解析 playurl、流式下载至系统临时目录并作为 `segment.video(localPath)` 放入合并转发，回复完成后清理。下载有 10 分钟超时和 512MB 流式硬上限。
- 远端完整依赖集成已验证：长视频分支不调用下载、包含封面和“超过30分钟”提示且无 video 段；短视频分支会生成临时 MP4、加入 image/video 段，并返回待清理文件列表。
- B站最低档请求使用 `qn=6`（240P）；若视频不提供 240P，接口会回落到该视频实际支持的最低档。真实样本请求 qn=6 和 qn=16 均返回 quality=16，证明该视频最低只有 360P，不会被强行提升。
- 用户刚发送的 message_id=867407795（00:55:13）已成功解析：`BV1Mo7J6mEM4`、时长 10 秒、正式封面、UP 和视频页面均已写入 Redis/NDJSON。此前没有群内可见回复，不是解析失败，而是实现只做了静默入库。
- 用户期望的“搬运”应在收到卡片时主动回复；现有 30 分钟/最低分辨率代码只接在 `.群聊天记录` 查询渲染，无法满足该自动触发预期，需要抽成共享媒体搬运逻辑供实时归档入口复用。

## 2026-07-18 Redis 群聊上下文保留期
- 线上 `config/message.yaml` 当前为 `groupChatMemoryDays: 1`；群 609235590 的 `ytbot:messages:group:609235590` 实测 TTL 为 85771 秒（约 23小时50分）、约 20KB，当前共有 9 个 `ytbot:messages:*` key。
- `MessageManager.recordMessage()` 每次 `SET ... EX` 都重置整个群 key 的 TTL；因此活跃群会一直续期，确实不符合“不太长”的预期。
- 主聊天链路以 `groupChatMemoryDays` 初始化 MessageManager；热更新代码却写入了不存在的 `cacheExpireDays` 小写属性，实际 TTL 属性为 `CACHE_EXPIRE_DAYS`，配置热更新无法收紧已初始化实例。
- 还有 legacy `apps/MessageManager.js` 独立创建 MessageManager 并写同一个 `ytbot:messages:*` key，采用默认 1 天；修复必须覆盖两处写入方，否则主会话即便缩短，legacy 写入仍会把 TTL 恢复到 1 天。

## 2026-07-18 抖音分享链接解析
- 群 `609235590` 的 message_id=`1176454618` 是普通 text 段，包含 `https://v.douyin.com/EULdbQEydtc/`；现有链路没有识别它，因此只按原文写入 Redis。
- 该短链在服务器用移动 UA 跟随重定向后落到公开 `iesdouyin.com/share/video/7661206883327471737` 页面，HTTP 200。
- 页面内存在可 JSON.parse 的 `window._ROUTER_DATA`；真实数据位于 `loaderData["video_(id)/page"].videoInfoRes.item_list[0]`，可获得描述、作者、时长、statistics、封面和 play_addr URL。
- 真实样本含作品 ID、16 秒时长、点赞/评论/转发/收藏计数与封面/播放地址，证明公开分享页路径可用；页面也有 captcha/verify 标记，必须有短超时、失败保留原链接，不能假设永远可抓。
- 首次真实自动搬运只发出“视频本体获取失败”，根因不是抖音 CDN：长期归档规范化刻意删除 `play_url`，而实时搬运错误地从该已脱敏的记录读取媒体。修复为 record 返回一个不可枚举的 `runtimeMessage`（不写 NDJSON/Redis），实时出口只用它下载本体。
- 群 `828466745` 已在 AI 白名单，抖音两次均成功解析、下载并构造视频节点；最终失败是 OneBotv11 通用适配器把大 base64 改写为 `/opt/trss-yunzai/temp/...`，NapCat 容器无法读取宿主路径，`send_group_forward_msg` 返回 ENOENT。含视频的转发已改为直接调用 OneBot 原始 API，保留 base64，避免适配器落盘改写；长视频/无视频仍走常规合并转发。
# 2026-07-17 用户指定图片渠道
- 当前 `imageGenerationFallback` 已统一规范化 provider 名称、优先级和编辑能力，但候选解析只按 priority 排序，没有用户指定名称这一层。
- 需要让“未指定渠道”和“明确指定渠道”成为两种不同选择语义：前者保留 fallback，后者严格锁定匹配名称并在不可用时明确失败。
- `BananaTool` 的强制生图调用和 `GoogleImageEditTool` 的强制编辑调用当前参数都只有 prompt/images；即使 LLM 理解了“用 Grok”，也没有结构化字段传到执行层。
- 不能只依赖 LLM 填参数：多数图片请求在 `apps/test.js` 中会构造 synthetic forced tool call。工具执行时还需从原始 `e.msg` 按当前配置名称确定性提取，队列任务则把解析后的 provider 一并持久化。
- 图转图存在两类路径：OpenAI-compatible `/images/edits` 候选，以及当前 `imageEditAiConfig` 的 chat-completions 主通道。严格名称选择必须同时覆盖两类，且禁止指定候选失败后跨名称回退。
- 17:43 真实 Grok 文生图失败的首错为 `400 Invalid request format`。线上当前请求为 `/v1/images/generations` + `model=grok-imagine-image` + `size=1024x1024` + `n=1` + `response_format=b64_json`。
- 用户提供的 Krill 教程调用同一 `images.generate`，但要求 `model=grok-imagine-image-edit`、`quality=high`，且示例不显式传 `n/response_format`；因此当前 Grok provider 的模型 ID 和请求字段契约至少有两处不一致。教程虽使用带 `-edit` 的模型名，但没有输入参考图，证明的是文生图调用，不足以证明 `/images/edits` 图转图能力。

# 2026-07-19 抖音临时播放地址刷新
- `utils/douyinMessage.js` 之前缓存整个解析卡片 15 分钟，其中包含抖音 CDN 的短时 `play_url`。再次转发命中该缓存时，会将旧 URL 交给下载/发送链路，导致客户端显示视频已过期。
- 修复将默认解析缓存降为 30 秒，仅承担几乎同时到达同一短链的请求合并；`enrichDouyinShare` 还接受 `cacheTtlMs`，即时转发可明确要求不复用缓存。
- 归档/Redis/NDJSON 继续不保存 `play_url`；该地址仅在实时 `runtimeMessage` 中使用，避免把失效资源当作长期媒体信息。
- 本地与远端完整依赖环境相关回归均为 6/6；远端当前进程重启后已加载 36 个插件，OneBotv11/NapCat 恢复连接。

# 2026-07-19 Modrinth 模组榜
- `GET https://api.modrinth.com/v2/search` 是无需登录的公开接口，支持 `index=downloads/follows/newest/updated/relevance`、`project_type:mod`、MC 版本、加载器与分类 facets；返回项目 ID、slug、标题、作者、简介、下载量、关注数、图标和支持版本。
- `GET /v2/project/{id}/version` 可按 `game_versions` 与 `loaders` 继续查询版本号、发布日期和发布文件；默认排名工具不应把文件 URL 当作自动下载指令。
- 已用 1.21.1 + Fabric + 下载量排序验证真实响应；结果数据会变化，生产回复需注明按查询时的实时数据。
- 生产工具采用 8 秒请求上限与 2 分钟进程内缓存，每次最多 10 项；只输出项目页，绝不自动下载 `.jar`。工具结果回流时由系统规则要求“英文简介 + 中文翻译（希洛）”，并禁止把翻译或模型补充伪装为官网原文。

# 2026-07-19 Modrinth 文字输出问题
- 群 `953676639` 的真实调用只执行了 `modrinthTool`；模型随后输出 Markdown 排名文本，最终发送层的 `getTextImageTemplateForFinalReply()` 因长结构化 Markdown 自动调用 `textImageTool`，不是用户要求的卡面。
- 现有双语规则只强制英文简介和译文，未把作者、关注数、标签、项目页列为必填字段，导致模型为了口语化压缩了真实工具结果。
- 修复后 `modrinthTool` 默认绕过自动文字转图片；只有原话明确含“转成图片/生成图片版/长图/发成图/做成图/图片形式/避免刷屏”才允许转图。最终规则要求每项按名称、作者、下载、关注、标签、英文简介、中文翻译、项目页完整输出。
- 最终发送改为严格 `MODRINTH_ITEM` 块协议：每个字段完整的块成为一条合并转发节点，块外的总评、推荐与追问不参与发送。线上探针确认 1 个块产出 1 个节点，块外“总结别发”被丢弃。

# 2026-07-19 Modrinth 翻译延迟
- 一次真实 Modrinth 排名请求的 API 查询耗时不足 1 秒，后续最终模型调用约 11 秒；该调用携带约 8908 个 prompt token 的人设、群历史与工具结果，并因复杂度路由进入 `deepseek-v4-pro`，还产生了 282 个 reasoning token。
- 修复使用“工具原始结果 + 严格项目块协议”的两条消息，显式走 `chatAiConfig` 的快速聊天模型。只有本轮累计结果全部为成功的 `modrinthTool` 时才启用；失败时回退既有通用续轮，不编造项目资料。
- 线上 `chatAiConfig.chatApiModel` 当前为 `deepseek-v4-flash`；API 路由定向测试验证复杂无工具上下文仍到 Pro，而 `forceChatBackend` 紧凑请求到 Flash。
- 已备份并同步 5 个目标文件，备份为 `/opt/trss-yunzai-backups/bl-chat-plugin-modrinth-fast-translation-20260719-210618.tar.gz`；线上 Modrinth 回归 8/8、相关意图/续轮回归 13/13、API 路由回归 1/1。目标文件 SHA-256 与部署副本一致。
- 安全重启后 PID 从 292190 切换为 297191，service active，加载插件 36 个，OneBotv11 WebSocket 已建立。

# 2026-07-19 Modrinth 排名占位符
- 提示词同时写了“第 N 名”字段和 `第 N 名: ...` 样例；模型将 N 当作字面量，再把实际排名填在冒号后，产生 `第 N 名: 5`。
- 旧严格解析器只接受 `第 <数字> 名:`，因此该块无法被提取为转发节点，最终退化为普通文本。修复将新格式改为 `排名: 第 5 名`，并只对明确的旧占位符行做无损规范化。
- 已备份并部署 `utils/modrinth.js` 与其定向测试，备份为 `/opt/trss-yunzai-backups/bl-chat-plugin-modrinth-rank-format-20260719-212247.tar.gz`；线上回归 9/9，包含真实坏格式的规范化断言。安全重启后 PID 从 297191 切换为 300928，service active、加载插件 36 个、OneBotv11 WebSocket 已建立。

# 2026-07-19 跨群视频搬运入口顺序
- 线上 21:21:19 收到同一 B站卡片：609235590 与 981339693 相差 40ms；609235590 已写入 resolved B站归档，981339693 没有归档记录，也没有发送或发送失败日志。归档配置没有 include/exclude 群限制。
- Yunzai 按数值升序执行插件，任一规则返回非 false 就停止后续规则。全局聊天插件优先级 9999，归档搬运插件原为 10050；609235590 的聊天流程 SmartSkip 返回 false 因而搬运成功，981339693 的聊天流程返回已处理导致归档入口完全未执行。
- 仅把归档入口提到前面会让短视频下载占住 Yunzai 的规则链直到发送完成；归档入口因此需要立即返回 false，并对事件做快照后在后台完成归档/搬运。
- 已备份并部署 3 个目标文件，备份为 `/opt/trss-yunzai-backups/bl-chat-plugin-video-dispatch-background-20260719-213658.tar.gz`；线上 B站/抖音自动搬运与优先级回归 6/6。重启后 PID 从 303484 切到 304834，service active，动态 status 插件补入后 OneBotv11/NapCat 于 21:38:16 已连接；目标文件 SHA-256 与部署副本一致。
- 后台化后的两条新视频均未入库，且没有发送或失败日志。根因是 `snapshotArchiveEvent()` 的 `{ ...e }` 不会复制 Yunzai 事件的非枚举 `message_type`；`MessageArchiveManager.shouldRecord()` 因此直接返回 false。修复必须显式保留消息类型和归档/发送依赖的运行时字段。
- 已备份并部署快照修复，备份为 `/opt/trss-yunzai-backups/bl-chat-plugin-video-dispatch-snapshot-20260719-214400.tar.gz`；线上自动搬运、后台释放和非枚举事件字段回归 7/7。安全重启后 PID=306724，OneBotv11/NapCat 于 21:45:19 已连接。
- 次日 10:06 在 609235590 的真实 B站卡片仍未入库，证明后台化不能仅靠离线探针认定为可用。已回退后台化/快照，恢复已验证的同步 `recordArchiveMessage()` 路径；线上 B站/抖音转发回归 5/5，安全重启后 PID=483832，OneBotv11/NapCat 于 10:11:52 已连接。
- 同步路径在真实 10:18 B站卡片中仍未入库，排除后台问题；归档规则在 9000 前仍被其他规则截断。下一轮将其调为 `-Infinity`（与基础消息记录同级），并用媒体卡片入口日志验证调度而非依赖离线测试。
- 部署后用线上依赖与当前磁盘源码做了无发送的端到端回放：`MessageArchiveRecorder` 实例 priority 为 `-Infinity`，真实入口返回 false，B站卡片构造出 1 个合并转发节点，回放通过。该回放不替用户群发送测试消息。

## 2026-07-20 609235590 跨群搬运仍缺失
- 线上 10:41:04 收到同一卡片：`953676639` 先进入 `MessageRecordPlugin.autoRelayArchivedMedia()` 并记录“主记录入口捕获”，紧随其后的 `609235590` 已归档但没有对应捕获或发送日志。
- 两条记录均已成功写入当天 NDJSON，说明不是识别、群白名单、B站解析或归档失败；问题发生在实时搬运入口的去重判断之后。
- 旧逻辑把 `_archiveMediaRelayed` 写到 Yunzai 事件对象。该对象在连续群事件中被适配器复用时，前一条 `953676639` 留下的标记使后一条 `609235590` 被错误跳过。去重必须基于稳定的 `group_id:message_id`，不能修改 `e`。
- 媒体下载/资源组装在旧实现的发送 `try/catch` 之外，若播放地址或下载环节抛错会静默退出，连已有的标题、统计和封面都不发送。应将整个组装与发送流程收敛到同一共享出口，并让资源失败降级为信息节点。

# 2026-07-20 消息调用链可靠性重构
- 当前生产存在两个 catch-all 消息入口：`MessageRecordPlugin` 同时写近期 Redis、NDJSON 和实时转发；`MessageArchiveRecorder` 又写 NDJSON 和实时转发。两者依靠临时去重互相抑制，职责和执行顺序并不稳定。
- `utils/MessageManager.recordMessage()` 和 `MessageArchiveManager.recordMessage()` 都会独立执行 B站/抖音富化；实时转发随后再解析播放地址和下载视频。同一事件的网络解析、存储和交付没有单一所有者。
- 近期记录采用整个数组 GET/修改/SET，缺少同 message_id 幂等；长期归档直接 append NDJSON，同样缺少重试幂等。引入可恢复任务前必须补消费者幂等，否则重启恢复会制造重复记录。
- 现有 Redis 使用面稳定覆盖 `get/set/del/keys/scanIterator`，图片持久任务也采用“每任务一个带 TTL 的 JSON key + 启动扫描恢复”。消息 outbox 应优先复用这一兼容面，再按实际客户端能力增加 NX claim；不能把 Redis Streams 当作未经验证的前提。
- Yunzai 原始事件 `e` 含非枚举字段和运行时函数，不能持久化。目标入口必须生成完全可序列化的 EventEnvelope；OneBot 发送能力由独立 DeliveryGateway 通过 botId/群号解析，不能把 `e.reply` 或绑定函数写进任务。
- 用户侧真正需要的是可观察交付状态：每个群的媒体任务独立记录 pending/processing/sent/retry_wait/failed、尝试次数、OneBot retcode 和错误；URL 相同不构成跨群去重键。
- 插件根 `index.js` 对每个 `apps/*.js` 只注册 `Object.keys(module)[0]`。因此 app 文件必须只有一个生产插件 export；`MessageArchiveRecorder.js` 当前有 3 个 export，`MessageArchiveNotice.js` 有 4 个类 export，后者实际只会加载其中一个通知类型。新架构必须把帮助函数移出 apps，并将通知归档收口为单一 notice 插件或拆成单 export 文件。
- 已有图片 durable queue 证明生产环境可用“任务 JSON key + TTL + 启动扫描恢复”，但它仍把恢复事件拼回 `e`。新消息管道可复用 key/扫描模式，不能复用运行时事件伪造；交付应通过独立 Gateway 解析全局 Bot。
- 第一次用独立 Node 进程探测 `globalThis.redis` 得到 undefined，因为该进程没有执行 TRSS bootstrap；这不是线上 Redis 能力结论。后续应以 `/opt/trss-yunzai/lib/config/redis.js` 的包装器源码和 TRSS 启动环境测试为准。
- TRSS `PluginsLoader.deal()` 在构造任何插件列表之前先执行 `checkBlack()` 和 `checkLimit()`；`checkLimit()` 的 1 秒重复键是 `${self_id}:${user_id}:${raw_message}`，明确没有 `group_id`。同一个用户在两个群 1 秒内分享同一卡片时，第二条会在所有 apps 插件之前被丢弃，这正是两个群交替成功的稳定根因。
- TRSS app priority 实际按数值升序执行；后台任务日志晚于 SmartSkip 不能用于推断插件顺序。此前把入口从 `-Infinity` 调到 `10050` 是错误方向，必须撤销，且 durable capture 不能继续依赖 apps 层。
- `Bot.em()` 使用 EventEmitter 逐层发出事件，`Bot.prepareEvent()` 已在发出前注入非枚举 bot/group/friend。直接注册 `Bot.on("message")` 可以绕过 PluginsLoader 的 checkLimit 返回，同时仍获得原始事件；新 Capture 应安装在插件根 index 生命周期，而不是 apps 规则。
- TRSS 的全局 `Bot` 是多 bot Proxy，真实适配器可由 `Bot.bots[botId]` 获取；这为重启后 DeliveryGateway 恢复 `sendApi` 提供稳定入口，不需要序列化 `e.reply`。
- TRSS Redis 包装最终暴露 node-redis client，现有 `{ EX }` 调用和 scanIterator 已在线上使用；durable store 可以采用 `SET NX PX/EX` 锁与 per-job JSON key，同时保留 keys/scan fallback 测试。
# 2026-07-20 消息与媒体调用链重构续接
- 可靠性边界不能放在 `apps/*.js`：线上 `/opt/trss-yunzai/lib/plugins/loader.js` 会在 app 插件前执行重复消息限制，且 key 不含群号。
- 业务幂等键必须包含会话目标，媒体投递使用 `platform:groupId:messageId`，不能继续按 URL 全局去重；同一媒体发往两个群是两次独立投递。
- `index.js` 旧加载器只注册每个 app 模块的第一个导出，多导出 recorder/notice 类不是可靠的启动机制；原始事件管线应由插件根入口显式安装。
- 本轮剩余的已知迁移风险：删除 `MessageManager.onMessage()` 后遗漏 `emojiPackManager.maybeAutoCollect(e)`；NDJSON 当前每条消息全文件扫描做幂等，需改成按文件懒加载的进程内 identity 索引。
- `task_plan.md` 的阶段 2-6 尚未同步实现进度：对应基础代码已经存在，但在完成引用审计、迁移能力核对和运行级验证前保持未完成，避免把“文件已写”误报为“架构已闭环”。
- `apps/MessageManager.js` 仍导入 `emojiPackManager`，但 catch-all `onMessage()` 已删除，导入已无用途；`maybeAutoCollect(e)` 也尚未迁入新事件消费者，属于明确功能回归。
- `RedisJobStore.releaseLock()` 当前用独立 `GET` 后 `DEL` 释放租约；若旧租约到期后新 worker 抢到同一个 lock，旧 worker 的非原子释放可能删除新锁。部署前需要使用 Redis 原子 compare-and-delete，并为内存测试实现等价语义。
- `MessagePipeline.recover()` 与 `MediaOutbox.recover()` 只要看到其他 `runId` 的 `processing` 就立即清锁重置；插件热加载时旧实例可能仍在执行，新的 runtime 会制造并发重复处理。恢复必须尊重 `leaseUntil`，未过期任务延后检查，只有租约到期才回收。
- `DeliveryGateway.sendGroupForward()` 把缺失 `result`、缺失/非法 `retcode` 当作 `retcode=0` 成功；状态机可能记录虚假的 `sent`。成功必须要求可验证的 OneBot 成功回执。
- `sendApi` 抛错时当前标记 `uncertain=true` 但仍默认 retryable；若请求已到 OneBot、仅响应丢失，自动重试会产生两条合并转发。不确定交付应停止自动重试并保留 `failed + uncertain` 供查询，明确 retcode 失败才可按分类重试。
- `MediaOutbox.process()` 对刷新卡片或资源组装异常整体重试，最终可能完全静默；用户验收要求应改为优先使用事件中已持久化的卡片信息，刷新/封面/视频构建失败时仍发送基本信息节点，并记录降级原因。
- `MessagePipeline.processMessage()` 在 recent/archive/media 三个消费者之前统一等待 B站和抖音网络富化；富化抛错会让所有消费者一起失败，也会让同群后续事件排在网络请求后面。这仍是共享前置单点，必须让 recent/archive 能以真实原消息降级写入，媒体消费者独立重试。
- EventEnvelope 不保留 `e.group/e.friend` 运行时方法是正确边界，但 `MessageManager.getFileUrl()` 仍只通过这些方法换 URL，没有优先读取 file segment 自带 `url`；新管道下群文件近期上下文可能丢失可用链接，需要补纯数据 fallback。
- 表情包自动收集包含每张图片最长 10 秒网络下载，不能重新塞进同群核心事件串行队列阻塞 recent/archive；应作为独立、失败不影响核心状态的后台消费者，并保留限额与自身错误处理。
- `MessageManager.getMessages()` 读取 Redis 异常时固定返回空数组；写入路径随后会把历史覆盖成只有当前消息，即使外层传了 `throwOnError` 也无法阻止。写消费者必须使用严格读取模式，读取失败直接让该消费者重试，绝不空表覆盖。
- 近期上下文幂等当前先删除同 ID 再 `unshift`；若旧事件在后续消息写入后恢复重试，会被错误移到最前。相同 ID 应原位替换，新事件才按当前顺序插入。
- NDJSON 幂等可以把每条消息 O(当日文件大小) 的全量读取改成按文件首次懒加载 identity set，后续 O(1) 检查；identity 继续优先 `event_id`，兼容旧记录时使用 `archive_kind + message_id + user_id`，并限制缓存文件数避免常驻增长。
- 当前保留的 15 个 `apps/*.js` 均只有一个真实插件类导出，因此把根加载器改为按 `prototype instanceof plugin` 显式筛选所有插件类不会额外启用未知业务；它只消除“取 Object.keys()[0]”依赖导出顺序的隐患。
- 管道状态已有 Redis 真值但没有对话入口；管理员状态命令应按群过滤并汇总 event/delivery 状态、最近错误和 uncertain 标记，让后续定位不再依赖 SSH 日志。
- 反向引用审计确认自动视频搬运只剩 `MediaOutbox -> DeliveryGateway -> send_group_forward_msg`；`apps/MessageManager.js` 的 B站 relay 仅在管理员主动查询归档时构造附件，不是 catch-all 自动出口。
- `apps/test.js` 仍调用 `MessageManager.recordMessage()`，用途是把机器人自己的最终回复写入近期上下文；原始 Bot message listener负责入站事件，这两个方向职责不同。现有 group notice/guard app 是群管业务，新管道对 notice 只做旁路归档，不应删除。
- `git diff --check` 已通过；生产源码中没有 `_archiveMediaRelayed`、`mediaArchiveRelay` 或旧 recorder 的残留引用。
- `RedisJobStore` 的内存 fallback 适合单元测试，但生产 runtime 若在 Redis 未注入或缺少 `eval/scan` 能力时仍静默使用它，会制造虚假的“durable 已启动”。安装层必须 fail closed 为 unavailable 并保持其他 app 可用，不能宣称可靠运行。
- 线上 TRSS Redis 是 node-redis `createClient()` 实例，具备 `eval`；新 runtime 启动日志已确认没有进入 unavailable 分支。
- 生产迁移后静态插件数从旧 35 降为 33，正好是删除两个旧 app 文件；动态 status 加载后总可见为 34，不是插件漏载。
- 重启后 OneBot/NapCat 已连接，但尚无任何新入站消息进入管道，因此 `event=0/delivery=0` 不能作为双群通过或失败结论；最终证据必须等真实用户事件。

# 2026-07-20 明确知识计算题误回“没接住”
- 用户原话包含明确标准号、波长范围和相对论速度计算目标，语义完整；“没接住你那句/再发一遍”在没有消息丢失证据时属于事实错误，不只是语气问题。
- 本轮必须先从线上真实时间线确认是模型首请求失败、工具路由失败、空响应、超时还是发送层问题，再修改共享失败分类。
- 重启后 journal 中搜索 `GB14887/红灯/蓝移/没接住/刚刚卡了一下` 均无命中；不能据此认定请求未到达，需继续查旧 PID 时间段、Redis event job 和插件文件日志。
- 全日 journal 的“红灯/蓝移”命中是 02:04 另一位群友的旧消息，不是本次请求；最新 `logs/command.2026-07-20.log` 修改时间为 13:01，应以该文件继续还原。
- Redis event/recent key 中暂未命中本次原话；这可能是消息发生在新管道重启前，也可能是原始监听事件名/安装边界仍需复核，必须与错误回复根因分别查证。
- 线上 `11:35` 的相近物理题（650nm 蓝移至 550nm）由 `deepseek-v4-pro` 成功计算为约 `0.166c`；因此问题不在模型物理能力或此类问题的统一策略，异常必然来自另一条失败/丢消息出口。
- 最新 command 日志只在 13:01 记录表情自动收集 503，没有本次原话或聊天模型请求；固定回复更可能在主模型调用前后由共享失败文案生成。
- 固定文案唯一来源是 `utils/chatFailureReply.js:buildGenericChatFailureReply()`；除语气纠正和短问候外，所有失败都无条件声称“没接住你那句/再发一遍”。它没有接收或判断错误类型、请求是否完整、是否已经重试。
- 主链在 `initial_api` 异常和 `initial_api_empty` 无 choices 两类场景都会记录 `[回复失败]`；必须找到本次具体 stage，但无论哪类，完整 userText 都证明“要求重发”是错误归因。
- 线上当天仅有两条 `[回复失败]`，均在 11:55、group=725902146、user=603738185、stage=initial_api、toolChoice=excelWorkbookTool；首错是 `400 Thinking mode does not support this tool_choice`。它们会进入当前 generic fallback。
- 相对论题在 11:35 存在成功模型响应，而本次 `GB14887` 原话未出现在 command/journal/Redis；需核对 11:35 与 11:55 的入站/出站时间线，判断是否存在消息关联错位或用户实际看到的是另一请求的 fallback。
- 真实时间线已闭环：11:55:20 与 11:55:55 两次 `GB14887` 请求都立即记录“Excel 自然语言任务优先”，随后强制 `excelWorkbookTool`，thinking 接口返回 400，再发送 generic fallback；不存在消息关联错位。
- 第一处业务误判是 `GB14887` 的形态同时满足 Excel A1 地址（列 GB、行 14887）。Excel 路由把国标编号当成单元格，说明裸 A1 正则缺少 Excel/工作簿/表格/引用文件等语境门槛；其他标准号、型号、航班/零件编号也可能同类误触发。
- 第二处错误是失败文案归因：即使 Excel 误路由修复，上游异常仍可能发生；完整请求失败必须说明“这次回答服务失败/已保留问题”，不能要求用户重复输入。
- Excel policy 当前 `buildExcelToolParams()` 的入口条件是“有 Excel 语境 **或** 命中裸 A1 地址”，因此任意 `1-3 个字母 + 数字` 型编号都可能抢路由。修复采用语境门槛：裸地址仅在实际 Excel 文件上下文或显式 Excel/sheet/tab/单元格语境中解析。
- `retryRequest()` 目前只在 `YTapi` 抛异常/返回 null 时重试；`YTapi` 返回 `{ error }` 也被当作普通非空响应立即返回，所以 400/503 等结构化失败没有真正执行重试。
- 对精确 `Thinking mode does not support this tool_choice` 可做协议级恢复：保持同一已过滤 tools 列表，仅把显式 function `tool_choice` 改为 `auto` 再试；不跨模型、不换业务工具、不改用户问题。
- 同类失败文案不仅在 generic chat：图片分析、搜索/Web/GitHub 和三角洲无错误详情时也要求“重新发/再问一次”。这些场景原请求同样已经到达，应该改成“本次处理失败、问题已收到”，不得把服务失败归因给用户。
- `initial_api_empty` 当前只写日志后静默返回；用户会看到机器人完全不回复。空 choices 与结构化 `{ error }` 都需要进入统一失败分类和可见终态。
- API 客户端把 HTTP 状态码拼入 error 字符串但不保留结构化 status；当前可先在纯策略层从标准错误文本抽取 400/429/5xx，并把协议兼容限定到精确错误短语，避免为任意 400 盲目重试。
- Excel 正向语境本身也需有边界：英文 `tab/sheet/excel` 不能命中 `stable/stylesheet/excellent` 的子串；“存在文件”也不能视作“存在工作簿”，只有实际 Excel 扩展名的当前/引用媒体才可放宽裸 A1 地址。
- 最终生产状态：原问题 policy 输出 `excelIntent=false/excelParams=null`，明确工作簿上下文中的 `GB14887` 仍输出 `read_cell`；生产完整依赖回归 70/70，修正探针后当前 `deepseek-v4-flash` 对原问题返回完整回答且无 API error。
- TRSS 会扫描 `plugins/` 下的隐藏目录，不能把同层 staging 留到服务重启。以后同层 staging 只用于测试，重启前必须删除，或改用不会被插件加载器扫描但仍能解析依赖的测试挂载方式。

## 2026-07-20 Modrinth 未进入合并转发
- 11:57:19 的真实请求位于群 725902146；modrinthTool 成功返回 5 项，紧凑模型也输出了 5 个完整 `[[MODRINTH_ITEM]]` 块。
- 工具源数据把互动数格式化为 `下载: N | 关注: N`，模型忠实保留了这一行；严格解析器 `MODRINTH_REQUIRED_ITEM_FIELDS` 却要求 `/^关注\s*[:：]/m`，即关注必须另起一行。
- 因 5 个块都缺少独立的 `关注:` 行，`extractModrinthForwardItems()` 返回空数组。`handleTextResponse()` 随后剥掉标记并调用普通 `sendSegmentedMessage()`，所以用户看到两条连续文本。
- 日志中不存在合并转发失败或适配器降级警告；`sendModrinthForwardItems()` 根本没有执行。这不是 QQ/OneBot 发送失败，而是发送前严格解析与上游格式不一致。
- 最小复现为 `combined=0, separate=1`。现有测试只覆盖下载/关注分行的理想样本，漏掉了生产工具真实的合并行格式。

## 2026-07-20 工具调度与媒体/Modrinth 延迟审计
- 最新双群 B站事件到达只差 95ms，进入 OneBot 发送只差 123ms；609235590 在约 27.96s 完成，953676639 在约 33.68s 完成。两个 delivery 均为 `sent/attempts=1/retcode=0`，证明跨群并行有效，最后约 5.8s 是独立 QQ/OneBot 上传发送抖动。
- `enrichBilibiliShare()` 用 BVID/短链做 30 分钟 promise cache，近同时请求会复用元数据；`MediaOutbox.process()` 仍为每个群分别刷新播放资源、构建 relay、下载到唯一临时路径、读 base64，并调用各自的 `send_group_forward_msg`。
- 媒体优化边界应是短期 single-flight artifact，而不是复用 delivery：键为 platform+stable video id+part+quality，复用进行中的下载和短期文件，引用计数后延迟清理，失败立即逐出；抖音临时播放 URL 只共享同一时间窗口的提取/下载，不做长缓存。
- 当前 MediaOutbox 的 per-group queue 覆盖刷新、下载、编码和发送整个过程；可把资源准备放入独立有界池，仅让最终发送按群串行，以免同群慢下载占住发送队列。跨群发送仍必须独立，因此完成时间不会完全一致。
- 当前同轮多个 tool call 已通过 `Promise.all` 并行；消息管道 eventConcurrency=8、deliveryConcurrency=4。性能重点不是继续放大数字，而是拆分 LLM、外部 API、下载、OneBot 上传的资源池，防止互相挤占。
- 明确工具请求仍可能经历 `directTriggerMergeMs=3000`；随后 `classifySemanticToolIntent()` 调 tools 模型，哪怕 `selectToolIntentCandidates()` 只有一个候选也不会直接调用。唯一、参数完备且非敏感的 manifest 应走 deterministic fast path；多义、缺参数、权限敏感任务继续走 planner。
- Modrinth 真实耗时约为 merge 3.0s、semantic classifier 3.4s、API 1.1s、compact translation 4.1s、普通文本降级发送 3.7s，总计约 15.7s。其 API 已有 2 分钟 promise cache，外部查询不是主瓶颈。
- Modrinth 紧凑翻译仍把所有排名字段交给模型重新序列化，既浪费 token 又造成格式漂移。目标协议应只返回 `[{projectId, zh}]`，代码按原始结构化数据组装每项 forward node，并缓存 description hash、locale、promptVersion 的译文。
- `YTapi()` 无论 chat/reasoning backend 都会重建 `finalRequestData` 为 model/messages/stream，当前调用方传入的 `temperature`、`max_tokens`、`max_completion_tokens`、`reasoning_effort` 无法到达后端。应增加配置驱动的 backend capabilities 和有限白名单透传；翻译路由按用途绑定可配置 fast backend，不能写死 DeepSeek 或任何模型名。
- 建议在 job/session 记录 `merge_wait_ms/queue_wait_ms/classify_ms/tool_api_ms/model_ms/download_ms/encode_ms/send_ms/total_ms`，先用 p50/p95 判断是否需要调整各资源池并发。

## 2026-07-20 工具与媒体性能优化实施
- 新增 `MediaArtifactStore`：同一稳定媒体键共享进行中的 producer 和短期本地文件，失败立即逐出，引用归零后按 TTL 清理，并按条目数/空闲磁盘字节淘汰。
- B站 artifact key 使用 `bvid+cid+qn`，抖音使用 `aweme_id+lowest`，不把临时播放 URL 放进键；群级 delivery ID 和回执完全未改。
- 小于配置阈值的文件共享一次 base64 读取；大文件只共享 MP4 路径，每个群单独读取，避免常驻超大字符串。默认阈值 64MB。
- MediaOutbox 新增同一媒体刷新 single-flight，抖音只复用同一时间窗口的页面提取，不延长临时 URL 生命周期。
- 媒体任务开始记录 queue/refresh/playback/download/encode/send/total，并持久化到 delivery job。
- 媒体相关定向测试 12/12 通过。
- B站播放地址增加仅 in-flight 的 promise 复用，请求结束立即删除；不会长期缓存临时 URL。并发两群集成测试确认播放地址请求 1 次、MP4 下载 1 次、relay 结果 2 份。
- 确定性快路当前覆盖：参数可完整解析的 Excel、明确 Modrinth 排名、单一 GitHub 仓库 URL、单一网页解析 URL；禁言等敏感工具、开放式 Excel 和图片请求不会进入快路。
- `smartTrigger.toolRequestMergeMs` 默认 600ms；只有确定性快路使用，其他请求保留 3000ms 连续消息合并窗口。
- ModrinthTool 改为返回 `modrinth_ranking` 结构化 JSON；模型输入只包含 `projectId/en`，输出只接受完整 `projectId/zh` JSON 映射。排名、作者、下载、关注、标签、英文原文和项目页由代码组装。
- Modrinth 译文缓存按英文简介、语言和提示版本的 SHA-256 键保存 7 天进程内 LRU；同一简介再次出现时不调用翻译模型。
- 新增 `taskAiConfig.translation`，可配置任意 OpenAI-compatible URL/model/key；未配置时回退 chatAiConfig，不含厂商或模型名判断。
- `YTapi()` 现在白名单透传 temperature/top_p/max_tokens/max_completion_tokens/reasoning_effort/response_format；可选参数触发兼容性 400 时会记录首错并在同一后端移除参数重试。
- 工具、Modrinth、媒体、Excel 组合定向回归 52 项中 51 通过，1 项仅因本机缺既有 node-fetch 跳过；媒体扩展回归另 18/18 通过。
- 生产服务器对 `api.modrinth.com` 存在 Node fetch 特有的间歇性 Cloudflare 连接超时：curl 强制 IPv4 稳定，Node 默认同时尝试 IPv4/IPv6 时两条 IPv4 也可能 ETIMEDOUT。
- ModrinthClient 现动态加载插件已有的 undici，只为 Modrinth 创建 IPv4 Agent；IPv4 网络失败时才回退默认 fetch。连续真实探针 3/3 成功，后两次复用连接约 0.36 秒。
- 线上真实翻译后端严格 JSON 探针 2/2，耗时约 1.7 秒。最终五项冷链路约 6.64 秒，暖 API+译文缓存约 0.53ms，不含 600ms 合并窗口和 QQ 最终发送。
- 线上目标完整依赖回归 96/96；全量 446 项的 4 个失败均不在本轮变更路径，其中旧自动搬运测试仍依赖已删除的 MessageArchiveRecorder/mediaArchiveRelay，另有既有 UmaRace 随机断言。
- 生产最终配置：toolRequestMergeMs=600、artifact TTL=120s、最多 8 项/512MB 空闲文件、只缓存不超过 64MB 文件的 base64；translation 专用后端留空并回退当前 chat 后端。

## 2026-07-20 跨模块复用边界审计（进行中）
- 初步索引确认：外部网络访问、超时控制、缓存和排队分散在工具、媒体 relay、文件处理和对话 app 中。已有共享层只覆盖消息媒体产物、消息管道队列/租约及 Modrinth；其余模块不能假定已受同一策略保护。
- 优先核验五类可能的公共边界：URL 下载与 QQ 临时链接刷新、受限 HTTP 请求、按 key 串行与并发限制、持久作业恢复、结构化工具结果到 QQ 发送。需要先对照具体实现，再判断是否应抽象。
- 已证实 QQ 临时图片链接刷新至少有四套实现：`fileUtils` 已有完整的 rkey 获取、appid 候选、图片签名校验与失败回退；`UploadFile` 仍保留未使用的同类内部函数；`GoogleImageEditTool` 与 `BananaTool` 分别复制 `getRKey/processImageUrl/isUrlAvailable`，只取固定 rkey 项且与公共实现的候选策略不一致。应让这些工具直接使用公共刷新和受限图片读取能力，避免同一图片在不同入口表现不同。
- 已证实 `MemoryManager.enqueueGroup()` 与 `ExpressionLearner.enqueueGroupUpdate()` 是同一个“按群 Promise 尾链、失败后续继续、空闲删除”算法；消息归档、最近消息和新消息管道则已使用 `KeyedSerialQueue`。这是低风险的直接复用点，前提是保留各自的业务重入规则，不改变任务调度时机。
- 图片生成 durable queue 与消息管道共享“按 scope/job 持久化、进程恢复、状态更新”的需求，但前者仍保存运行时 `e` 并自行扫描 Redis 队列；消息管道已用可序列化 envelope、租约和 Gateway。这里是高收益但高风险迁移，不应仅把两个类强行合并；应先抽稳定的 durable scoped-job contract，再迁移图片队列。
- 已证实外部 URL 安全策略没有共享：`excelFileContext.downloadExcelBuffer()` 会拒绝本机/内网 IP、逐跳重验重定向、限制 12MB/20 秒；`reliableImageSender.resolveImageBuffer()` 只校验 HTTP(S)、类型和 20MB，`fileUtils.downloadAndSaveFile()` 既无 SSRF 校验也无下载上限/超时，若干工具直接 axios/fetch。现有 `utils/request.js` 不能直接复用：它依赖全局 `ReplyError/logger`，无超时、字节上限或重定向安全语义。应从 Excel 的纯策略中抽独立 `safeRemoteResource`，再由图片/文件/JSON 调用方声明 MIME、大小和重定向策略。
- B站、抖音和 Modrinth 都各有“TTL + Promise single-flight + 失败逐出 + 有界 Map”的缓存实现；B站/抖音的 `metadataCache/pruneCache` 几乎同构，Modrinth client 也是同一模式。可新增无业务语义的 `BoundedTimedPromiseCache`，只共享并发、LRU/TTL 和失败剔除；缓存键、TTL、临时 URL 规则仍由各平台决定。
- 普通工具调用仍把成功、可恢复失败、终态动作和结构化数据压成字符串，再由 `apps/test.js` 以工具名和正则分支。Modrinth 已证明“结构化结果 + 确定性交付，模型仅处理必要文本”能消除格式漂移。下一层可定义 `ToolOutcome`（data/error/retryable/delivery），但这是横跨全部本地/MCP 工具的契约迁移，应从 Excel、Modrinth、媒体三个已结构化入口开始，不能一次性改全量工具。
- 合并转发/普通回复不宜直接共用一个高层 sender：媒体 outbox 用 `sendApi` 并要求严格 OneBot retcode；普通 `e.reply` 的成功返回在适配器间不等价，并承担引用、分段和打字节奏。可只复用 `sendApi` 的回执校验和附件准备，保留上层交互策略。

## 2026-07-20 视频搬运提速
- `MediaOutbox` 的 per-group `KeyedSerialQueue` 原本覆盖整个 delivery process，因此同一群的后续视频会等前一个视频完成下载、base64 编码和 OneBot 上传后才开始网络准备。
- 现在每个新 delivery 会进入单独的、默认并发 2 的预准备池。预准备复用已有 metadata single-flight 与 artifact store，并把 artifact lease 交给原顺序的 group process；最终 `send_group_forward_msg`、回执记录与失败重试仍完全按群独立。
- 预准备只活在进程内，持有最多 3 分钟；未消费、停止或过期会释放 lease。进程重启时 durable outbox 不依赖它，自动退回原有准备路径。
- B站 relay 之前使用 `tempFiles.length` 判断视频下载是否成功；artifact store 正常工作时文件位于 lease 而不是 tempFiles，导致额外“视频本体暂时获取失败”提示。现改为检查实际 video segment。

## 2026-07-21 B站番剧卡片本体失败续修
- 对 `b23.tv/0ATq5tk` 的短链探测确认最终跳转为 `/bangumi/play/ep1455179`，而旧提取器只接受 `BV...`，因此初始归档仅为卡片级，`bvid/cid/duration` 均为空。
- 初步兼容已把短链解析、season 元数据和 `ep_id` 持久化接入；真实后续日志已有 `refresh=507ms playback=93ms download=0ms`，说明番剧详情已取得，但播放资源数组仍为空。
- 当前 `requestBilibiliPlaybackResources()` 仍仅读取普通接口形状 `payload.data.durl`，即使实际番剧接口返回 `result.durl` 或业务 code/message 也会静默空数组；下一步必须以生产接口的脱敏结构验证，不得猜测。
- 生产直连实测 `ep1455179/cid=917377008`：season `code=0`，播放接口 `HTTP 200/code=0`、顶层含 `result`，且 `result.durl` 为 1、`data.durl` 为 0；错误根因为字段层级读取错误，不是版权、地区、登录、下载或 QQ 发送。
- 修复改为将播放结果保留为 `{ resources, failureReason }`：番剧取 `result.durl`、普通视频取 `data.durl`；仅在上游明确 code/message 命中登录、地区或版权时写出对应安全原因，其余只说明接口未提供资源。并修复短链 412 但已解析 `ep_id` 时不应抛错的条件。
- 生产磁盘逐文件回归 13/13。新版生产函数直接解析 `ep1455179` 返回 1 条最低清晰度资源，资源有 2 条备选且未输出任何临时地址；随后安全重启成功，服务 active、新 PID=853328、加载 34 插件、MessagePipeline 与 OneBotv11 已就绪。真实 QQ 发送尚待下一条用户分享验收。
- 用户在群 `609235590` 复测时，`ep411084` 的完整集时长为 1492 秒，但播放响应明确为 `is_preview=true`，唯一 `durl` 为约 360 秒；此前代码只检查 `durl` 存在，错误转发了试看片段。完整正片需要 B 站授予的有效播放身份，不能通过绕过该限制获取。
- 已改为试看片段不进入下载/发送：新版生产函数对同一集返回 `resourceCount=0` 和“仅提供约6:00试看资源，未附带不完整视频”。本地与生产定向回归均 14/14，安全重启后 PID=868618、服务 active、MessagePipeline/OneBotv11 已连接。

## 2026-07-20 Modrinth 可展示字段核对
- `/v2/search` 的单个 hit 除当前展示的名称、作者、下载、关注、标签和短简介外，直接返回：`icon_url`、`versions`（Minecraft 版本列表）、`latest_version`、`date_created/date_modified`、`license`、`client_side/server_side`、`featured_gallery/gallery`、`color`、`project_type` 与组织信息。当前 `buildModrinthRankingData()` 丢弃了这些字段。
- `/v2/project/{id}` 可补完整 Markdown `body`、精确的 `game_versions/loaders`、许可证对象、`published/updated/status`、源码/Issue/Wiki/Discord 链接、捐赠链接和图库。它是一项目一次额外请求，不适合默认对前五名逐个串行调用；应只在“展开第 N 个/看详情”时请求，或对并发做限制。
- 排名默认节点建议额外展示：图标、支持的 Minecraft 版本范围、加载器、客户端/服务端需求、最近更新日期、许可证；源码/Discord/Issue 仅在存在时以一行链接展示。完整正文、图库和 donation 不应默认塞进排行榜转发，避免节点过长与额外 API 延迟。

## 2026-07-20 Modrinth 排名 HTML 卡面
- 默认排名发送不再依赖模型的字段排版：`buildModrinthRankingData()` 保留搜索接口的图标、全量版本、两端需求、创建/更新时间与许可证，`buildModrinthCardItemsFromData()` 将其与已验证的简介译文确定性组装为一项目一卡面。
- 每个合并转发节点的 message 是 `[HTML 卡面图片, 项目页 URL 文本]`；URL 不进入模板，保持 QQ 可点击。卡面渲染失败会用同一数据完整文本降级，再追加 URL。
- 卡面使用项目已有的 TRSS renderer template 机制。独立 Node 无法完整模拟 renderer 所需的 `logger/redis` 全局，最终视觉验收应在正常服务启动后由真实 Modrinth 请求完成。

## 2026-07-21 B站会员高清搬运
- 当前二维码管理器已实现官方生成/轮询接口，并把成功授权收敛为 `SESSDATA`、`bili_jct`、`DedeUserID` 的本地 Cookie；`86101` 已正确视为等待扫码，`86038` 才视为过期。
- 高质量 Cookie 尚未接进播放解析或下载：`buildBilibiliArchiveRelaySegments()` 仅传 `quality`，下载也没有 Cookie header；自动搬运因而仍然匿名。
- 未完成补丁把 `options.authCookie` 写入 `requestBilibiliMetadata(card, { fetchImpl, timeoutMs })`，其中 `options` 不在作用域。该错误必须移除，授权 Cookie 只允许进入显式高清链路。

## 2026-07-21 自定义骰娘规则包 V1
- 现有 `DicePlugin` 在构造时复制冻结的 `DICE_COMMAND_RULES`；新增规则不能逐条动态注册，适合增加低优先级统一前缀入口，运行时按当前群活动包解析。
- 现有 `DiceManager` 已有安全骰子表达式解析和串行原子 `state.json` 写入，可复用骰点限制与人物卡身份；规则包版本仓库应独立放在 `data/dice/rules`。
- `yaml` 为现有可选依赖；导入规则包必须在解析器不可用时明确失败，不能使用当前轻量配置回退解析器解析复杂规则。
- 教程定义的公式能力需要独立 lexer/parser/AST，不能扩展为字符串替换后交给 JavaScript。
- 本地同时可加载 `yaml` 与 `js-yaml`；实现会优先使用 `yaml.parse`，再兼容 `js-yaml.load`，而不是依赖轻量配置回退器。
- 规则导出可复用现有 `e.group.sendFile`；管理权限按主人、群主/管理员分级，导入/确认/删除和全局回滚仅主人可用。
- `resolveGroupContextAssets()` 已能取得当前与引用消息中的文件资产；规则导入只需补 YAML 扩展名、QQ file_id URL 解析、64 KiB 限额和超时读取。
- 收尾审计确认核心定向回归当前为 16/16，语法检查通过。仍需补齐版本文件内容哈希，否则“不可变版本”只能防 schema 损坏，不能防同样合法的磁盘篡改。
- 教程存在可能超前于 V1 的描述，重点核对 `persistent: false`、私聊启用、迁移预览、默认导出活动版本和彻底删除人物卡数据；最终文档只保留当前代码实际兑现的契约。
# 2026-07-22 自定义骰娘 V2 初始范围
- 用户明确拒绝 Agent/Skill 化：跑团命令属于严格交互，应继续只由固定语序触发。
- 本轮要求同时完成多角色/目标/权限与真正团务系统，并修复上一轮审计发现的实现缺陷。
- V1 当前运行时只读取发言者当前人物卡，规则管理权限仅覆盖导入/启停等管理面；命令本身没有角色权限或目标授权。
- V1 自定义规则未消费现有 `.log`、暗骰、先攻等核心骰娘能力；需先复用现有契约，再设计 V2 schema，避免形成第二套互不兼容系统。
- `DiceManager` 已有群级 log JSONL、私聊暗骰、COC 对抗和先攻列表，但输出大多是字符串；V2 需要新增结构化记录入口，而不是解析这些字符串。
- `DiceManager` 的用户状态以 QQ 为 key、当前人物卡为 `activeCard`；可通过合成目标事件安全复用 `ensureUser()`，但跨用户写入前必须先解析目标并检查命令权限。
- `DiceRulePackManager.executeCommand()` 当前一次只复制当前人物卡的 `attr`，在成功后整份 `writeState()`；适合扩展为事务内的 actor/targets/group/session 草稿，全部校验后一次提交。
- 现有全局 `runtimeChain` 会把所有群串行；V2 应至少改为按 `groupId` 分区的队列，同群内保证人物卡与团务状态写入顺序。
- V2 兼容方向：V1 默认 `permission: player`、`target: self`、`visibility: public`；新增行为只有规则包明确声明后才开放。
- `DiceExpressionParser` 当前标准骰直接使用全局 `Math.random()`；V2 可向解析器注入 invocation 级随机函数，使标准骰与自定义骰共享同一可审计种子，同时保持旧调用默认行为。
- 结构化审计不能把暗骰明文直接追加到现有可导出的普通 log；完整审计保存在群规则会话状态且只由 GM+ 固定命令读取，log 对私密结果仅记录公开占位和可关联的 audit id。
- V2 群规则状态拟采用 `groups[groupId].diceRuleSessions[packId]`，包含 roles、NPC、共享字段、session/combat、audit；玩家规则数据继续放在现有人物卡 `ruleData[pack.id]`，只追加 statuses/inventory 等兼容字段。
- 项目已有 `utils/messagePipeline/keyedSerialQueue.js`，API 为 `run(key, work)`；自定义规则可直接按 groupId 分区，避免继续维护全局 `runtimeChain`。
- QQ 群成员表通过 `e.group.getMemberMap()` 返回 Map，成员包含 card/nickname/role；固定目标解析可支持 CQ @、qq:ID、npc:ID 和精确群名片，不需要自然语言模型。
- pending 垃圾回收不能在 `mutateIndex()` 的 mutator 内先删文件；索引原子写若随后失败会留下仍指向已删除文件的旧索引。正确顺序是 mutator 只收集清理对象并更新内存索引，索引写成功返回后再删旧 pending 文件。
- 规则包缓存使用版本哈希和两个文件的 size/mtime 指纹，命中时跳过 YAML/JSON 重读与双校验；文件变化会失效并重新做完整哈希验证。
- 自定义规则运行和规则索引写入现已分别使用按群/索引 lock file，补足多进程部署下单进程 Promise 队列无法互斥的问题。
- 规则运行时版本改为 `2.0` 后，现有 V1/V2 定向回归仍为 29/29；教程三份 V1 示例均能完整执行，因此 V2 可继续通过可选区块保持向后兼容。
- 当前教程仍标为 V1，并错误声称所有内部 ID 都不能使用 `arg/target/status` 等名称；实际引用始终经过 `arg.target`、`attr.status` 等命名空间，应该修正文档而不是增加会破坏 V1 示例的 schema 禁止。
- 仅按群锁自定义命令仍不足以保护 `state.json`：两个群可同时修改同一人物卡，而且任何不同群写入都会整文件覆盖。生产路径必须在分片存储前共用全局状态事务锁；群锁只用于保持群内命令顺序。
- `secret: true` 原本只在通用卡面/查询隐藏，自定义玩家命令仍能通过模板或派生字段泄露，通用设/删也能改写。现已在 schema 做秘密依赖传播和命令权限校验，并在运行时再次保护通用修改与秘密资源能力。
- 归档和恢复原本在索引原子写之前移动目录；索引写失败会使目录与旧索引相反。现已增加失败补偿，恢复清单只在索引提交成功后删除，原子写临时文件在失败时清理。
- 2026-07-23 线上 `.表达学习 总结` 不是接口失联：同配置探针返回 HTTP 200，`finish_reason=length`，900 个 completion token 全部计为 reasoning token，`message.content` 为空；错误包装丢失了 finish reason 和 usage。
- 同日生产日志已有空 content 与 JSON 字符串中途终止两类结果，均需要在不落库前提下缩短输入并提高 completion 预算重试；`reasoning_content` 不是规则输出，不能拿来解析或回显。
- 自动总结失败当前不更新任何失败时间，`shouldAutoSummarize()` 会在下一条消息再次满足条件，造成连续昂贵调用；需要独立于成功冷却的失败退避。
- 修复参数的生产只读探针使用同一 URL、模型、脱敏样本和提示：2400 token 首次请求即 `finish_reason=stop`，reasoning 1004、completion 1735，最终 JSON 1636 字符且严格可解析；没有触发 6000 token 重试。
- 生图尺寸链首查：`imageGenerationFallback` 将 provider 配置的 size 标准化后，`BananaTool.buildImageGenerationPayload()` 每次直接发送；线上两个 `gpt-image-2` provider 均固定 `1024x1024`，因此提示词中的 9:16 无法改变 API 画布。
- `bananaTool` schema 没有 aspectRatio/size 意图字段；prompt compiler 保留原文但不会把比例结构化。编辑 multipart 没有对参考图 resize/crop，固定输出画布才是当前比例冲突入口。
- `parseImageGenerationResponse()` 只返回 URL/base64 字符串，未携带请求 size 或实际宽高；可靠发送层也就无法记录实际产物尺寸。
- 比例修复采用两层输入：Agent 可填写 `aspectRatio`，执行层仍从原始消息/完整 prompt 识别，避免 forced tool call 或模型漏参时重新落回 provider 默认正方形。
- 每个生成/编辑候选都在 fallback 前独立解析尺寸；GPT Image 使用已知三档，其他 provider 可配 `squareSize/portraitSize/landscapeSize/autoSize`。无法映射的冲突 WxH 被省略，`2K/4K/auto` 等不携带方向的分辨率标记保留。
- 图生图无明确比例时，generation provider 推导出的 edit candidate 不再继承 `1024x1024`；只有 edit 配置自己声明的默认尺寸或 auto 才会发送 size。
- `reliableImageSender` 现在可从最终 Buffer 读取真实 width/height/format；BananaTool 在发送前记录实际尺寸，不把请求档位当作产物尺寸。
- 2026-07-24 线上复核确认服务仍运行 2026-07-23 20:51 启动的 PID 1651465；生产 `BananaTool.js` 仍无比例解析导入，`utils/imageAspectRatio.js` 不存在，请求 payload 继续直接发送 provider 的 `size: 1024x1024`。因此“还是默认 1024”是未部署，不是比例识别再次失效。
- 2026-07-23 17:36:58 群 609235590 的真实工具调用参数包含 `provider: gemini`，但用户原话只有“去掉这个图手里的手机”；工具在 55ms 内被本地渠道校验拒绝，未调用图片 API。
- 同时核对线上配置：当前编辑模型为 `gpt-image-2`，生成 provider 只有 `krill-image-2` 和 `gpt-image-2`，不存在 Gemini 配置。
- `GoogleImageEditTool.description` 仍写“使用Google Gemini”，而语义工具决策可直接返回任意 `decision.params`；共享 `resolveRequestedImageProvider()` 又无条件优先信任非空 explicitProvider，三者组合使工具说明中的厂商名可被模型抄成伪造的用户选择。
- 修复边界放在共享 `resolveRequestedImageProvider()`：显式参数只作候选，必须由用户文本中的选择动词和同一别名证明；证明失败后继续从用户文本解析真实渠道，而不是直接返回空或相信模型。
- GoogleImageEditTool 与 BananaTool 都在参数规范化和实际执行入口复核；有真实事件文本时禁止用模型 prompt 反向证明 provider，只有持久任务恢复缺失事件文本时才使用已经落库的用户原话 prompt。
- 2026-07-23 18:58 的最新识图请求已经成功取得一张 1830x324、28 KB 的 PNG；QQ 下载约 0.13 秒，旧 VLM 请求在 25.97 秒后超时，因此“没收到图片”和“大图下载慢”都不是第一失败。
- 排查期间线上 `analysisAiConfig.analysisApiUrl` 于 19:02 热更新为 OpenAI SDK base URL `https://api.krill-ai.com/codex/v1`。GoogleAnalysisTool 原样 POST 该路径会空 404；补全为 `/codex/v1/chat/completions` 后，同一 SK、模型、真实图片与提示 5.16 秒 HTTP 200，证明密钥和模型可用。
- `utils/chatCompletionUrl.js` 已是主对话等模块共享的 base URL 规范化边界；识图应复用它，不能要求用户记住每个调用方到底接受 base URL 还是最终 endpoint。
- 图片不可用回复硬编码了 Steam，实际 Minecraft 请求也会串题；失败文案只能描述可验证的下载、授权、限流、HTTP 或超时类别，不能嵌入某个历史话题。
- 固定进度句“我还在查，结果出来就发。”仅来自 SearchInformationTool 的 2.5 秒计时器；它绕过主回复模型与 persona，直接 `e.reply`，所以天然与当前问题割裂。
- 合理边界是共享的非阻塞进度生成器：输入只包含当前请求、任务类型和真实阶段；工具规划模型已有自然句时直接复用，否则使用可配置 progress 紧凑后端，搜索完成则通过 AbortSignal 取消迟到回复。
- 进度输出必须拒绝“已查到/结果是/百分比”等无证据状态，也要拒绝原固定模板和客服腔；模型失败时保持静默，且不能延长主工具请求。
- 用户要求进度句必须由模型结合当前话题产生，因此固定兜底同样不合格；最终策略是模型无可用输出时保持静默，等待工具最终结果。
- 真实模型会用“别急”或“列表还没刷全”等表面自然的尾句，前者在用户未催促时像反向教训，后者暗示无证据的部分完成；两类都需要输出守卫触发同预算内重写。
- 当前线上 fast tracking 配置的真实生成约为 2-3 秒；搜索结果先完成时会 abort 生成并禁止迟到发送，生成慢不会延长搜索本身。
- GoogleAnalysisTool 的“收到，我看一下。”“嗯嗯，我先看看这张图。”“我看一下哦，等我盯两眼。”“收到收到，我先帮你看看。”全部是本地随机固定句；它们绕过人格模型，因此会重复且无法回应用户真正要看的对象。
- 图片工具当前在下载图片之前串行 `await sendProgress(e)`；动态接话必须启动后立即脱离关键路径，并由工具完成时的 AbortSignal 取消，不能为了自然话术再增加 2-3 秒识图延迟。
- 图片 URL 规范化和下载方法本身不支持测试级依赖注入；本轮把接话生成与发送做成可注入边界单测，完整 `func()` 并发/取消行为需在服务器真实依赖临时副本补验。
- 仅靠提示词不足以守住“识图前不能猜图”：真实模型把“Steam 老是这样”扩写成了“报错的那几行提示”。需要按图片任务启用上下文事实守卫，对用户原话未出现的具体视觉元素拒绝并重写。
- 四次未过滤原始探针中，模糊 Steam 请求 2/2 擅自增加报错/提示；明确错误码请求一条增加“字小”，一条只围绕错误码行动且可通过。说明守卫方向正确，提示还需给出“模糊对象不得具象化”的正反例。
- 视觉事实词不能使用裸“字”做匹配，否则用户说“名字”会错误授权模型声称图中文字很小；已收紧为“文字/字体/字样/字符/字有点”等具体视觉表达。
- 生产部署只需 SearchInformationTool、GoogleAnalysisTool、contextualProgressReply 和 Guoba aiCore schema；线上已有 chatCompletionUrl/unicodeText，现有配置可直接复用 track 模型，无需覆盖混有其他未发布改动的默认配置。
- 生产目标测试可把 staging 中的测试文件临时复制到生产 `tests/.deploy-*`，使相对 import 直接指向生产模块；用 `--test-force-exit` 处理 TRSS 宿主后台句柄，跑完立即删除，最终 15/15。

## 2026-07-24 文生图上下文污染隔离
- 初步入口审计显示文生图至少有当前请求强制路由、上下文衔接绘图、语义工具决策三条路径；`buildImageGenerationPrompt()`、`buildToolCallFromDecision()` 和 contextual draw 分支都可影响 BananaTool 最终 `prompt`，其中部分调用显式传入 `groupUserMessages`。
- `compileImagePrompt()` 已有正确的基础策略：当前绘图描述足够明确且没有指代词时，忽略 `recentContext`；只有“继续/刚才/这个”等明确承接信号时才附加近期原文。已有单测也覆盖了明确新画猫时不得混入此前赛博少女。
- 语义规划器的直接 `toolName=bananaTool` 分支确实会先信任 `params.prompt`，但正常执行到 `runToolCall()` 时还会调用 `buildImageGenerationPrompt()`，并优先使用 `session.rawArgs`/当前消息重新编译；因此它是需要防御的入口，但不是正常路径的第一根因。
- 次要风险是 `buildImageGenerationPrompt()` 用包含 `userContent` 的 `referenceText` 判断 `hasContextualReference`；该字段可能含引用/转发格式化内容，判断应以当前意图和显式引用为主，不能让宽上下文本身反向授权继续注入近期历史。
- 已确认第一根因在连续消息合并：`buildImageGenerationPrompt()` 只要看到 `e._mergedOriginalTexts` 就无条件 `join("\n")` 并让它压过当前 `args/msg/prompt`。该数组只保证“同一用户在短窗口内连续发送”，没有证明每条都属于同一个绘图目标；相关补充和无关插话因此都会一起进入“用户原话”。
- 普通显式生图执行前没有把 `session.groupUserMessages` 再传给 `buildImageGenerationPrompt()`，所以明确新请求通常不会直接携带整段群历史；应优先修复合并边界，再用执行层的当前请求锚定防住模型参数。
- 直接触发合并比工具请求合并更早：同一用户在约 1 秒内连续两次点名/前缀触发，会先被 `buildMergedDirectTriggerEvent()` 合成一个事件；后续工具层因 `_directTriggerMerged` 不再拆分。该机制不区分“继续补充画面”和“紧接着问了另一件事”。
- 修复不能简单禁用合并：`希洛画一只猫` 后紧接 `换成下午、橘色光` 是合理的同轮补充。需要在最终生图 prompt 边界选择与最近绘图锚点相关的合并片段，并把明显独立的新请求视为边界；同时保留显式“这个/上面/刚才”对前文的授权。
- 已实现三态上下文边界：有明确引用时只使用引用；明确说“把上面的聊天/内容/设定画出来”时允许普通近期原文；“继续上一张/同风格”只使用最近一个绘图线程；普通完整绘图请求不读取历史。
- 连续合并消息现在以最后一条明确绘图请求为锚点，保留下午、比例、颜色、姿势等画面补充，排除后续独立问题；只有锚点明确说按上文/设定绘制时才保留锚点之前的原文。
- 最近绘图上下文从“最后六条绘图相关文本”收紧为“最后一个明确绘图请求及其后最多两条承诺”，避免短时间先画黑猫、后画白狗时继续请求混合两次任务。
- 生产 `apps/test.js` 与本地的 89 行差异全部属于本轮四处精确改动（导入、旧宽泛常量移除、最近绘图线程、生成/编辑上下文模式），没有夹带其他未部署业务；`promptCompiler.js` 的 65 行差异也全部是本轮纯策略函数。
- 生产真实宿主测试证明最终 prompt：保留合并消息里的“下午、9:16”，排除紧接的“明天开会吗”；“继续上一张”只含最新白狗线程而不含更早黑猫/火锅；明确画聊天内容时保留对话；明确引用时不再附带普通群历史。

## 2026-07-24 骰娘完整性审计
- 当前骰娘代码分为固定命令层 `apps/DicePlugin.js` + `utils/DiceManager.js`，以及自定义规则/团务层 `DiceRulePackManager`、`DiceRuleSchema`、`DiceRuleExpression`、`DiceRuleSession`；另有日志记录器、锅巴配置、4 份示例和独立教程。
- 用户明确保留“固定语序触发”作为跑团边界，本轮不会把缺少自然语言 Agent 路由列为问题。
- 固定命令入口由 `DICE_COMMAND_RULES` 统一注册，支持英文句点/中文句号和中文参数紧贴；拉丁参数只有已列出的紧凑子命令可以无空格跟随，以避免 `.rabc` 一类误吞。自定义规则另由兜底 `^[.。][\\s\\S]+$` 接管，且仅在 `customRulesEnabled` 开启后处理。
- 插件层公开了固定骰点、COC/DND、检定/暗骰/对抗、先攻、团录、人物卡、昵称、群开关及自定义规则包管理；旧骰娘的状态写命令包在 `diceManager.withStateTransaction()` 中，自定义规则动态命令则进入 `DiceRulePackManager` 自己的运行时事务。
- 规则包管理权限目前分三档：导入/确认/回滚/归档/恢复仅主人，列表/预览/查看/启用/禁用/导出允许主人或本群管理员，包内团务动作再由规则定义的权限判断。需要继续确认私聊缺少 `group_id` 时的行为和三套权限语义是否一致。
- 动态规则的私密结果由插件逐个私聊发送，失败时仍在原会话回复并公开失败接收者 QQ；这能避免静默丢结果，但可能泄露接收者标识，也没有重试/替代交付机制，后续列入权限与隐私审计。
- **高影响：`diceSystem.enabled` 不是模块总开关。** `handleRoll`、奖励/惩罚骰、COC 检定、对抗和 log 开启会检查它，但 `.coc/.dnd/.st/.pc/.nn/.set/.setcoc/.init` 等大量入口仍会正常执行甚至写数据；插件注册层也没有统一拦截。因此后台显示“骰娘关闭”时，用户仍能使用和修改骰娘。
- **高影响：两个公开控制命令是无效状态。** `.reply off` 会写 `groups[groupId].replyEnabled=false`，代码库内没有读取该字段来阻止任何回复；`.pc lock` 会写 `user.locked=true`，但 `.st`、`.pc del/use/new` 等路径没有检查 `locked`。两者都向用户回复“已关闭/已锁定”，属于可验证的假成功。
- **高影响：固定团务状态几乎没有权限边界。** 任意群成员都可以 `.log on/off/end`、`.set`、`.setcoc`、`.init clear/del/覆盖同名项`；没有群主、管理员、KP/GM 或创建者校验。一次误操作即可中止团录、改房规或清空先攻。
- 固定人物数据按 QQ 全局存放，而不是按群或团隔离；昵称、当前人物卡、DND Buff/法术位/死亡豁免会跨群共享。DND 运行状态还挂在用户而不是人物卡上，所以同一用户切换角色后仍继承上一角色的 Buff、法术位和死亡豁免。
- 固定先攻的 `.ri` 只返回一次掷骰结果，不会写入 `.init` 列表；用户必须手工复制结果再发 `.init 名字 数值`。列表也没有回合推进、当前行动者、同值排序规则、临时项或历史恢复，属于“数值列表”而非完整先攻流程。
- 固定 DND 工具明显是兼容骨架：`.longrest` 只清死亡豁免、不恢复已记录法术位；Buff 只有追加/全部清空，无单项删除、层数、持续时间或角色隔离；`.sn`、`.send`、`.bot` 明确只返回兼容提示，不执行对应功能。
- `.en` 成长检定成功时会掷出成长值并显示“增加 N”，但不会把 N 写回人物卡技能；用户看到的是已计算但未落卡的结果。该入口也没有事务包装，不具备未来补写时的并发保护。
- 固定 log 只在 `state.groups[group].log` 保存当前一条指针；开启新 log 会覆盖上一条元数据，旧 JSONL 文件虽然还在磁盘，却没有列表、选择或再次导出的用户入口。任何成员也能导出包含 QQ 号和完整群消息的记录，需要权限与隐私告知。
- `readState()` 遇到 JSON 损坏会直接退化为空状态；随后的任意写命令可能把空状态原子覆盖回 `state.json`。当前只有写临时文件+rename，没有版本备份、损坏隔离或恢复入口，单文件全量状态也是数据规模和锁竞争的长期瓶颈。
- 固定命令没有统一的用户错误边界。`.r`、`.sc` 等路径会让表达式解析异常直接抛到插件框架，只有 `.rav` 和规则包管理自行捕获；因此非法骰式、损失表达式等输入可能变成无回复或框架级错误，而不是固定语法提示。
- 暗骰在模块关闭时仍可进入：`handleHiddenCheck()` 只检查 `allowHiddenRoll`，然后把内部 `handleRoll/handleCheck` 返回的“骰娘模块现在没开”作为暗骰结果私聊，并在群内宣称“进行了一次暗骰”。这进一步证明 `enabled` 必须在统一入口拦截。
- COC SAN 每日累计用 `new Date().toISOString()` 的 UTC 日期分桶，在 Asia/Shanghai 会于每天 08:00 切日；不定疯狂阈值还按每次检定前的当前 SAN 重新计算，而不是固定保留当日基准 SAN，连续掉 SAN 时阈值会缩小并可能过早提示。
- `.ww` 只统计 `>= 难度` 的 D10 个数，没有规则版本、1 抵消或 10 的附加判定；`.dx` 只显示最高骰和达到临界值的骰数，不执行 Double Cross 的递归暴击链。帮助称其为“其它规则基础骰”，但输出名称会让用户误以为已按完整规则结算，应明确实验/简化语义或实现具体版本。
- 现有命令路由测试主要验证“某段文本会分发给哪个 handler”，没有覆盖 handler 的总开关、权限、锁定、跨群隔离、错误回复或规则正确性；固定骰娘主体当前没有对应的业务回归文件。
- 自定义规则运行时的命令执行使用“群级串行队列 + 群级文件锁 + 全局 `state.json` 事务锁”，参数、权限、动作、模板和可见性校验完成后才提交人物卡/群状态；相较固定骰娘，失败不落部分状态的设计是成立的。
- **高影响：私密规则命令不是交付事务。** `executeCommand()` 会先提交人物卡、资源消耗和审计，再把 `privateMessages` 交回插件逐个发送；QQ 私聊失败只在群内追加失败 QQ，不回滚状态、不保留可重试密文投递任务。暗骰、秘密资源技能等可能“已消耗、已记录，但授权接收者无人看到结果”。
- `diceSystem.enabled` 同样没有覆盖自定义规则：插件仅以 `customRulesEnabled` 决定是否执行 catch-all 动态入口。因此会出现主模块关闭、规则包仍在改人物卡和团务状态的配置组合。
- V2 的公开失败文案固定为“人物卡没有发生不完整写入”，但规则命令也可能修改 NPC、群字段、会话、先攻、状态、物品和能力；事实边界基本正确，措辞却把完整事务缩窄成“人物卡”，用户无法判断其他团务状态是否也已回滚。
- 规则人物卡仍复用固定骰娘的全局 QQ -> 当前人物卡存储，`card.ruleData[pack.id]` 不含群/团 ID；同一个包在多个群启用时，同一用户的该包人物数据会跨群共享。群共享字段、GM、NPC、会话和先攻按群隔离，但玩家角色数据没有，隔离模型不一致且教程未在操作入口醒目说明。
- 每条未知点命令都会落入自定义规则 catch-all，再同步读取规则索引并检查当前群启用包；有包时还会校验文件指纹。缓存减少 YAML 解析，但 `index.json` 没有内存快照，活跃群的所有点命令都会增加同步磁盘读取和与其他插件抢占的开销。
- **严重：V2 `secret` 字段的内置查看/设置会公开泄密。** `卡/查/设` 只校验调用者是否为 GM，但 handler 返回含秘密字段值的普通文本，插件随后在原群公开回复；`群卡/群查/群设` 同理。也就是说“只有 GM 能点命令”不等于“只有 GM 能看到结果”，与教程的秘密字段承诺直接冲突。
- **严重：离群 GM 可能继续收到秘密结果。** `getRuleGmRecipients()` 先无条件收集 `ruleState.roles` 中所有显式 GM，再并入当前成员表的群主/管理员；没有用成员表过滤已离群、被踢或长期失效的显式 GM，也没有角色过期/清理机制。
- 显式 `qq:号码` 目标即使不在当前群成员表中也会被当作 member 接受；GM 可由此读取或修改任意 QQ 对应的全局人物卡。结合玩家规则数据跨群共享，这使“当前群团务”能够越过群成员边界触达其他群/历史用户数据。
- V2 内置命令的审计覆盖不完整：自定义命令和部分生命周期动作会写结构化 audit，但手工卡/群字段设置、GM 角色分配、NPC 创建删除、先攻直接添加删除清空等路径多为直接 `writeState()`，没有统一审计记录。管理员无法从 `.规则 审计` 还原关键团务变更。
- **高影响：团务会话与 log 不是一个原子事务。** `团务 开始/结束` 先通过 `finishBuiltinMutation()` 把会话和事件动作写盘，再单独调用 `startLog/stopLog`；第二步失败时，外层 catch 虽声称没有不完整写入，磁盘上其实已留下半完成会话。session_start 结构化事件还发生在 log 开启前，因此不会进入新团录。
- 团务没有记录“这条 log 是否由本会话创建”。如果群里本来已有手工 log，`团务 开始` 会直接复用并宣称“团录已开启”，而 `团务 结束` 会无条件停止这条原有 log；会话越权接管了独立团录的生命周期。
- `先攻 开始` 在没有正式团务时会静默把 `session.active=true`，但不运行 `session_start`、不开 log；随后 `.规则 团务 开始` 会因“团务已经开始”被拒绝。这与教程“正式团务应先执行团务开始”的工作流冲突，用户没有明显恢复路径。
- 已在战斗推进中再次执行 `先攻 开始` 没有状态保护，会重置到第 1 轮第 1 位，并再次执行 `round_start/turn_start`、冷却和状态 tick；一次重复命令可能重复扣血、恢复资源或缩短持续时间。战斗中删除当前行动者也只把 `current` 清空，下一回合直接变成“战斗尚未开始”。
- 新建团务会重置标题/轮回/当前行动者，但保留上一场的先攻列表；结束团务也保留先攻和角色持续状态。是否延续没有显式选项或提示，容易把上一场残留带入新团。
- `secret` 的泄露不是只存在于内置卡命令：schema 对引用秘密字段的自定义命令只要求 `permission >= gm`，没有要求 `visibility=private/gm`。因此规则作者可合法导入“GM 才能触发、但 output 在群里公开”的秘密命令；当前安全模型混淆了调用权限和受众可见性。
- 教程称“每次自定义规则执行和团务固定命令都会生成审计 ID”，实际与实现不符：测试只断言生命周期路径 audit 数量增长，没有覆盖卡/群字段、角色、NPC、先攻编辑；这些直接写盘路径确实没有 `appendRuleAudit()`。文档让管理员对审计完整性产生过高信任。
- V2 测试覆盖了原子动作、无私密接收者不提交、并发、锁与归档回滚，但没有覆盖：秘密内置回复受众、公开 secret 自定义输出、离群 GM、私聊发送失败后的投递恢复、重复先攻开始、既有 log 所有权或 session/log 第二阶段失败。
- **高影响：规则包“回滚”不等于数据回滚。** `rollbackForGroup()` 只切换启用版本；人物卡在下次访问时调用 `applyMigration()`。如果没有一条 `from == 当前版本` 的直达迁移，代码会静默不迁移却仍把 `_packageVersion` 改成目标版本；既不支持多跳迁移，也没有反向迁移要求或失败保护。
- 启用新规则版本不会预检现有人物卡。旧持久值不会按新 schema 统一校验，已删除字段也继续残留；类型、范围、枚举不兼容通常要等某位玩家实际执行命令时才暴露。群共享字段没有 `rename_fields/add_defaults` 迁移机制，只有按新定义补默认值。
- 规则版本字符串只做普通字符串长度检查，运行时最低版本比较和迁移来源没有强制语义版本格式；包作者写入不规范版本时，兼容判断与迁移匹配都容易产生难以诊断的行为。
- 锅巴配置面目前只有总开关、自定义规则开关、骰数上限、暗骰开关、数据目录和基础回复模板；没有数据健康/备份恢复、状态作用域策略、团务权限策略、时区、审计保留/导出、投递失败队列或规则包运行状态面板。维护者只能靠文件和命令排障。
- 本地临时目录行为探针已复现四个关键问题：`.pc lock` 回复锁定后 `.st STR=66` 仍成功；`enabled:false` 时 `.st show` 仍返回卡；公开输出 secret 的 GM 命令通过 schema 且 0 errors；从 `2.0.0` 切到无迁移的 `1.0.0` 时直接改 `_packageVersion` 并保留未解释的 legacy 字段。
- 三组现有定向回归共 34/34 通过，说明当前实现与既有测试一致；这些缺口不是随机测试失败，而是测试契约尚未覆盖或明确接受了不完整行为。
- 线上只读核对（2026-07-24）：`diceSystem.enabled=true`、`customRulesEnabled=true`、暗骰与 log 静默均开启；状态文件约 1190 bytes，含 1 位用户和 2 个群，当前 0 个 active log。服务为 active/running。
- 线上目前规则包 0、启用规则包的群 0、规则会话和审计均 0，因此 V2 风险是已部署实现中的潜在问题，尚不能从生产使用量判断实际发生频率；固定骰娘缺口则已具备真实状态数据基础。
- **生产已出现 log 文件发送失败。** 日志为 `[骰娘] log 文件发送失败: 识别URL失败, uri=/opt/.../exports/...txt`；当前 `exportLog()` 直接把本地绝对路径传给 `e.group.sendFile`，失败后只返回最多 4500 字正文。长团录会截断，用户也拿不到真正的导出文件。
- 生产日志还出现过一次 YAML `Map keys must be unique` 导致骰娘配置读取失败；当前配置块已经可读且键唯一，但 `getConfig()` 失败时会静默采用全部默认值，后台配置错误可能让开关/上限/数据目录与维护者预期不一致，只有日志告警没有管理面健康提示。
- 生产 8 个骰娘核心文件与本地 SHA-256 全部一致，本轮静态与探针结论适用于当前运行代码，不是本地/线上版本差异。
- **既有需求未实现：按骰点自动改用户群名片。** `.sn on` 只返回“当前未启用”，不保存开关、不申请/验证群管理权限、不执行改名；`.nn` 只改骰娘内部显示名。教程也明确 YAML 规则不能修改 QQ 群名片，因此当前没有任何规则结果 -> 群名片模板 -> 权限校验 -> 恢复原名的链路。
- V2 “技能/法术”目前是账本，不是效果系统：ability schema 只有等级、冷却、资源字段/消耗；`使用` 只扣资源、设冷却和累加次数，没有 `on_use/actions`、参数、目标、骰点或输出模板。规则作者必须另写自定义命令模拟技能效果，两处状态也没有原生绑定。
- 物品同样只有数量、装备槽和装备状态，没有使用/消耗动作、耐久、容器、转移或 `on_equip/on_use`；NPC 只有名称加通用人物卡，没有阵营、归属、可见性或模板实例化。它们足够做演示状态，却不足以支撑长期团务内容管理。
- 当前“团务”只有一个 `群 + 规则包` 的可变 session：无团/战役实体、玩家名单与角色登记、章节/场景、线索/手记/附件、暂停恢复、历史场次列表、快照/撤销、结构化导出。现状更准确的定位是“单场会话与战斗回合状态机”。
- 自定义骰表达式最终只暴露数值总和与可读 trace，没有骰面数组、成功数/失败数、爆骰/重掷/抵消/配对等可组合原语；许多 WoD、DX、骰池或符号骰规则无法仅靠现有 YAML 精确表达，这也解释了固定 `.ww/.dx` 只能做简化版。

### 功能矩阵结论

| 面向用户的能力 | 代码存在 | 当前可达 | 完整性判断 |
| --- | --- | --- | --- |
| 固定骰式、COC 检定、暗骰、SAN | 是 | 线上已开启 | 基础可用；总开关、错误边界、SAN 日界/阈值需修 |
| 人物卡、多卡、内部昵称 | 是 | 线上可用 | lock 无效、全局跨群、无导入导出/历史/恢复 |
| DND 与其它规则 | 部分 | 线上可用 | 主要是简化骰与资源账本，不是完整规则实现 |
| 固定先攻与 log | 是 | 线上可用 | 无权限、流程割裂、历史不可达；log 文件发送已在线上失败 |
| YAML 规则包与表达式 | 是 | 线上开启但 0 个包 | 语法/事务基础较强；骰池原语、迁移和可见性模型不足 |
| V2 角色、NPC、群状态、状态、物品、技能 | 是 | 有固定入口但线上暂无包 | 多数为状态账本；secret、离群 GM、跨群人物数据有安全问题 |
| 团务、先攻生命周期、审计 | 部分 | 有固定入口但线上暂无包 | 单场状态机可用；log 非原子、重复推进、审计缺口、无战役历史 |
| 运维与恢复 | 部分 | 仅锅巴基础配置/磁盘文件 | 无健康面、备份恢复、投递重试、数据迁移预检与结构化导出 |

## 2026-07-24 “樊思睿是谁”回答失败诊断
- 用户看到的“你的问题我完整收到了，但回答服务这次请求失败……”来自 `utils/chatFailureReply.js` 的默认 unknown 分支，不是模型生成的人设回复，也不能说明失败发生在成员资料或记忆查询。
- 该兜底已有 rate limit、timeout、unavailable 三种专门文案；落到默认句意味着上层传入的错误未被现有分类器识别，必须从生产日志还原原始异常。
- 主对话已有专门的群成员名称解析：`extractMemberLookupTerms()` 支持“X 是谁/谁是 X/资料/头像”等问法，`matchGroupMembersByTerms()` 会匹配群名片和昵称，并注入 QQ、群身份、头衔、头像链接等可证明字段；“樊思睿是谁”属于已支持语法。
- 即使成员表没有匹配结果，正常路径也应让模型如实说明当前证据不足；成员查无结果本身不会调用 `buildGenericChatFailureReply()`。因此这次通用失败与“没有樊思睿资料”不是同一类结果。

## 2026-07-24 骰娘完整性修复实现笔记
- 固定命令规则最终按 `fnc` 调用 `DicePlugin` 实例方法，适合在构造函数中统一包装全部固定 handler；这样总开关、群 reply 状态和异常回复能覆盖现有及未来固定命令，而不需要在四十多个方法里重复判断。
- `.reply on/off` 必须绕过 reply 静默检查，否则关闭后无法恢复；但它本身是群级配置写操作，应只允许主人、群主或管理员执行。模块总开关仍高于 reply 恢复入口。
- 固定群级写操作至少包括 `.set`、`.setcoc`、`.sn`、log 开停/结束/导出和先攻清空；读状态与玩家自己的掷骰/人物卡操作不应被错误地升级为管理员专属。
- 当前人物卡锁定写在 `user.locked`，会把全部卡一起锁住且任何写入口都不读取。应迁移为当前 `card.locked`，兼容读取旧 `user.locked`，并在 `.st`、成长写回、标签和删除/覆盖当前卡等实际写入口统一拒绝。
- NapCat 线上拒绝固定 log 的根因是把宿主绝对路径当成 URL；新的交付顺序应优先走 OneBot `upload_group_file` 并把完整文本编码为 `base64://`，只有适配器没有该接口时才尝试 `file://`。两路都失败时必须明确“文件未发送”，不能把 4500 字截断正文称为导出。
- 固定 `.sn` 可以安全实现为“用户在当前群主动开启”：先验证 `set_group_card` 成功回执再持久化开关，切换人物卡或内部昵称后同步；关闭时停止自动同步并尽力恢复开启前群名片，恢复失败要分别说明。
- V2 secret 的安全边界必须同时约束调用权限与交付受众：schema 现在要求引用 secret 的自定义命令既是 GM+ 权限，又必须 `visibility: private|gm`；内置卡/群卡总览永远不把 secret 放进群消息，精确查看或修改秘密字段转为带持久投递 ID 的私聊结果。
- V2 玩家规则数据已改为 `规则包 -> 群 -> 存储值`，旧无作用域数据只会被首次访问群认领；同一 QQ 在两个群使用同一规则包不再共享 HP、资源或秘密字段。
- 团务启动前先在同一个 state 草稿中创建配套 log，再统一提交；结束时只停止本会话拥有的 log。已有手工 log 会被沿用且明确标记“不接管”，避免团务结束误关独立团录。
- `identity.group_card: "{attr.name}"` 会使用人物字段已经按 `{sender.card}` 初始化的真实值；测试事件的群名片是“测试员”，因此同步请求也应为“测试员”。此前“调查员”只是新增断言写错，不应为迁就测试改坏运行语义。
- 规则包导出与固定 log 的故障模式完全相同：裸本地绝对路径不是 NapCat 可识别的 URL。统一完整文件交付后，群聊优先调用 OneBot `upload_group_file` 并传 `base64://`，群/私聊适配器后备使用 `file://`；两路都不可用就明确失败，绝不把前 4500 字伪装成导出。
- 教程与当前实现已有系统性漂移：仍称玩家规则数据跨群复用、迁移只能单步且无群字段、私聊失败会公开 QQ 且不可重试、YAML 永远不能请求群名片、物品/技能没有原生效果，也未列战役/暂停/快照/回退。这些都必须按实际安全边界整体改写，而不能只在命令速查末尾追加名称。

## 2026-07-25 群知识转述回复 AI 感审计
- 待核对：示例包含两段可见输出，“正在搜索‘沃基的教派’相关信息”很像工具进度层；“@斯卡蒂之嗣 ... 至于是不是逆天主教……这个得问教主啦”像最终模型组织层。必须用日志和代码确认，不能把两段都归因于同一模型。
- 线上证据：请求发生于 `2026-07-25 09:30:39`、群 `953676639`、用户 `925640859`。语义分类在 6868ms 后返回 `intent=tool/toolName=searchInformationTool/confidence=0.91`，并明确记录理由“用户询问不明确且较冷门的事实信息，需要搜索核实”。因此联网搜索不是主模型偶然自选，而是前置分类器强制调度。
- 搜索调用参数为 `query=沃基的教派是什么`、`progressText=正在搜索“沃基的教派”相关信息`。2.5 秒后进度句原样发送。它是分类模型生成的参数，不是仓库固定字符串；`ROBOTIC_PROGRESS_PATTERN` 包含“正在查/查询/检索”，却没有“正在搜索”，所以 suggestedText 通过守卫且不会重新生成。
- 搜索服务在约 5.1 秒后返回了完全错义的结果：把“沃基”当作 `Woke` 音译，并说明其不是宗教。说明通用联网搜索没有群内实体消歧能力，且本轮本可由已有身份事实直接回答。
- 最终总结升档至 `gpt-5.6-luna`；请求体同时含：固定人设“沃基是福尚愈足的教主”、身份绑定和长期记忆中的相同事实、最近群聊“这是什么逆天主教”、错误的 Woke 搜索结果，以及“最终回复只能陈述本轮工具结果”的工具 grounding system 消息。模型最终绕过搜索结果，组合出“福尚愈足/教主是沃基/逆天主教得问教主”。
- “福尚愈足”和“沃基是教主”有生产配置及记忆证据；“逆天主教”只来自上一条群友发言，不是稳定事实。模型把玩笑上下文续写成事实回答尾巴，是证据层级没有在生成前做裁剪，而不只是口吻温度偏高。
- 本轮最终没有调用 `mentionMembersTool`。模型直接输出 `@3671201171`，发送层正确转换为 OneBot at 段；因此“告诉斯卡蒂”的动作实际成功，AI 感来自正文和多余进度，不是艾特能力失败。
- 用户可见耗时约 18.8 秒：1 秒合并窗口 + 6.9 秒语义分类 + 5.1 秒无效搜索 + 约 6.2 秒最终总结。错误工具不仅使话术机械，还贡献了大部分额外延迟。
- 系统性触发点位于表情包工具接入：`classifyEmojiToolExposure()` 会把绝大多数 60 字以内消息标为 `casual_conversation`，`selectToolIntentCandidates()` 因此返回 `sendLocalEmojiTool`；只要存在这个候选，`shouldUseSemanticToolIntent()` 就会运行 Planner。
- Planner 的 `availableTools/toolCatalog` 来自过滤前的 `session.tools`，即全部已配置工具，而不是候选集合；真正的 `filterToolsForMessageIntent()` 在语义决策之后才执行。这解释了为什么表情包候选能间接强制搜索，也说明同类误路由不限于本例。
- Planner 只拿当前文本、媒体、格式化消息和群工作流，没有拿主模型系统提示里的身份绑定、群知识和长期记忆。它在证据视角里看不到“沃基”的群内定义，因此容易把内部实体当冷门外部知识。
- `SearchInformationTool` 对任何非空 `choices[0].message.content` 都返回普通字符串；`classifyToolResult()` 对没有显式错误标记的非空字符串统一判 success。当前没有实体一致性、语义一致性、来源有效性或引用校验，`Woke` 错义结果也会成为“成功证据”。
- 工具 grounding 是附加 system 文本，不会移除早先已经注入的身份、记忆、知识库和群历史；它无法从结构上阻止模型越权使用冲突来源。正确边界应在组装最终请求前裁剪/分级证据，而不是期待模型服从一句软规则。
- 点名转述目前没有结构化言语行为。直接文本 @ 虽能由发送层转换为真实 at 段，但正文仍由模型自由生成，因此出现“@斯卡蒂 + 斯卡蒂”的重复称呼、“他的教派”的代词歧义、“教主就是沃基本人”的重复解释和“至于是不是……得问教主啦”的模型式尾巴。
- `polishHumanReplyText()` 与 `personaFeedbackManager.guardReply()` 只删除动作括号、客服腔、自我怀疑和配置中的固定坏词，无法检测事实来源、重复收件人、代词歧义、无依据评价或多余总结尾巴。
- 旁路风险包括：`mentionMembersTool`/`mentionAdminsTool` 直接发送 Planner 自由生成的 `message`，成功后作为终态工具跳过最终回复；搜索进度直接 `e.reply`；Google 图片编辑和 Banana 绘图仍有本地随机进度/完成文案；统一失败回复仍是固定模板。它们都可能形成和主对话人格不一致的可见输出。
- 日志抽样显示 7 月 24 日至今语义分类运行 77 次，其中 39 次最终仅为 chat；普通 chat 分类平均 5391ms、P95 约 7337ms，工具决策平均约 11499ms、最大约 20457ms。同类请求“沃基的教派的理念是什么”稍后又被判为 chat，说明该层对相近语义不稳定。
- 用户视角的正确结果应只完成动作和命题，例如 `@斯卡蒂之嗣，沃基那个教派叫“福尚愈足”`；没有必要发送搜索进度、解释谁是教主或评论“逆天主教”。

## 2026-07-28 图片响应体卡死恢复
- 群 `953676639` 的任务 `messageId=18240208` 于 17:04:09 进入 BananaTool；进度提示在 17:04:11 发出，但 13 分钟后 Redis 仍保留 job、queue、`tool_running` 和 active-task 状态，没有成图或失败回执。
- Node 进程到 `api.krill-ai.net` 的 Cloudflare IP `172.67.70.193:443` 保持 ESTABLISHED；没有进入下一候选或产生失败日志，说明第一候选已经返回 HTTP 响应头但正文读取未结束。
- `fetchWithTimeout()` 在 `fetch()` 返回 Response 时就在 `finally` 清除 120 秒 timer；`parseImageGenerationResponse()` 后续才调用 `response.text()`，所以 response body 卡死不再受 AbortController 保护。
- `runDrawJob()` 的 finally 已能删除 durable job、清除 active status、调度下一项；只要请求层对正文超时真正 reject，就不需要冒险手工删除 Redis key。
- 生产恢复原任务后，Redis job 和队列均为 0、active-task 已清空；消息状态留存为 `tool_failed`（约 24 小时，用于原消息状态查询）。本次不是继续卡住，而是 Krill 返回了没有图片数据的 `error/type` 响应。
- 恢复任务没有原始 Agent 调用栈接管工具失败，但原记录中 `notifyFailure` 对正在执行的初始任务是 false；恢复后必须强制打开失败通知，否则会出现“状态失败但原群无说明”的静默收尾。
- 该恢复通知分支已上线并经真实 TRSS 17/17 定向回归验证：恢复任务返回图片错误时会调用原群的 `sendMsg`，成功时不新增文字消息。生产服务运行 PID `1198400`，`bl-chat-plugin` 与 MessagePipeline 各初始化一次，OneBot 已连接。

## 2026-07-25 绘图开场任务语义修复
- 用户原话没有携带或引用图片，但明确要求画“群里的翠月”；`resolveAvatarDrawReference()` 会按群成员唯一名称命中翠月并生成 QQ 头像 URL，这个按需参考行为符合既有需求。
- `getImageGenerationReferenceImages()` 在当前消息没有图片时回退到 `session.avatarDrawReference.images`，因此 BananaTool 实际收到一张内部头像参考。
- BananaTool 的 `hasReferenceImages` 只看图片数组长度，并用它同时决定图片编辑 provider 和进度句库；`REFERENCE_IMAGE_PROGRESS_MESSAGES` 第三条就是本次精确可见回复。它不是模型临时生成，也不是历史污染。
- 用户语义是“基于人物外观参考生成新场景”，不是“查看图片重点”或“把原图改成新图”。需要保留内部参考，但为进度层增加 `referencePurpose=member_avatar` 和 `reference_generation` 任务语义。
- Banana 与 GoogleImageEdit 仍维护两套随机固定开场，均绕过共享 `contextualProgressReply`；应统一为当前模型生成、事实守卫、静默降级和完成即取消，避免下一次只换成另一句固定人机话术。
- 已删除 Banana 文生图/参考生图和 GoogleImageEdit 真编辑的随机固定开场数组，统一复用共享生成器；三类任务使用不同事实边界。
- `member_avatar` 只表示外观参考，面向用户仍属于生成新图；provider 底层是否携图不再决定用户可见任务语义。
- 新实现不等待进度模型才请求图片；图片先完成时中止迟到进度，进度模型失败或连续两次违反事实守卫时静默。
- 静态反查未再发现 Banana/GoogleImageEdit 旧随机开场数组或 `getProgressMessage()` 调用；当前剩余风险主要是并行后的发送/取消时序，不是任务类型传递。
- 服务器真实宿主回归证明群内图片/引用解析、最近成图续改和 prompt 上下文策略未被本次进度改动破坏；“读取群友头像作外观参考”与“向用户声称看过待改原图”已被拆成两个独立概念。

## 2026-07-25 群 763694201 昨晚会话审计
- 审计窗口内日志记录 171 条入站/通知事件；普通 QQ 出站日志只出现两条：19:38:25 的三角洲今日密码命令结果，以及 20:57:31 的“别搞”。
- 群归档开启，保留 7 天，目标文件为 `data/message_archive/group/763694201/2026-07-24.ndjson`；仍需核对归档是否包含 bot 出站及媒体/表情独立发送出口。
- 18:00-19:55 的可见上下文以材质包、家具模组、群文件和群友互聊为主；TimingGate/SmartSkip 多次明确选择不插话，这些静默不能直接判作漏回。
- 20:57:19、20:57:26、20:57:31 三名不同群友连续发送“别搞”；`[Repeat]` 检测到 3 人复读后由独立模块直接发送第四句“别搞”。这不是 LLM 生成或上下文误读，但它绕过人格/表达层，用户视角仍会算作希洛突然插话。
- 20:54-20:58 的主话题是“要不要给 MC 生存服加寄生虫等增强模组”；“别搞”本身贴合群友对寄生虫提议的集体反应，没有语义错位，问题在出站归属和缺少对话层统一治理。
- 目标群在 2026-07-24 00:34:21 才发生机器人入群 notice，00:35:31 群友随即说“希洛来啦”；“昨晚”可能指这一段跨午夜初次会话。审计范围需补查 00:00-06:00，不能只看 18:00-24:00。
- 18:00-24:00 另有 4 次 B站卡片经 MediaOutbox 自动发送合并转发；它们属于媒体搬运，不是对话模型发言。一次跨 3 群同视频发送中，目标群总耗时 21.2 秒且主要耗在 QQ 合并转发发送 17.9 秒；其余约 3.5-14 秒。
- 全日普通出站共 17 条，其中 00:35-03:40 的初次夜间有 13 条；15:28 有两条相同失败兜底，19:38 是命令结果，20:57 是复读。夜间才是需要逐句审计的主体。
- 00:43 三角洲命令先明确返回“API 请求超时”；群主随后说“希洛你好菜”，主模型却回复“只是刚刚没接住嘛…再来一次”，把已知工具超时模糊成自己没接住，既不承认真实失败也带撒娇式辩解。
- 01:04 的识图请求只有一张引用图片；最终回复却说“第二张没显示出来”，存在素材数量幻觉。进度到最终回复总耗时约 48.7 秒，工具本身约 28 秒。
- 01:18:51 的“慢慢来总能出好看的”启动了一轮主动回复；模型返回前群内已新增“此外还有航空学”“打工人的痛么”“你可以造飞机玩坦克”。01:19:12 仍发送“创造服最适合慢慢雕细节”，语义属于旧话题，产生明显的迟到插话；发送前没有新鲜度/话题推进校验。
- 01:19:05 星野直接引用并 @ bot 问“打工人的痛么”，系统又启动一轮并在 01:19:21 回复“隔几天不上线就得重新考古一遍进度”。两轮回复相隔 9 秒，造成旧主动插话和定向回答连发。
- 01:19:41 星野说“这是又抢回来里么”，路由仅按 `R0_same_user_followup` 强制继续，compact 上下文仍没解析“抢回来”指代，最终诚实询问但表现为刚参与话题又突然失忆。
- 03:40:30 用户明确说“希洛，画一个……画面”，工具过滤却记录“轻松闲聊仅启用 sendLocalEmojiTool”，生图工具没有暴露；模型只回复“好呀，阿米娅认真检修……”并未执行绘图。这是确定性的工具暴露/意图优先级错误，不是生图渠道失败。

## 2026-07-27 群聊会话链路系统性修复
- 审计中的两条漏画语序分别为“希洛画一个 A 和 B 拥抱的画”和“希洛，画一个 A 帮助 B 检修电脑的画面”；现有 `IMAGE_GENERATION_PATTERNS` 对“画一个……的画/画面”覆盖不稳定，且表情工具过滤发生在能力候选保护之前时会只留下 `sendLocalEmojiTool`。
- 01:04 图片日志证明同一 QQ `fileid` 的 `spec=0` URL 和原 URL 在上层被计为两张，真正识图工具随后去重为一张；素材身份必须在上下文计数和 prompt 构造前归一化，而不是只在工具内部去重。
- 01:19 的迟到插话来自未点名主动回复：开始生成后有三条新群消息且话题已经推进，发送端仍无新鲜度校验。明确点名/引用请求必须保留，只有主动插话应按群消息序号和话题相关性取消。
- 15:28 群知识已 `[群知识] saved=1`，随后主模型 fetch 失败却发送整体失败模板；副作用结果必须成为终态事实，确认成功后不再依赖主模型生成成功确认。
- `selectToolIntentCandidates()` 把普通轻松闲聊暴露为 `sendLocalEmojiTool` 候选，本身没有问题；真正的额外延迟来自 emoji-only 候选被当成“必须运行语义 Planner”的信号。将其从 Planner 信号中排除后，表情工具仍会在主模型工具列表中按场景开放。
- 主动回复的新鲜度锚点不能取“准备发送时的最新群消息时间”，否则 Gate 等待期间到达的新消息会被错误吸收到锚点里。正确锚点是触发该轮主动判断的原始入站时间，最新时间只用于发送前比较。
- QQ 图片 URL 中 `spec`、`rkey` 等参数会变化，但 `fileid` 稳定；去重键应优先稳定文件标识，完整 URL 只能作为无文件标识时的后备。
- 群知识/工作流保存与主模型回答是两个独立提交阶段。成功写入必须记录为结构化动作结果，失败文案先检查这些已提交结果，不能让后续模型故障回滚用户认知。
- TRSS 会扫描 `plugins/` 下的隐藏目录；线上 staging 即使以点开头也会被加载。今后的真实层级测试目录应放在 plugins 外，或测试完成后在重启前移出扫描路径。

## 2026-07-28 音乐合并转发完整文件交付
- 当前 `sendMusicShare()` 已把 MP3 下载到本地，也会另外发送 `record` 语音段；缺失不在下载层。
- 合并转发第二节点使用 `{type: "file", data: {file: "base64://..."}}`。该结构只经过 `makeForwardMsg`，没有任何 QQ 文件上传回执；NapCat/OneBot 不保证新文件段可以嵌入合并节点，实际会丢弃，因此用户看到的合并记录没有文件。
- 仓库已有跑团日志验证过的完整文件路径：群聊调用 `upload_group_file` 并传 `base64://`，检查 `retcode/status`；适配器后备使用 `sendFile(file://...)`。音乐链路应复用同一交付契约，而不是继续扩展合并转发文件段。
- QQ 合并转发不能作为新生成文件的可靠上传容器。用户侧正确形态应是同一轮交付中的可下载文件消息，加一条音乐信息合并记录；合并记录只陈述已通过真实上传回执确认的文件名和大小。

## 2026-08-03 受限磁链下载工具
- 现有 `sendCompleteLocalFile()` 已有可靠群/私聊文件交付契约：优先 OneBot `upload_group_file` / `upload_private_file` 的 base64 上传，再回退适配器 `sendFile(file://...)`，并检查回执与文件大小。
- 线上主机没有 `aria2c`、`transmission-cli` 或 `qbittorrent-nox`，也没有 active 的 `aria2` 服务；实现必须把 `aria2c` 作为明确依赖处理，未安装时只能如实拒绝，不能伪造下载状态。
- `/opt/trss-yunzai` 所在磁盘当前约 29 GiB 可用，但工具仍必须使用自身总大小限制和独立临时目录，不能把空闲磁盘视作可下载额度。
# 2026-08-03 磁链元数据持久化解析

- 当前流程有 DHT、补充公开 tracker 和 HTTPS 元数据缓存三层，但整个调用在约 81 秒后终止；失败后临时目录会被清理，任务状态不会跨重启保留。
- 用户授权对 BTIH `69A6...0166` 持续解析。此前生产日志确认它的首次 DHT 元数据请求在 45 秒超时，未产生 `.torrent` 元数据文件；尚未开始内容下载。
- 2026-08-03 实测该哈希的单独 aria2 DHT 探测 25 秒后仍为 `CN:0 / SD:0`，没有产出 `.torrent` 文件。说明当前服务器未发现可提供元数据的 P2P 节点，不是大小限制或内容下载阶段的问题。
- 插件已有持久任务恢复入口：`apps/test.js` 启动时会调用所有工具的 `recoverDurableJobs()`。`BananaTool` 的 Redis 队列模式可复用其事件序列化、重启恢复和 TTL 思路，但磁链任务需要按 infohash 全局去重、延后重试而非立即恢复执行。
- 用户澄清目标是寻找当前能解析已知可用哈希的路径，而非持久重试。已删除误创建的目标 Redis 任务并确认 key 不存在；后续实现改为一次任务内验证多来源。
- 实测第一个 HTTPS 缓存通过 curl 返回 31,659 B 种子且 info hash 匹配目标；但工具内 Node fetch 使用 `redirect: "error"`，该源会重定向，因此被静默当成缓存失败。当前根因不是缓存无数据，而是过严的重定向策略。
- 可用直连源为 `itorrents.net` 的 HTTPS 种子端点。线上工具已改为缓存优先，实测 `discoverMetadataFromCache()` 返回 true；解析到根目录“哥斯拉2：怪兽之王.720p.1080p.BD中英双字”、3 个文件、总计约 6.526 GB。工具将因此在下载前正常报告超过 50 MB 上限。
- 不下载内容仍可读取该种子顶层元数据：comment、created by、creation date、info；实际创建工具为 `go.torrent`，创建时间戳为 1566105999，分片大小 4 MiB，分片哈希数据 31,140 B。该种子没有 announce、announce-list 或 web seed；原磁链同样没有 tracker，这解释了纯 P2P 发现失败。
## 2026-08-03 单数群主艾特路由修复
- 生产日志确认用户说“艾特我们的小娇妻群主”时，语义规划错误选择 `mentionAdminsTool` 并传入 `includeOwner=true`；该工具的设计就是枚举管理员，因此实际群体艾特是确定性后果。
- 修复使用当前已读取的 `memberMap`，只在当前群唯一 `role=owner` 时构造 `mentionMembersTool` 的精确 QQ 目标；同时在工具暴露、语义规划归一化和执行前各加一道“明确集合措辞”防护。
## 2026-08-03 群 609235590 科普回复呈现修复
- 21:03:10 的真实请求为“希洛给我解释一下,做一个mc的mod都需要什么”。模型 15.0 秒后给出 462 token 的普通 Markdown 入门清单；它没有发错工具，但缺少 MC 模组开发的版本/加载器兼容、项目目录、注册、客户端与服务端边界、调试发布等具体层次。
- 发送层 `getTextImageTemplateForFinalReply()` 将任何教育型回答或超过 180 字的回答改为 `textImageTool` 的 `document` 卡面。日志确认 21:03:31 只发送图片、21:03:34 标记 `template=document`，正常科普文本完全未送达。
- 现有 `solutionExplanationStyle` 明确要求技术解释不要自动转图片，但生产入口此前未加载该模块，且分类词表没有覆盖 MC/模组/Fabric/Forge 等语义，因此两层规则都没有作用到这条请求。
# 2026-08-04 MC 知识卡延迟取证
- 真实请求：群 `609235590`，`希洛给我解释一下,做一个mc的mod都需要什么`，14:46:33 收到，14:46:52 知识卡发送完成。另一次同请求在群 `953676639`，14:47:09 收到，14:47:33 完成。
- 两次都有固定约 1 秒的直接触发消息合并。主耗时为首轮模型：`13,074 ms` 和 `19,582 ms`；模型分别处理约 `11,016`、`12,695` prompt token，生成约 `512`、`659` token，且分别使用 `86`、`139` reasoning token。
- 这类请求不需要工具，但因普通会话仅暴露 `sendLocalEmojiTool`，仍满足 `useTools` 路径，因而首轮调用 `toolsAiConfig` 的 `gpt-5.6-luna`。模型没有调工具、直接回答，但这条绕路已经发生。
- 知识卡渲染和 QQ 图片发送合计约 `4.3 s`（第一次）和 `3.5 s`（第二次）。现有日志未把 Puppeteer 渲染、base64 编码、QQ 上传单独拆分，不能再细分；但它们不是 13-20 秒的主因。
- 服务器当时 load average `0.22`、TRSS 进程 CPU `0.9%`，不是机器资源争用。可优化方向：对已确定“不需要工具”的知识/技术解释跳过工具模型，直连 chat backend；压缩静态 system prompt；为知识卡增加 render/encode/send 分段耗时日志后再压卡面阶段。
# 2026-08-07 对外失败原因统一展示（续）
- 审计确认 `apps/test.js` 的主聊天和高频工具入口已接入统一可见错误格式化器。
- 仍需修复的直接可见出口集中在 `apps/MessageManager.js`、`apps/EmojiPackImport.js` 和 `utils/fileUtils.js`；它们要么仅提示“失败”，要么直接透出 `error.message`。
- 最终统一边界：主聊天、图片、搜索和管理命令外，`apps/test.js#runToolCall()` 也会在旧工具返回失败字符串后、交给模型前格式化该结果；工具基类在异常和参数规范化失败时同样使用此格式化器。这样即使旧工具未迁移，也不会通过模型转述泄露密钥、签名 URL、磁链或本地路径。
- 线上部署首次受 macOS AppleDouble `._*.js` 和先前未同步的依赖影响；已用无 AppleDouble 的归档重传、补齐入口依赖，并将伪脚本移入 `/opt/trss-yunzai-backups/bl-chat-plugin-visible-failure-20260807-20260807-110646/appledouble`。最终启动正常。
- 无 HTTP 状态码的 `servers are currently overloaded` 是上游容量不足，而非用户消息、解析或鉴权错误；需要在 `visibleFailure` 和 `chatRequestRecovery` 同时归类为 upstream，避免英文原样进入群聊。
- 已上线验证：`Our servers are currently overloaded. Please try again later.` 输出为“回答服务现在有点忙，这次请求没等到结果。原因：上游服务当前负载过高，请稍后重试”。

# 2026-08-07 人格自主性与关系边界
- “喊爸爸”被直接执行且附带讨好表情，说明现有提示只包含风格而没有自主关系边界。修复应让模型基于已有关系/记忆选择是否接受，而非对单个称呼做关键词拦截。
- 本地已接入关系自主性、稳定偏好与固定边界。主聊天提示要求先参考关系、长期记忆和群语境；对于单句强塞亲密、支配、家庭、占有或服从称呼，应自然推开且不补讨好型表情。`apps/test.js` 已传入运行配置中的 `persona`，默认配置已补 preferences/boundaries。定向测试 12/12、语法检查和 diff 检查通过。
- 线上覆盖配置原先没有 preferences 和“关系称呼不能由单句决定”的 boundary，且其主提示调用未传入 `this.config.persona`，两处共同使本地默认配置无法生效。已做最小运行补丁：替换 `personaTonePolicy.js`、在既有调用加入 `persona: this.config.persona`、仅向线上 persona 区块添加三条偏好和一条关系边界。远端语法检查和现有独立回归 8/8 通过；远端测试文件不是本轮新增版本，因此其总数少于本地。
- 服务已重启并验收为 active；`bl-chat-plugin` 初始化正常、加载 34 个插件，启动后未见 `SyntaxError`、`ReferenceError`、`ERR_MODULE_NOT_FOUND` 或插件载入错误。远端策略文件 SHA-256 与已验证的本地版本一致；本地以默认 persona 做的最终提示探针确认四项自主性/偏好/关系边界要求均会进入“喊爸爸”这一类普通聊天的模型提示。

## 2026-08-08 骰娘随机性审计
- 群 `953676639` 在 10:54-10:55 的六次 `D12` 是 `12、12、1、11、11、11`；每条都有不同消息 ID 和独立骰娘执行/发送日志，不是消息重放或请求幂等缓存。
- 普通骰路径 `DiceManager` 及表达式/规则包后备路径均使用 `Math.random`。没有在 TRSS 主代码或插件运行代码中发现对 `Math.random` 的赋值覆盖，也没有按用户或群持久化普通骰种子；因此不能证实已被固定，但此实现不是加密随机且不可审计。
- 自定义规则的正常命令执行已经通过 `DiceRuleSession.createRuleRandom()` 用 `crypto.randomBytes(16)` 生成每次调用独立种子，并用 SHA-256 派生后续随机值和记录审计种子。修复普通骰时应保留这一机制，只替换其少数后备 `Math.random` 默认值。
- 已新增 `utils/diceRandom.js`：`secureDiceInt()` 直接使用 `crypto.randomInt`，`secureDiceRandom()` 提供 [0,1) 形式以兼容表达式和加权表。普通骰、表达式、规则包的后备随机源均已接入；规则包实际命令仍优先使用原有独立加密种子。三份骰娘运行文件中已无 `Math.random`。
- 本地定向回归 56/56 通过；新增测试在全局 `Math.random` 抛错时验证普通骰和表达式后备仍可工作，显式注入随机函数的测试能力未变。12 万次加密 `D12` 抽样每面为 9,795-10,127 次。
- 已部署运行文件 `diceRandom.js`、`DiceManager.js`、`DiceRuleExpression.js`、`DiceRulePackManager.js`；远端备份为 `/opt/trss-yunzai-backups/bl-chat-plugin-dice-crypto-20260808-110349`。远端语法检查通过，并以把 `Math.random` 设为抛错的实际模块探针验证标准骰、表达式和规则包后备均可运行。服务重启后 active，插件初始化成功、加载 34 个插件，无启动错误。
- 远端历史 `diceRulePackManager.test.js` 有 5 个失败，均为测试文件早于当前运行文件版本导致的规则包状态断言失败；本次修改的 DiceManager/表达式回归及运行探针均通过，未将该组历史不一致误判为随机源失败。
# 2026-08-19 合并转发聊天记录无损回放

- 生产群 `953676639` 的事件 `38788634` 已确认仅归档了 `forward_context.text`。原始顶层 `forward` ID 为 `7673792152265507624`，嵌套 ID 为 `7673792152265507628`；图片和节点发送者结构均已在归档时丢失。
- 根因是 `collectForwardContext()` 只返回文字与媒体摘要，`appendForwardContextSegment()` 与 `normalizeMessageSegments()` 又只持久化该摘要；`buildArchiveForwardMessages()` 最后将摘要当普通文字放进一个新节点。
- 新方案保存受限、可 JSON 化的递归节点快照。查询优先生成原发送者节点，嵌套 forward ID 原样作为段保留；旧行没有快照时继续使用文字回退。
