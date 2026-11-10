# 角色影子回放验收

候选证据 SHA256：`99cb0274db90f14a031215427fadc7c1c92486879e2a67579427b22fdb119699`

模式：scripted_offline。阶段 7：**待真实群观察与部署验证**。

| 项目 | 结果 |
| --- | --- |
| 证据完整性 | passed |
| 工程执行 | passed |
| 本事件行为检查 | passed |
| 实模样本 | pending |
| 对照条件 | pending |
| 人工评审 | pending |

事件 56/56；失败 0；跳过 0；行为未达 0。

模型调用 60，HTTP 请求 0，已报告 tokens 0，usage 缺失 60；金额未知。

离线或注入模型只能证明工程行为。工程通过不能替代自然度、跨天稳定性或真实群体验验收；本工具不自动判定阶段 7 完成。

阅读候选 results.json 中每个样本的完整输入、输出、工具调用/结果与前后状态，然后填写 review.json 的 reviewer、verdict 和 comment，再使用 --review 生成新目录。不得把脚本输出作为实模体验。

## 样本

| 样本 | 事件数 | 人工结论 |
| --- | --- | --- |
| social-refusal:sample-1 | 2 | pending |
| social-refusal:sample-2 | 2 | pending |
| motivated-goal-restart:sample-1 | 3 | pending |
| motivated-goal-restart:sample-2 | 3 | pending |
| opinion-revision:sample-1 | 2 | pending |
| opinion-revision:sample-2 | 2 | pending |
| ambient-and-idle:sample-1 | 5 | pending |
| ambient-and-idle:sample-2 | 5 | pending |
| failed-search-honesty:sample-1 | 2 | pending |
| failed-search-honesty:sample-2 | 2 | pending |
| workspace-version:sample-1 | 2 | pending |
| workspace-version:sample-2 | 2 | pending |
| subscription-update-dedup:sample-1 | 3 | pending |
| subscription-update-dedup:sample-2 | 3 | pending |
| independent-reflection:sample-1 | 3 | pending |
| independent-reflection:sample-2 | 3 | pending |
| worker-success-artifact:sample-1 | 2 | pending |
| worker-success-artifact:sample-2 | 2 | pending |
| worker-unknown-pause:sample-1 | 3 | pending |
| worker-unknown-pause:sample-2 | 3 | pending |
| permission-boundary:sample-1 | 1 | pending |
| permission-boundary:sample-2 | 1 | pending |

真实群跨天观察、打扰反馈、实际费用、暂停/回退和部署状态仍须提供独立证据。
