# 后续阶段实施盘点

2026-10-13 的历史盘点。阶段 2–7 的实际验收已完成，最终收尾与交付状态见 [phase-8.md](phase-8.md)。以下保留原先的依赖顺序和验收要求；本文件不代表任何后续阶段已通过。用户已要求直接在主干逐阶段提交，不再创建额外分支。必须先取得阶段 2 的相关单测、严格类型检查、编译产物加载与完整阶段门槛证据，再进入阶段 3。

## 阶段 3：先把两条生图路径合成一个事实实现

当前并非简单的文件后缀迁移：

- `functions/functions_tools/BananaTool.js` 同时承担 QQ 工具入口、Redis 队列、配置选择、提示词、provider 请求、结果校验与 QQ 回复。
- `utils/imageGenerationFallback.js` 包含候选配置归一化和两套 generate/edit fallback，成功结果是单张 `image`。
- `console/server.js` 的 `buildImageGenerationPayload` 至 `runImageConfigsWithAttempts` 是另一套请求、解析、候选回退实现；`handleImageDraw` 另做配置选择、取消隔离、结果落盘，支持多张 `images`。
- BananaTool 还有聊天式 Gemini 生图兼容分支；不能统一 OpenAI images 接口时默默删除这条能力。

建议按以下子切片实施并验收；全部完成才宣告阶段 3：

| 子切片 | 具体源模块 | 目标和测试 |
| --- | --- | --- |
| 3A-1 纯协议与策略 | `utils/imageAspectRatio.js`、`imageDimensions.js`、`imageResult.js`、`imageSourcePolicy.js`、`imageTaskPolicy.js`、`imageRequestGuard.js` | 迁移严格 TS；解析入口接受 unknown；覆盖 9:16/自定义尺寸、损坏/截断/零尺寸图片、URL/base64/内容型结果 |
| 3A-2 配置候选与执行器 | `utils/imageGenerationFallback.js`；console 的 `runImageConfigsWithAttempts` | 抽统一多图 candidate executor，保留旧名称/展示名匹配兼容；取消必须立即结束整个候选链；测试 response_format 降级、明确指定渠道、全部失败、部分失败、超时、取消、attempt 渠道/model 信息 |
| 3A-3 请求与结果资源端口 | console 的生成/编辑 payload、multipart、fetch、materialize；BananaTool 的对应方法；`utils/multipartFormData.js` | 统一 OpenAI/Grok adapter 与单独 Gemini adapter；通过注入 transport/resource port 测试，不使用真实付费请求。校验输出宽高是正数而非仅判断对象存在 |
| 3A-4 双入口接通 | `BananaTool.performDraw` 和 console `handleImageDraw` | 两者调用同一 ImageService；QQ 适配器保留单图回复行为，HTTP 保留多图/历史记录；队列、发送、HTTP 状态码留在适配层；用真实 emitted ESM + fake provider 验证两入口的请求/结果一致 |
| 3B 模型网关 | `utils/modelGateway.js`、`utils/sideLLM.js`、`utils/providers/ThinkingProcessor.js`、`utils/visibleFailure.js`、`utils/chatFailureDiagnosis.js`、`utils/aiProviderProbe.js` 及调用点 | 有类型的聊天请求、reasoning 配置、渠道/model 错误来源；统一 429 余额与频率、401/503/空响应；覆盖 low/high/max 及不支持关闭思考的模型 |

首个小而安全的结构抽取为 **candidate executor + ImageRequest/ImageResult**，既复用已有 provider 配置，又真正接通 QQ/HTTP；它不是把整个 BananaTool 直接搬到 TS。

建议契约：`ImageRequest` 包含 operation、prompt、references、count、sizeIntent、quality、requestedProviderId；`ImageResult` 包含非空 images、每张已验证尺寸/资源引用、实际 providerId/model/displayName、attempts。AbortSignal 属于单次调用上下文，不能进持久任务 DTO。`ImageProviderPort` 只生成，不直接发送 QQ 或写控制台历史。旧单图 wrapper 可取第一张以保留现有调用语义，但多图结果不应在核心被丢弃。

既有回归：`imageAspectRatio`、`imageGenerationFallback`、`imagePromptAddress`、`consoleImageRegression`、`reasoningEffort`、`visibleFailure`、`consoleProviderCredentials`。其中源码截取/new Function 测试随模块抽取改正式 import，不能继续把旧代码片段当作新核心实现的证据。

## 阶段 4：配置写入只有一条业务路径

明确盘点四处：`core/config/configStore.js`、`utils/configWriter.js`、`model/config.js`、`console/server.js` 配置保存段；schemas 位于 `models/configSchemas/` 和 `models/Guoba/schemas/`；公共 HTTP 契约在 `console/lib/schemaConfig.js`、`providerCredentials.js`。

顺序：独立配置 DTO/运行时校验 → ConfigRepository（读取/修订号/条件保存/原子持久化）→ 将所有写入端接同一 repository → QQ 权限与 HTTP 身份分别适配 → 前端消费公共 DTO。不要用内存锁冒充两个进程写入互斥；必须以两个独立进程并发用例证明版本冲突或串行化有效。

必测旧未知字段保留、secret 掩码还原、空值含义、schema revision、并发冲突、写失败不破坏旧文件、备份恢复、两个进程看到相同 revision。思考开启/关闭/状态的主人/群主权限策略应为纯函数，机器人管理员或普通管理员身份不能自动获得群主权限。

## 阶段 5—8 的依赖批次

| 阶段 | 建议顺序 | 不能省略的边界 |
| --- | --- | --- |
| 5 | messagePipeline 的 envelope/queue/lease 状态 → redisJobStore/mediaArtifactStore → deliveryGateway/mediaOutbox → archive/转发与 runtime 装配 | 未知回执不能自动重试；发送后持久化前崩溃需显式不确定状态；400条按实际额外节点数拆批；config/data 路径与回滚兼容 |
| 6A | memory/engine 纯 entity/alias/conflict/boundary → redisStore → retriever/extractor/reflector → semanticMemory 与 midtermMemory → 各 Manager | 跨群/跨机器人身份与来源必须进入契约；不能把整个全局插件传给 TS 服务 |
| 6B | apps/lib 的提示词/路由纯策略 → 工具 registry/result 契约 → toolExecution → chatTurn → 主插件装配 | chatTurn import 面很大，应按端口逐步收缩；tool 成功仅来自真实回执；取消/并发/最终回复幂等 |
| 7 | games/knowledge/emoji → dice/group-admin → media 及其余 functions 工具 → console/lib → console 路由/装配 | 每域独立子阶段门槛；QQ/Yunzai 入口保留薄 JS 兼容；用户规则包与自定义 JS 工具不强迫迁移 |
| 8 | 清理双实现 → 全量 JS 清单逐项归零/登记例外 → 全量类型和边界 → 干净 release 构建/安装/更新/回滚 | 不把业务 JS 重新分类成 shim 来改善指标；编译后的 JS 不计迁移倒退；源码抽取测试清零；每个例外有具体理由 |

阶段报告必须记录实际 migration:report 输出，区分源码业务 JS 与编译产物；不能通过新增 TS 或把 JS 留在编译器 allowJs 下宣布完成。每阶段单独 commit 与回滚锚点，门槛失败不进入下阶段。
