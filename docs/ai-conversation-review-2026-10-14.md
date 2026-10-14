# 重构后的群聊智能、人设与记忆复核

日期：2026-10-14。审查基线：`de0352134807c5aea7adf69c1af90d0e1e76db1d`。

本轮依据当前 TypeScript 源码、与源码哈希一致的本地编译产物，以及合成输入的离线验证。10 月 13 日“小馒头”原始 99 节点样本沿用上一轮取证；本轮没有重新连接生产，因此昨天的人设配置、模型配置与部署状态不能当作今天的运行态。

## 判断

这次重构已经为改进聊天能力提供了更好的基础：业务实现迁入 TS，回合、提示组合、最终回复和记忆依赖有了可注入入口，发送确认与账号身份也有实际修复。接下来适合在这些接口上做几批明确的行为改进，无需再整体重写后端。

但“代码可维护”与“聊天更自然”需要分别验收。上次发现的人设字段丢失、输出改坏语义、记忆缺正文、情绪误判等，当前大多仍可复现。新增核实的人设缓存与第一人称记忆串用，也会破坏多人格的一致性。优先修这些确定性问题，再增加社交理解，收益比继续叠加口吻禁令更明确。

小馒头值得参考的是理解互动动作、延续共同笑点、保持自己的态度，并能在认真场景收住玩笑。5 字的回复中位数只是样本特征，不应成为我们机器人的统一长度目标。

后续已按用户补充要求读取最新三个转发的22个归档节点，并核对“电子体香”原图，见[新样本分析与方案修正](/Users/shiqi/IdeaProjects/bl-chat-plugin/docs/ai-conversation-samples-2026-10-14.md)。体验侧优先验证当前证据能否支持有态度的接话，再按多轮需要扩充社交状态；不将状态复杂度本身当作智能提升。

## 已经解决或明显改善的部分

| 项目 | 本轮确认 | 后续处理 |
| --- | --- | --- |
| `skipIntentModel` 常量重赋值 | [chatTurn.ts:258](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/tools/infrastructure/chatTurn.ts:258) 已改为 `let` | 撤销上次针对这一错误的修复建议 |
| 回合与最终回复测试入口 | `createChatTurn`、`createTurnPromptComposer`、`createFinalReply` 等工厂可注入依赖 | 直接用来构建真实链路回放 |
| 未确认发送被登记为成功 | [finalReply.ts:121](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/application/finalReply.ts:121) 在无确认回执时返回 | 保留，确保新增社交状态也遵守这一提交条件 |
| 会话调度与回复跟踪的账号身份 | 已有 [ConversationContext](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/contracts/conversation.ts:1)，部分状态和跟踪已经按 bot 隔离 | 将这个身份继续传到缓存、续聊和情节端口 |
| 情节缓存跨数据目录串用 | [episodicMemory.ts:35](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/memory/infrastructure/episodicMemory.ts:35) 以文件路径区分缓存 | 保留；这还没有解决同目录里的多 bot 来源问题 |

迁移报告记录的全量通过结果属于迁移会话；本轮验证结果单列在文末，避免把两次验证混在一起。

## 第一批：修复会直接破坏聊天内容的行为

### 1. 稳定人设必须每轮生效，并且一轮只解析一次

[promptLayers.ts:29](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/domain/promptLayers.ts:29) 的普通闲聊仍只保留六层，排除了 `expression`、`globalStyle`、`semanticStyle` 和 `personProfile`。机器人自身的 `tone/speechStyle/notes` 恰好主要由 [personProfileInjector.ts:118](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/memory/application/personProfileInjector.ts:118) 写入最后这一层。合成验证中，闲聊会读取画像后再丢弃，最终 system 不含这三个字段的测试标记。

同时，[personaSource.ts:35](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/domain/personaSource.ts:35) 仍给不同人设附加共同的慵懒、软和、必须大方承认善意等具体性格规则。这会压过另一套人设自己的态度。

建议：

- 在人设解析处产生带 `personaId/revision` 的完整 `PersonaSnapshot`，至少包含身份、语气、表达习惯、偏好、边界和备注。
- 回合开始确定快照，经 session 传给提示组合、工具后的回复生成、最终出口和情节记录。避免生成前和发送前分别调用 `getPersonaFor()`，热更新时一轮混用两个人格。
- 将机器人自身的稳定人设从人物画像模块拆出，成为 chat、task、private 都存在的共同输入；人物画像只保留对方与群的信息。
- 公共规则负责事实准确、尊重纠正和可靠执行；“温柔是否直说”“被夸是否嘴硬”等交给具体人格。
- 表达学习按相关性与预算取少量样例，先实现字段必达，不要简单把全部历史风格层重新打开。

基础 system 仍来自 [chatTurn.ts:516](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/tools/infrastructure/chatTurn.ts:516) 的公共 `systemContent`。当前支持名字占位符，但旧配置写死身份时不会自动替换。应增加旧配置冲突检测与显式迁移说明；本轮没有确认生产是否仍存在昨天的写死配置。

还有一个当前可触发的身份残留：[agentIntelligence.ts:139](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/domain/agentIntelligence.ts:139) 把所有 assistant 历史标为“希洛回复”。[messageFormatting.ts:222](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/application/messageFormatting.ts:222) 无条件调用此格式化，关闭智能历史筛选也不能绕开。宜改成“本账号历史回复”，或使用该条历史真实的人设元数据，不能用现在的人设给过去重新冠名。

### 2. 风格守卫不能靠全局换词改写语义

[personaFeedbackManager.ts:147](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/memory/infrastructure/personaFeedbackManager.ts:147) 仍对家庭称谓、害羞表达做全局替换，默认坏模式表还会删除部分 AI 身份表达。当前编译代码复现：

| 模型原文 | 守卫结果 |
| --- | --- |
| 你妹妹今天不是回家了吗 | 你你今天不是回家了吗 |
| 有点不好意思啦，不过谢谢你 | 谢谢。，不过谢谢你 |
| 我是AI，但也不是自动夸夸机呀 | ，但也不是自动夸夸机呀 |

建议将出口检查分为明确的处理结果：可定位的协议或内部信息清理、需要重新生成的语义问题、可直接发送。风格建议主要进入生成前约束；发现真实的冒犯、身份混乱时，有预算才针对问题重生成一次，不能把任意词命中当作改写依据。正常的道歉、人物称谓和 AI 自嘲应保留。

保留现有内部状态泄漏处理和工具结果真实性限制。仅关闭 `personaGuard.enabled` 不足以解决所有误改，因为 [outputGuardPipeline.ts:93](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/application/outputGuardPipeline.ts:93) 的润色和语气边界还会独立执行。验收必须经过完整最终出口。

### 3. 补齐多 bot、多人格的缓存与第一人称记忆范围

这次确认了三条可重复触发的串用路径：

| 路径 | 当前范围与结果 |
| --- | --- |
| 人物画像缓存 | [turnPromptComposer.ts:184](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/infrastructure/turnPromptComposer.ts:184) 只含群＋用户；不同 bot 或切换人格后，task 回合可能仍带上一个人格的画像 |
| 人设反馈缓存 | [turnPromptComposer.ts:238](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/infrastructure/turnPromptComposer.ts:238) 使用常量键；有非空反馈时，chat 回合也会带入前一个人格的反馈文字 |
| 续聊与情节 | [turnContinuity.ts:14](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/application/turnContinuity.ts:14) 只按群＋用户；[Episode](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/memory/infrastructure/episodicMemory.ts:1) 没有 bot/persona 来源，召回却写成“你当时回” |

离线模拟同群同用户先找甲 bot 再找乙 bot：第二轮语气层已经是乙，画像和反馈仍属于甲；两个 bot 的合成情节也被一起召回成两条“你当时回”。新的会话上下文不会自动修复这些旧接口。

建议复用现有 `ConversationContext`：续聊按 `conversationId + userId` 保存，并校验人格快照；缓存按各层真实依赖加 `botId/personaId/revision`，切换或热更新时失效。将 [chatTurn.ts 契约中的 context](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/contracts/chatTurn.ts:17) 与解析端口的 `unknown` 收窄为实际类型，让漏传身份在编译阶段暴露。

不要把所有群记忆都拆成每个 bot 一份。群里公开事实可以共享并标来源；机器人自己的发言、行为、承诺和对某人的态度需要保留 `authorBotId/personaId`。别人经历的事应写成“甲当时说过”，旧数据来源不明时不能默认归为“我经历过”。

## 第二批：让记忆记住内容，并正确表达失败

### 4. 原始话语与模型上下文必须分开

[finalReply.ts:149](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/application/finalReply.ts:149) 仍截取 `session.userContent` 的前 120 字；这个字段已经带时间、名字、群身份和引用。用真实格式化函数拼接一个长引用，再走真实 finalReply，得到的摘要完全不含当前“我明天考试”。

建议 session 明确保留 `rawUserText/sourceMessageId/occurredAt/quotedMessageIds` 与单独的模型上下文。情节输入从原始话语、实际动作结果和确认送达的回复生成，先提取事件再压缩，不截格式化 prompt。情节再增加来源 bot/persona 与实际发生时间，避免生成内容、工具未完成承诺被当成既成经历。

这一步先做确定性的正文保留即可，不必为每条消息新增总结模型请求。

### 5. 消除时间字段与抽取结果的语义歧义

[extractor.ts:25](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/memory/infrastructure/engine/extractor.ts:25) 计算事件时间需要 `ctx.now`，但 [extractor.ts:162](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/memory/infrastructure/engine/extractor.ts:162) 只传 `at`。注入成功的 `eventInDays:1` 后，实际 `extract()` 仍产出 `eventAt:null`。

同一入口在 [159 行](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/memory/infrastructure/engine/extractor.ts:159) 把模型异常转为 `[]`，随后 [memoryManager.ts:1005](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/memory/infrastructure/memoryManager.ts:1005) 记成功。合成 timeout 会把已有 `failureCount:3` 清成 0，并更新 `lastExtractAt`。

建议先补齐时间传递，再统一为明确的消息发生时间与时区。缓冲抽取跨午夜时，“明天”应相对消息发生日计算，而不是后台 flush 时刻。抽取结果改成判别联合，例如 `success(ops)/skipped(reason)/failed(error)`；`success([])` 才表示成功且没有可记事实。失败分支应保留失败状态与有界重试所需材料，不能清空失败计数。

### 6. 转发采集与喂给模型的预算应分开

[groupContextResolver.ts:245](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/infrastructure/groupContextResolver.ts:245) 默认 80，且原始节点快照也受同一上限限制；[pipelineForwardContext.ts:18](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/adapters/pipelineForwardContext.ts:18) 又显式传入 80。合成 100 节点得到 80 行文本、80 个快照节点，返回值没有完整性标记。

建议归档保存独立采集预算内实际取得的证据，提示选择再按当前问题选窗口、尾部与引用命中；采集仍保留深度、字节和耗时上限。给 [ForwardContext](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/contracts/pipeline.ts:13) 增加采集是否完整、实际取得数量、裁剪原因与本轮选中节点 ID。上游总数未知时保持未知，不捏造总数。

不能只把 80 改成 100：那样会继续静默丢失更长的转发。已有 `raw_truncated` 表示外层原文字符串裁剪，不代表合并转发节点完整。

## 第三批：在现有回合架构中增加社交理解

### 7. 统一“在做什么互动”，供门控、语气与生成共享

目前已有意图模型、语义记忆和理解简报，问题是它们没有形成同一份社交判断。不能把建议概括成“再加一个 Agent”或“做一个向量库”。

- [personaTonePolicy.ts:6](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/domain/personaTonePolicy.ts:6) 用“为什么/多少/怎么回事”等词决定严肃解释；“你为什么不理我呀”“你今天怎么回事哈哈”“你喜欢我多少”在当前代码里都被判成 `precise`。
- [emotionManager.ts:141](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/memory/application/emotionManager.ts:141) 不识别对象和否定；“别人骂我笨”被判为 bot 遭骂，“你一点也不可爱”被判为 bot 获夸。其情绪存储已按 bot＋群隔离，问题是观察语义与关系粒度。
- [groupContextState.ts:1](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/application/groupContextState.ts:1) 目前主要是词频、最近发言人和 @ 关系；[chatTurn.ts:614](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/tools/infrastructure/chatTurn.ts:614) 又把普通闲聊的理解简报整体跳过。

建议在已有契约旁增加一份小型 `TurnUnderstanding/SocialState`，而不是复制一套编排：

| 信息 | 用途 |
| --- | --- |
| `speaker/addressee/replyToMessageId` | 判断谁在和谁说话，机器人该不该接 |
| `dialogueAct + confidence` | 区分求助、调侃、夸奖、关系试探、抱怨和纠正；不确定时允许 unknown |
| `activeJoke + evidenceMessageIds + expiresAt` | 保存“50 是 token、图片不等于付钱”这类局部共同前提，话题结束后过期 |
| `lastStance + unresolvedTopic` | 知道自己上一轮什么态度、还有什么没接完；真实纠正到来时允许更新 |
| `relationshipScope` | 区分群整体气氛与某个用户和这个人格的关系，避免一个人挨骂影响所有人的回应 |

可复用现有意图判定结果；普通明确闲聊让主模型直接结合材料理解，出现歧义再按预算调用已有理解简报。无需每轮串行多次模型判读。由同一份结果决定语气与是否接梗，关键词只作低置信兜底；引用里的词不能直接决定当前说话人的情绪。

群公共话题可以共享；“我的立场/我和这个人之间的玩笑”要按 bot/persona 归属。事实与推测分开，有来源、置信度与过期规则，不能把一次调侃永久写成用户画像。

建议的数据流：

```mermaid
flowchart LR
  E[消息原文与来源证据] --> O[更新话题与互动观察]
  O --> G[参与门控]
  G --> C[ConversationContext 与人设快照]
  C --> U[本轮理解与社交状态]
  U --> P[现有 TurnPlan 与提示组合]
  P --> R[模型与工具执行]
  R --> V[语义检查与发送]
  V --> D{确认送达}
  D -->|是| M[提交自身立场 续聊 情节]
```

### 8. 精简冲突规则，让人设形成可辨认的态度

当前空主模板为 3,113 字符，公共人设覆盖另有 1,273 字符，尚未计配置、记忆和语气层。长度本身不证明效果差，但说明闲聊仍携带大量固定规则。[personaSource.ts:47](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/domain/personaSource.ts:47) 不许说模型/API，而 [systemPromptTemplate.ts:60](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/domain/systemPromptTemplate.ts:60) 又允许正常技术说明，优先级容易冲突。

建议保留简短公共原则，按本轮能力加入工具或任务规则；具体态度与表达来自人设快照，再加两三条相关的情境示例。“AI/token”可以成为诚实的自嘲素材，不应靠删除技术身份来表现自然。人格的稳定偏好和边界应允许产生有趣、不过度迎合的回应；遇到真正低落或认真求助时，自然切换。

先保持模型配置不变做对照，修复字段与上下文后再评估模型差异。上一轮线上模型相同的观察属于昨天快照，本轮不据此判断当前生产模型或对方的模型能力。

## 第四批：把验收从“没禁语”升级为“连续接得住”

[personaReplay.mjs:39](/Users/shiqi/IdeaProjects/bl-chat-plugin/scripts/personaReplay.mjs:39) 目前只手工拼基础模板与语气提示，没有走完整 composer、记忆、门控及最终出口；[personaReplayCore.ts:33](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/conversation/domain/personaReplayCore.ts:33) 的自动检查只验证禁语、长度和非空。已有 characterization 测试锁住旧规则，是迁移一致性证据，不能作为聊天质量得分。

利用本次重构的工厂和 ports 增加两类验收：

1. 确定性回放：假模型、可控时钟、隔离存储和假发送回执，依次驱动实际回合入口、提示组合、最终出口、记录与下一轮召回。检查字段必达、身份隔离、原文保全和发送状态。
2. 生成质量回放：同一配置、同一多轮事件，分别运行基线和候选；由真人盲评对象识别、互动理解、梗延续、态度一致、认真任务切换和是否过度插话。同时记录额外模型调用数与响应延迟。

最小场景应覆盖：夸奖后反打；50/token 梗继续到图片回应；被说善良后保留自身态度；玩笑切到认真求助；第三人挨骂；否定夸奖；正常家庭称谓；长引用后当前问题；100＋节点转发尾部线索；跨午夜的明天事件；抽取超时；同群双 bot；同账号切人格；未确认发送。

验收不要比较是否复刻小馒头原句，也不要强制每条输出五个字。先证明我们的机器人理解了同样的互动，再比较表达是否自然。

## 建议实施顺序

| 批次 | 交付范围 | 可以验收的结果 |
| --- | --- | --- |
| A | 人设快照、字段必达、身份缓存范围、输出语义保全 | 人格不串用，正常语句不被改坏 |
| B | 原始话语契约、事件时间、抽取结果、情节来源、转发完整度 | 能记住真实事件，并诚实反映缺失和失败 |
| C | 共享社交状态、按场景组合提示、相关表达示例 | 连续几轮接得住，态度与对象一致 |
| D | 全链路多轮回放与同配置盲评 | 有证据说明改进来自哪里，且没有拖慢或破坏任务能力 |

回放骨架与每批修改同步增加；D 批完成完整评估，而不是最后才补测试。正确性修复独立提交并保留回滚点，新增社交策略可按群启用，保留已经修好的发送确认与账号调度。主编排后续若继续瘦身，应由 conversation/application 承接回合用例，tools 保留执行职责；不必把移动 926 行编排作为行为改进的前置条件。

## 本轮验证与边界

- 现有相关测试：17 个测试文件，98 项通过，0 失败、0 跳过。涵盖人设、分层与缓存、最终回复、聊天编译入口、抽取、情节、续聊、转发和跨 bot 事实来源。
- `npm run backend:typecheck` 通过，包含源代码与 TS 测试的严格检查。
- `npm run test:boundaries` 通过；此检查约束基础设施/平台依赖，不能据此声称全部业务职责已细分完毕。
- 源码和本地编译产物哈希校验通过；产物 manifest 的 commit 元数据仍是 `85b51d2`，内容哈希匹配当前源码，因此本轮没有把旧 commit 字段误判为旧代码。
- 合成离线证据：[人设脚本](/tmp/bl-chat-review-20261014/persona-audit.mjs)、[人设结果](/tmp/bl-chat-review-20261014/persona-audit-results.jsonl)、[社交记忆脚本](/tmp/bl-chat-review-20261014/offline-social-memory-audit.mjs)、[社交记忆结果](/tmp/bl-chat-review-20261014/offline-social-memory-results.json)。均未使用真实模型请求，临时目录中的情节为合成资料。
- [现有测试日志](/tmp/bl-chat-review-20261014/focused-tests.log)。合成问题复现与现有 98 项测试是两组证据；后者通过不代表前者的问题已修复。
- 本轮只新增审查文档和更新规划笔记，没有修改业务代码、生产配置或部署状态，也未发送 QQ 消息。尚未实施上述改进、运行真实模型 A/B 或验证生产运行态。
