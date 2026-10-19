# 工具可靠性评测交付记录（2026-10-19）

本次固定 118 个场景，包含 8 类工具各 12 个正例（共 96 个）及 22 个回答/澄清负例。每个场景回放 6 种模型结果，共 708 次。评测器复用真实路由、语义规划器解析、曝光过滤、TurnPlan 与模型请求构建；模型响应在离线模式固定注入。

“路由到达”指正确工具已进入直调路径，或其 schema 出现在实际会发送给模型网关的初始请求中。直调跳过主模型请求，不重复统计为曝光。该指标不证明下游模型消费了 schema、执行器成功执行或最终答复正确。

## 可复核版本

- before 来自任何业务修复前冻结的完整 `dist/backend`；只把最终评测器脚本编译到该快照，所有业务导入仍解析旧业务代码。
- before/after 使用完全相同的 fixture 与 evaluator；CLI `--compare` 强制核验这两项 SHA。

| 校验项 | before | after |
| --- | --- | --- |
| manifestSha256 | `26130fda83a20733edafa538340fb4419f0b78154ba4298da55f19aa0158761d` | `00efd5812bab4d9cbee3243101753242b072ec8df5c5db9f9a2378f195781ddc` |
| sourcesSha256 | `eba0f71d2b4a88c44ef4dd984c9679d86143d107f4fe7a7e8802a1e0a6d159f5` | `6b52255a5440751b461a6114d0f9c53164052fb9cdae9dc5abe5b88d49d71954` |
| fixtureSha256 | `df90d74445e4f1566f260a5dbbcef6f2cc29c5a45d7641b8c96682e67ace457e` | `df90d74445e4f1566f260a5dbbcef6f2cc29c5a45d7641b8c96682e67ace457e` |
| evaluatorSha256 | `0ede5dc5550cfb31144910e22813dd0f30206e1f5290c992b48015a425d09f12` | `0ede5dc5550cfb31144910e22813dd0f30206e1f5290c992b48015a425d09f12` |

完整逐场景、逐环节状态保存在 [before](tool-exposure-before.json)、[after](tool-exposure-after.json)，包括 `pass/drop/bypass/n/a`、候选/过滤/计划/请求工具、直调参数与失败位置。`bypass` 和 `n/a` 不计入环节丢分分母。

## 分支汇总

| 模型分支 | 路由到达 before → after | 已生成调用的标注参数正确 before → after | 负例误直调 before → after | 负例曝光 before → after |
| --- | --- | --- | --- | --- |
| 固定正确工具输出 | 96/96 → 96/96 | 96/96 → 96/96 | 2/22 → 0/22 | 10/22 → 4/22 |
| 固定明确聊天输出 | 24/96 → 36/96 | 12/12 → 24/24 | 2/22 → 0/22 | 10/22 → 4/22 |
| 低置信度 | 43/96 → 75/96 | 21/22 → 34/34 | 4/22 → 0/22 | 13/22 → 10/22 |
| 超时 | 43/96 → 75/96 | 21/22 → 34/34 | 4/22 → 0/22 | 13/22 → 10/22 |
| 未配置 | 43/96 → 75/96 | 21/22 → 34/34 | 4/22 → 0/22 | 13/22 → 10/22 |
| 无效输出 | 43/96 → 75/96 | 21/22 → 34/34 | 4/22 → 0/22 | 13/22 → 10/22 |

固定正确工具输出把金标工具/已标注参数注入模型边界，用于验证框架能否接纳正确决定；这一列不是模型准确率。固定明确聊天分支用于检查框架如何尊重/旁路无动作决定，也不是普通流量准确率。低置信度结果先按生产 host 适配变成 null；超时、未配置、无效输出分别衡量规则兜底。

## 分工具到达率

| 工具 | 正确输出 | 明确聊天 | 低置信度 | 超时 | 未配置 | 无效输出 |
| --- | --- | --- | --- | --- | --- | --- |
| memberInfoTool | 12/12 → 12/12 | 0/12 → 12/12 | 0/12 → 12/12 | 0/12 → 12/12 | 0/12 → 12/12 | 0/12 → 12/12 |
| chatHistoryTool | 12/12 → 12/12 | 0/12 → 0/12 | 0/12 → 12/12 | 0/12 → 12/12 | 0/12 → 12/12 | 0/12 → 12/12 |
| searchInformationTool | 12/12 → 12/12 | 0/12 → 0/12 | 4/12 → 4/12 | 4/12 → 4/12 | 4/12 → 4/12 | 4/12 → 4/12 |
| deltaForceTool | 12/12 → 12/12 | 0/12 → 0/12 | 10/12 → 12/12 | 10/12 → 12/12 | 10/12 → 12/12 | 10/12 → 12/12 |
| searchMusicTool | 12/12 → 12/12 | 0/12 → 0/12 | 1/12 → 5/12 | 1/12 → 5/12 | 1/12 → 5/12 | 1/12 → 5/12 |
| sendLocalEmojiTool | 12/12 → 12/12 | 12/12 → 12/12 | 12/12 → 12/12 | 12/12 → 12/12 | 12/12 → 12/12 | 12/12 → 12/12 |
| reminderTool | 12/12 → 12/12 | 0/12 → 0/12 | 4/12 → 6/12 | 4/12 → 6/12 | 4/12 → 6/12 | 4/12 → 6/12 |
| githubRepoTool | 12/12 → 12/12 | 12/12 → 12/12 | 12/12 → 12/12 | 12/12 → 12/12 | 12/12 → 12/12 | 12/12 → 12/12 |

每格为 before → after。成员与历史工具覆盖提升来自候选注册、准确目标解析和候选工具保留；不会因为增加全部工具曝光就把错误工具算到达。

## 原标记留出样本

fixture 标记了 16 个工具正例和 8 个负例为 `holdout`，另外 80 个工具正例与 14 个负例为回归样本。原标记 holdout 已用于本轮诊断，因此下表只提供该子集的透明统计，不能称为未见样本的泛化成绩。下一轮泛化评估需要另外收集尚未用于修改规则的真实样本。

| 工具/正例组 | 正确输出 | 明确聊天 | 低置信度 | 超时 | 未配置 | 无效输出 |
| --- | --- | --- | --- | --- | --- | --- |
| memberInfoTool（原holdout） | 2/2 → 2/2 | 0/2 → 2/2 | 0/2 → 2/2 | 0/2 → 2/2 | 0/2 → 2/2 | 0/2 → 2/2 |
| chatHistoryTool（原holdout） | 2/2 → 2/2 | 0/2 → 0/2 | 0/2 → 2/2 | 0/2 → 2/2 | 0/2 → 2/2 | 0/2 → 2/2 |
| searchInformationTool（原holdout） | 2/2 → 2/2 | 0/2 → 0/2 | 0/2 → 0/2 | 0/2 → 0/2 | 0/2 → 0/2 | 0/2 → 0/2 |
| deltaForceTool（原holdout） | 2/2 → 2/2 | 0/2 → 0/2 | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 |
| searchMusicTool（原holdout） | 2/2 → 2/2 | 0/2 → 0/2 | 0/2 → 1/2 | 0/2 → 1/2 | 0/2 → 1/2 | 0/2 → 1/2 |
| sendLocalEmojiTool（原holdout） | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 |
| reminderTool（原holdout） | 2/2 → 2/2 | 0/2 → 0/2 | 1/2 → 2/2 | 1/2 → 2/2 | 1/2 → 2/2 | 1/2 → 2/2 |
| githubRepoTool（原holdout） | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 |
| regression 正例合计 | 80/80 → 80/80 | 20/80 → 30/80 | 36/80 → 62/80 | 36/80 → 62/80 | 36/80 → 62/80 | 36/80 → 62/80 |
| holdout 正例合计 | 16/16 → 16/16 | 4/16 → 6/16 | 7/16 → 13/16 | 7/16 → 13/16 | 7/16 → 13/16 | 7/16 → 13/16 |

负例包含未定指代、同名成员、缺少执行条件、工具缺失、显式否定、只讨论能力、转述与引用。误直调与曝光分开统计：曝光可以包含可选 emoji，不能据此认定模型实际误调用。最终回答/澄清是否正确没有被离线回放测量。

## 参数与剩余漏检

参数仅在已经生成直调时，将 fixture 标注字段与实际调用参数逐项严格比较；未生成调用的曝光记录为 `unmeasured`，不放进正确率分母。未标注字段、提醒时间换算、工具返回值与外部数据真实性都不在该参数分数中。`--strict` 对已生成调用的标注参数错误和负例误直调非零退出。

固定正确模型输出的 96 个工具正例均到达，已生成调用的标注参数均通过比较。

未配置模型时仍未到达的正例（不能由离线规则改善推导“所有问法已解决”）：

| 工具 | 场景 | 文本 | 最终失败位置 |
| --- | --- | --- | --- |
| searchInformationTool | `searchInformationTool-05` | 这会儿上海下不下雨 | `filter` |
| searchInformationTool | `searchInformationTool-06` | 现在美元换人民币啥价 | `filter` |
| searchInformationTool | `searchInformationTool-07` | 最近AI有什么新闻 | `filter` |
| searchInformationTool | `searchInformationTool-08` | 周末杭州会下雨不 | `filter` |
| searchInformationTool | `searchInformationTool-09` | 这个政策现在还有效吗 | `filter` |
| searchInformationTool | `searchInformationTool-10` | 他说的消息是真是假，联网核实一下 | `filter` |
| searchInformationTool | `searchInformationTool-11` | 眼下英超比分多少 | `filter` |
| searchInformationTool | `searchInformationTool-12` | 最近的台风到哪儿了 | `filter` |
| searchMusicTool | `searchMusicTool-01` | 播放周杰伦的晴天 | `filter` |
| searchMusicTool | `searchMusicTool-03` | 搜索陈奕迅的十年 | `filter` |
| searchMusicTool | `searchMusicTool-05` | 整首晴天听听 | `filter` |
| searchMusicTool | `searchMusicTool-07` | 放一首夜曲吧 | `filter` |
| searchMusicTool | `searchMusicTool-08` | 帮我点个告白气球 | `filter` |
| searchMusicTool | `searchMusicTool-09` | 刚才那首是晴天，放一下 | `filter` |
| searchMusicTool | `searchMusicTool-12` | 给大伙放个青花瓷 | `filter` |
| reminderTool | `reminderTool-04` | 帮我设置一个今晚八点吃药的提醒 | `filter` |
| reminderTool | `reminderTool-05` | 过五分钟喊我起来 | `filter` |
| reminderTool | `reminderTool-07` | 到九点提醒一下交日报 | `filter` |
| reminderTool | `reminderTool-08` | 晚上八点别让我忘记吃药 | `filter` |
| reminderTool | `reminderTool-09` | 他说明天下午三点开会，帮我加个提醒 | `filter` |
| reminderTool | `reminderTool-10` | 查一下我还有哪些提醒 | `filter` |

## Live 模型沙箱

已实际执行限量 CLI，覆盖 12 个目标明确、上下文指代、歧义与否定场景。读取本机 `config/message.yaml` 的 `pluginSettings`，意图/工具/聊天模型均没有完整的可用配置，意图分类器、语义规划器与可选主模型共 36 个阶段均明确标记 `skipped`。没有网络模型请求、工具执行或 QQ 消息。详情见 [live记录](tool-exposure-live.json)。

live 路径对意图分类器按生产逻辑整块选择后端，对规划器按生产逻辑逐字段回退，输出模型 ID、耗时与分类/文字决定/工具决定/原生工具调用形态；配置中的 key/endpoint 不写入报告。主模型是无执行能力的 schema 沙箱，无法替代完整生产上下文或后端降级观测。

## 复现

```sh
node scripts/tool-exposure-eval.mjs --summary --strict --compare docs/evals/tool-exposure-before.json --json docs/evals/tool-exposure-after.json
node --test tests/toolExposureEvalCore.test.js
npm run trace:report -- <trace文件或目录>

node scripts/tool-exposure-eval.mjs --live --main-model --summary --modes unavailable \
  --scenario memberInfoTool-02,memberInfoTool-05,chatHistoryTool-05,searchInformationTool-05,deltaForceTool-04,searchMusicTool-05,reminderTool-05,githubRepoTool-01,negative-01,negative-03,negative-09,negative-11 \
  --json docs/evals/tool-exposure-live.json
```

不带参数的 `node scripts/tool-exposure-eval.mjs` 输出全部明细与按工具/环节丢分表。脚本先校验源码和构建产物；缺失/过期时自动构建，避免误评旧 dist。`--modes`、`--scenario` 可缩小范围。`--live` 默认只请求意图分类器/规划器；加 `--main-model` 请求主工具模型，但不会 dispatch 任何工具。

评测器核心定向测试 13/13 通过，包括：确定性成功旁路、低信 host 适配、配置缺失、工具不可见、负例误直调分母、参数未测、live只调用模型、脱敏、部分配置的两种回退策略。全量工程检查由主线补充记录。

## 证据范围

- 离线结果证明的是路由策略、参数传递与故障兜底行为，不能证明真实模型对所有口语都能正确理解。
- 历史查询读取实际接入的当前会话缓存并返回词面命中证据；它不是完整历史或长期记忆的统一检索引擎。
- 已有证据能否进入最终提示、工具结果是否如实表达、无结果是否保持未确认，需要主线运行回放与执行器回归另外验证。
- 本轮没有修改 planner 文字采信和自动后端降级策略，模型网关入口之后的实际 schema 消费尚未在线验证。
- 没有真实模型配置时，不能声称 live 模型召回率、在线耗时或最终回答质量已经改善。
