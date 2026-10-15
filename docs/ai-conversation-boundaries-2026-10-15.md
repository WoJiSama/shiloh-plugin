# 群聊目标、工具边界与正常拒绝（2026-10-15）

已发布运行版本 `900a5cb`。本轮修复了明确聊天决策被工具兜底覆盖、工具刷新扩大在途回合能力，以及输出守卫改坏正常句子的问题。**真实模型对照未证明整体自然度提升：按完整会话评审，基线为14通过／3失败／13不确定，候选为12通过／4失败／14不确定。** 本次交付是确定的执行契约与输出改写错误修复，不能据此宣称机器人已经整体更机灵。

## 最新样本与实施范围

本次检查时，群 `609235590` 最新合并转发时间为2026年10月15日11:48:32，消息ID为 `269173264`，转发ID为 `7696736494952455350`。群归档与既有NapCat只读接口均完整返回3个节点。其他模型面对夸张点餐、要求从第三方钱包付款的请求，先简短拒绝，再围绕付款反差接话。这是竞品正面参考，不能当作我们线上同题失败的证据；“没有手机”也不应固化为本机人设事实或通用拒绝台词。

原始群记录只留在受限临时目录，仓库回放使用合成身份、消息和任务记录。未发送QQ测试消息，未通过测试执行真实工具、下单或支付，未写生产记忆。私有 `message.yaml`、人设库及自定义 `systemContent` 保持原值，发布前后配置哈希一致。

## 根因与修改

1. **明确不执行被当成规划缺失。** 原代码将语义 `{intent: 'chat'}` 丢为 `null`，后续又可能依据词语补出工具。漏调守卫还会拼接用户正文与模型回复，从全局工具集新增动作。离线复现中，即便本轮明确不用搜索、模型已拒绝，仍可生成搜索调用；这不是已证实的生产误调用事件。现在明确聊天决定贯穿归一化、路由、计划、分发和补召；`null` 只表示决策不可用或置信度不足。补召仅修复本轮已选择的同一能力，不能凭正文承诺新增工具。严格钱包入口的独立授权核验保留。
2. **工具定义和执行范围可能在等待中变化。** 注册表刷新会重填在途 `session.tools`，其他消息可能因此重新打开本轮已关闭的调用范围。现在回合入口保留初始工具集，路由使用独立会话，计划完成后固定 `executionTools`。主模型请求、原生及文本工具分发、补召、真实执行器、识图后搜索和工具续轮统一使用该快照；新回合清除旧决策与旧快照。保留已准入的识图加搜索组合、仅存在于会话中的MCP别名及实际schema、MCP续页。
3. **输出守卫会直接破坏语法与指代。** 真实基线中，“替你订这话我不能应。”被改为“替你订这话这个我不太适合直接这样做。应。”；“人家哥哥的钱包”被改为“人家你的钱包”。已停用旧硬拒绝替换与默认拒绝片段删除，亲昵称呼仅处理明确的当前直接呼语，保留亲属、第三人、引用与代码。真实输出管道和管理器回归验证以上原句保持不变。配置页旧拒绝开关标记停用，旧字段兼容读取，默认YAML只补兼容说明，不改私有实例配置。
4. **整句目标、能力和证据边界不足。** 前置规划复用现有正文、引用、转发来源及本轮实际工具定义；公共提示要求依据当前完整目标、能力和授权判断，不擅自把预约或交易换成搜索、提醒，不为做不到的动作收集无助信息。`too_hard`反馈允许自然简短拒绝，只有帮助当前目标时才提出替代建议。未核验的转述保持未确认，不能反向断言群主从未说过。提示约束仍可能被生成模型违背，见下方失败样本。

主要实现位于 [semanticToolIntent](../src/modules/tools/infrastructure/semanticToolIntent.ts)、[turnPlan](../src/modules/conversation/infrastructure/turnPlan.ts)、[chatTurn](../src/modules/tools/infrastructure/chatTurn.ts)、[toolExecution](../src/modules/tools/infrastructure/toolExecution.ts)、[toolSkills](../src/modules/tools/domain/toolSkills.ts) 和 [personaFeedbackManager](../src/modules/memory/infrastructure/personaFeedbackManager.ts)。没有加入品牌特判、固定俏皮话或回复替换模板。

## 固定模型对照与审阅结果

冻结场景为 [conversation-boundary-scenarios.json](../tests/fixtures/conversation-boundary-scenarios.json)，SHA-256为 `3f3c1074c37784948f2db60dce821b7cc68d7a17890ea6c53c999a017843254e`。6组场景每组5个独立完整会话，每版本30会话、65轮，共130轮。后续轮使用模型实际上一回复；两版runner、场景、私有配置、人设、各轮生成参数分布和3个场景进程并发均匹配。未固定seed和实际时钟，不能作严格因果归因或延迟结论。

主回放禁用工具执行，前置意图使用桩，QQ和存储适配器均在内存中。它验证生成输出，不证明真实工具路由、生产提醒触发或QQ投递。已有提醒依据是合成的已核验记录。工具契约另由编译主链回归验证，真实前置分类器的可用性单独披露。

基线 `a00fdd3` 与候选业务版本 `c62ad84` 各65次 `glm-5.3` 请求全部HTTP200，无降级或运行异常。基线2轮被guard改写，候选0轮。两版各保留5个引用续轮kind结构失败：冻结场景期望 `conversation`，既有分类返回 `banter`，对应进程退出1；未改标签，也未直接将标签差异计作语义失败。

评审按完整会话分别评价四个维度，允许通过、失败、不确定和不适用，不计算混合总分。由当前代理和未参与实现的子代理审阅，未经过外部真人评审。

| 维度 | 基线 | 候选 |
| --- | --- | --- |
| 执行真实性 | 30通过 | 30通过 |
| 既有提醒范围 | 5通过、25不适用 | 5通过、25不适用 |
| 当前目标与归属 | 29通过、1不确定 | 29通过、1不确定 |
| 自然度 | 14通过、3失败、13不确定 | 12通过、4失败、14不确定 |

**本批自然度计数较差，未达到整体自然度提升验收。** 相同场景与样本序号的描述性对照中，失败转通过与通过转失败各1；失败转不确定1、不确定转通过2、通过转不确定4、不确定转失败2。它们不合成为“净提升”，相同序号也不是固定随机种子的因果配对。

候选4个自然度失败均保留完整输出和上下文：

- 第三方钱包场景sample-1：要求拍成品照片却说“下单前拍”，并另起索图任务。
- 第三方钱包场景sample-4：仍无依据断言群主没在群里说过，且语气训话。
- 认真询问能力场景sample-1：重复询问用户已给出的时间与人数。
- 引用讨论场景sample-5：模型原生句法、指代混乱。

其余14个不确定会话与额外风险逐项保留在评审中。0次guard改写不等于0个坏句子；确定性回归证明旧守卫不再改坏两条原文，但不能把随机重新生成的质量全部归因于该修复。

正式基线前还发生过一次准备失败：误用缺少前端受管文件的旧runtime，完整性校验提前退出，配置快照未建立，所有场景初始化失败，没有发出模型请求。随后从线上manifest完整复制1919个文件，使用新label生成正式基线；原失败摘要保留，不计入65轮，也没有覆盖原证据。

证据：[基线全部输出](replays/2026-10-15-boundaries/baseline.json)、[候选全部输出](replays/2026-10-15-boundaries/candidate.json)、[基线评审](replays/2026-10-15-boundaries/baseline-review.json)、[候选评审](replays/2026-10-15-boundaries/candidate-review.json)、[逐会话对照](replays/2026-10-15-boundaries/comparison-review.json)、[冻结输入与完整性](replays/2026-10-15-boundaries/comparison-integrity.json)、[冻结判据](replays/2026-10-15-boundaries/frozen-review-rubric.json)、[准备失败摘要](replays/2026-10-15-boundaries/initialization-failure-summary.json)。

## 前置意图模型仍有可用性缺口

独立影子harness固定9组场景、每组3次，使用合成搜索、提醒和MCP schema，禁止工具执行、QQ发送和生产存储。两版各27次 `deepseek-v4-flash` 请求均8秒超时，**共54次没有获得有效分类决策**。原参数和显式关闭thinking的两次独立最小诊断也各45秒超时。

这证明当前前置模型可用性有问题，不能计成54个语义误判，也不能宣称它已正确区分预约、提醒和讨论。未因此擅改线上provider或超时配置。编译主链对明确聊天、能力快照和执行边界的回归通过，不能替代真实分类器验证。

证据：[分类器完整性](replays/2026-10-15-boundaries/classifier-comparison-integrity.json)、[基线27次](replays/2026-10-15-boundaries/baseline-tool-decisions.json)、[候选27次](replays/2026-10-15-boundaries/candidate-tool-decisions.json)、[独立诊断](replays/2026-10-15-boundaries/intent-provider-diagnostic.json)、[harness](replays/2026-10-15-boundaries/tool-boundary-shadow.mjs)。

## 发布门禁、版本对应与线上核验

业务修复提交为 `c62ad84f81c589aeef7533deaa619aaefcaefe69`；最终发布提交为 `900a5cb0d945c594da4d4e7b3b54fc4d3252a97b`，后者仅修改 `tests/conversationRoutingRegression.test.js`。首次完整 `scripts/deploy.sh` 在本地门禁被拦截：2041项中2037通过、2项宿主音乐集成跳过、2项旧源码字符串断言失败，尚未进入服务器安装。已将旧实现形状断言改为编译TurnPlan与真实网关的可选表情、知识回复行为检查，44项定向通过，未削弱执行边界，也未跳过发布门禁。

最终完整发布门禁：后端2041项，2039通过、2项宿主音乐集成跳过、0失败；前端34项全部通过。严格类型、模块边界、前后端构建、release包与远端stage校验均通过。业务提交前113项定向回归通过，原工作区写回后122项定向回归通过且无跳过。

**发布包并非与候选所有文件逐字节相同。** Vite注入版本和构建时间 `__CONSOLE_BUILD__`，重新构建会改变前端chunk文件名、内容及index引用；backend manifest仅改变commit字段。候选与发布清单的并集有40个路径差异，包括旧、新生成文件名，不是40个业务源文件变更。全部470个后端运行JS、backend manifest的files与sources，以及除前端生成物和backend manifest外的受管内容均与候选一致。未为测试提交重新抽样模型；前端由最终构建、测试和页面检查独立验证。

上线后核验时：1919个受管文件全部匹配最终发布manifest，完整后端运行树和runner匹配冻结候选；`trss-yunzai`、`bl-console`均active、`NRestarts=0`，本次启动加载错误0、MessagePipeline启动1次，两页面HTTP200。审计时间为2026年10月15日12:51:45（北京时间），这是当次运行态快照。

回滚快照：`/opt/trss-yunzai-backups/deploy-snapshots/20261015-124852`，对应发布前运行版本 `a00fdd3`。本次没有修改私有配置。后续文档证据提交不重新部署，不改变线上运行版本。

证据：[最终门禁汇总](replays/2026-10-15-boundaries/validation-summary.json)、[代码等价性](replays/2026-10-15-boundaries/release-code-equivalence.json)、[上线审计](replays/2026-10-15-boundaries/post-deploy-audit.json)、[最终部署日志](replays/2026-10-15-boundaries/deployment.log.gz)、[完整测试日志](replays/2026-10-15-boundaries/deploy-phase-tests.log.gz)、[首次失败日志](replays/2026-10-15-boundaries/deploy-phase-attempt1-tests.log.gz)。上线审计中的 `expectedManifestMatches=false` 是与c62候选构建比较的预期差异；`mismatches=[]` 才是已安装文件对最终发布清单的完整性结果，两者不能混淆。

## 原工作区交付与剩余问题

原工作区起始128个dirty文件先行备份，本轮23个业务／验收文件按原值核对后安全写回。113个不属于写回目标或本轮规划的起始dirty文件哈希均未改变；写回目标还包含起始时干净或不存在的文件，不能将23与113直接相加作为起始文件总数。全部470个TS源码与隔离分支一致，写回后构建成功，122项定向回归全过，470个编译JS与候选全部一致。原工作区HEAD仍为 `de03521`，暂存区保持为空，没有在原工作区提交或重置其他改动。

证据：[改动保全审计](replays/2026-10-15-boundaries/preservation-audit.json)、[写回验证日志](replays/2026-10-15-boundaries/writeback-validation.log.gz)。早期 [写回预检](replays/2026-10-15-boundaries/writeback-preflight.json) 记录22个目标；最终增加1个验收测试，实际23个目标以保全审计为准。

后续需优先解决前置模型的响应可用性，再用真实分类器验证目标判断和工具选择。生成质量仍需处理重复追问、多余建议和无依据群历史断言，继续使用完整多轮对照，不能用固定笑话或输出替换遮蔽。前轮已知温度判断、未登记未来投递承诺，以及Reminder附加动作的创建／触发边界，本轮没有扩展解决，也不因工具边界回归通过而视为已验收。

脱敏证据共37个文件（含索引），[evidence-index.json](replays/2026-10-15-boundaries/evidence-index.json) 记录每份来源SHA和导出SHA。仅替换私有人设称呼与模型端点，保留全部合成回放、失败、不确定判定和两次发布门禁记录；未纳入原始群记录、私有配置、人设全文或原始模型请求。
