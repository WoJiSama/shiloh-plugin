# 安全基线与威胁模型（SECURITY BASELINE）

> 维护规则：**改动了任何一条边界所描述的代码，必须在同一个提交里更新本文对应条目。**
> 发布前检查清单见文末。最后全面复核：2026-10-26。

## 一、威胁模型

| 主体 | 能力假设 | 主要防线 |
| --- | --- | --- |
| **QQ 群友**（含陌生群成员） | 可发任意文本/图片/表情/戳一戳；可诱导模型（prompt injection）；可刷屏 | 群白名单、工具面裁剪、发送白名单（仿真工具目标绑定会话群）、出站脱敏与审查、频率限制 |
| **被注入的模型**（上游返回被诱导的输出） | 可尝试输出内部路径/凭据/工具参数 JSON；可尝试在仿真回合越权发送 | internalStatusLeak 出站脱敏（含凭据形状）、工具参数 JSON 硬拦截、发送配额与冷却、模型文本永不自动外发（仿真） |
| **控制台用户** | 拿到控制台访问权后可改配置、看统计、管理仿真 | scrypt 账密 + 长令牌、revision 乐观锁、建议绑定 127.0.0.1/内网、凭据脱敏读写 |
| **同机其他进程/用户** | 可读插件目录与 Redis | Redis 由 TRSS 宿主管理；config 明文 key 的残余风险见 R2 |
| **MCP server / custom_tools**（第三方扩展） | 任意代码执行能力（stdio 子进程/热加载 JS） | 仅 master 手工部署；不随包分发；工具结果截断 8000 字符 |
| **上游 provider**（LLM/搜索/embedding/VLM） | 收到发过去的全部内容 | 见「数据出机清单」，逐项可关 |

明确**不防**：腾讯侧风控（靠出站节流降低概率）、宿主机被完全攻破、上游 provider 滥用数据。

## 二、已实现边界（按攻击面）

1. **准入**：群白名单 `enableGroupWhitelist/allowedGroups`（默认开）；用户黑名单；私聊白名单（空=仅主人）；`#` 命令与仿真流互斥；违禁词命中即中断该群进行中回合（入站+出站双向）。
2. **工具面**：
   - 主链路：`oneapi_tools` 全局白名单 + 按消息意图过滤 + 路由锁（toolScopeLocked）；私聊默认零工具（仅表情可开）。
   - 仿真回合：装配期只挂 sim 工具 + `simulation.extraTools` 白名单——**不在清单里的工具模型物理上不可见**（注册期裁剪，qq-bridge 铁律）。
   - 仿真发送工具参数无群号：目标绑定会话群，不存在"发到别的群"的路径；每回合 ≤5 条 + 每分钟 ≤8 条 + 出站令牌桶三重限速。
   - MCP：`config/mcp-servers.yaml` 手工声明，工具结果截断；custom_tools 同理。
3. **出站内容**：
   - `internalStatusLeak` 片段级脱敏（内部路径/堆栈/日志标签/协议 JSON/**凭据形状 sk-/AKIA/JWT/赋值形态**；占比>30% 或剩余<6字 heavy 整条回退）——挂在 `sanitizeFinalReplyText` 统一出口（群聊/私聊/转图路径全覆盖）+ 仿真 `simSendMessage` 发送前同源调用。
   - 工具参数形状 JSON（`looksLikeToolArguments`）主链路按行丢弃、仿真整批拒绝——同源唯一实现于 replySanitizer。
   - 违禁词出站拦截 + censor 双级词表（outboundThrottle，适配器层兜底）。
   - 仿真模型文本**永不自动外发**（reserved2 语义），发言只能走发送工具。
4. **控制台**：scrypt 账密 + cookie 会话/长令牌；配置写走 configRepository（revision 乐观锁 + 原子写 + 自动备份）；API key 脱敏读写。
5. **秘密与落盘**：`config/message.yaml` 明文 key（R2）；`console-users.json` scrypt；仿真状态/记忆/好感度/初始提示词存 Redis（`shiloh:sim:*`）；令牌账本 `data/token_usage/*.ndjson`（只有计数与金额，无聊天内容）；情节记忆/归档 NDJSON 在插件 data 目录。
6. **调度与预算**：仿真唤醒限频（2/min、12/h）+ 每群每日 40 回合 + **每日金额预算（默认 ¥5，读令牌账本）**，超限强制沉默当日不再唤醒；`TURN_BUSY_LEASE` 防并发回合。
7. **网络出机**（safe fetch 类）：`fetchImageBase64` 限 http(s)/2MB/15s；webParser/searchInformation 沿用各自实现的 SSRF 防护；梗提取**只喂群内消息给 LLM、不联网**。

## 三、数据出机清单（谁收到了什么）

| 目的地 | 什么数据 | 默认 | 怎么关 |
| --- | --- | --- | --- |
| **LLM provider**（chatAi/toolsAi/trackAi/intentAi/memoryAi/taskAi 等全部渠道） | 群/私聊消息文本、注入的记忆/人格/梗/好感度摘要、（识图/仿真看图时）图片 | 开 | 清空各渠道配置即停用对应功能 |
| **embedding provider** | 语义记忆文本块（群聊归档内容） | 开（语义记忆启用时） | 关 memorySystem/semanticMemory |
| **VLM（analysisAi）** | 表情包图片（入库打标）；主链路识图图片 | 开 | 关 emojiSystem / 识图工具 |
| **搜索 provider**（searchInformation/webParser；`simulation.extraTools` 放通后仿真回合也可用） | 搜索关键词（可能含群聊内容里的线索） | 开 | 从 oneapi_tools / simulation.extraTools 移除 |
| **令牌账本** | 仅计数/模型名/金额，**不出机**（本地 NDJSON） | — | — |
| **梗提取（memoryAi 渠道）** | 近 40 条群消息文本（发给小模型判定） | 开（simulation.meme.enabled） | `simulation.meme.enabled: false` |

> 向群友披露"消息会被 AI 处理"时，应一并考虑上表前四行。

## 四、已知残余风险

- **R1** 出站拦截是启发式（正则形状），精心构造的绕过可能漏拦；heavy 兜底保证"宁可少说不可泄密"。
- **R2** `config/*.yaml` 中 API key 明文存放（同机读权限者可见）。
- **R3** `custom_tools/` 与 MCP server 是任意代码执行面，信任边界=部署者本人。
- **R4** 上游 provider 对发过去的内容的留存与使用不受本插件控制。
- **R5** 仿真 extraTools 放通的工具继承其自身实现的安全性（如搜索的关键词出网）。

## 五、发布前检查清单

1. `npm run verify:phase` 全绿（typecheck + boundaries + 全量测试 + 控制台前后端检查）。
2. 改过出站/工具边界 → `node --test tests/replySanitizer.test.js tests/simulationDomain.test.js` 单独复跑。
3. 新增数据出机目的地 → 同步「数据出机清单」表。
4. 改过仿真安全相关 → 冒烟（假 Redis/假模型）确认零外发路径无回归。

## 六、改动检查单（每个涉及边界的 PR 自问）

- 新工具进入哪个白名单？仿真回合要不要放通？
- 新的数据离开本机了吗？进清单了吗？能关吗？
- 新的出站路径过 `sanitizeFinalReplyText` / `simSendMessage` 的脱敏与拦截了吗？
- 新的定时器/后台任务有预算与频率上限吗？
