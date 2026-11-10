# 角色影子回放验收

候选证据 SHA256：`7016f184fcddf3899ab584a4aacc43b2517aa7c6992aa064bed5ece52aebe317`

模式：live_model。阶段 7：**待真实群观察与部署验证**。

| 项目 | 结果 |
| --- | --- |
| 证据完整性 | passed |
| 工程执行 | passed |
| 本事件行为检查 | passed |
| 实模样本 | passed |
| 对照条件 | pending |
| 人工评审 | pending |

事件 2/2；失败 0；跳过 0；行为未达 0。

模型调用 8，HTTP 请求 8，已报告 tokens 106806，usage 缺失 0；金额未知。

离线或注入模型只能证明工程行为。工程通过不能替代自然度、跨天稳定性或真实群体验验收；本工具不自动判定阶段 7 完成。

阅读候选 results.json 中每个样本的完整输入、输出、工具调用/结果与前后状态，然后填写 review.json 的 reviewer、verdict 和 comment，再使用 --review 生成新目录。不得把脚本输出作为实模体验。

## 样本

| 样本 | 事件数 | 人工结论 |
| --- | --- | --- |
| opinion-revision:sample-1 | 2 | pending |

真实群跨天观察、打扰反馈、实际费用、暂停/回退和部署状态仍须提供独立证据。
