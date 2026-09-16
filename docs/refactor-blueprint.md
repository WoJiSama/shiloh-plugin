# bl-chat-plugin 究极重构蓝图

> 状态：待主人审阅 ｜ 起草：2026-09-16 ｜ 决策已定：monorepo 多插件 + 共享 core；sealdice 走 JS 语法兼容层；命令总表先行（已落地）

## 一、为什么重构

- **单插件巨石化**：20+ app 入口、120 个 utils、22 个配置域挤在一个插件里；`apps/test.js` 8688 行承载了主聊天 agent 与全部共享设施。
- **功能是"补丁摞补丁"**：每个新功能直接往主文件加正则和分支，意图路由是硬编码瀑布，谁也不敢动谁。
- **智能体问题**：skill 调用不稳、回复路径多路并发互相不知情、失败链路经过模型会跑偏（泳装图事件三连：路由漏判 → 真人头像误挂 → 失败回复变承诺）。
- **命令无总账**：91 条命令散落 12 个文件，主人无法一处查看和编辑。

## 二、目标架构（monorepo 多插件 + 共享 core）

```
bl-chat-plugin/                      # 仓库根（保持一个 git 仓库）
├── core/                            # 共享内核（普通 ES 模块包，非 Yunzai 插件）
│   ├── config/                      # 配置加载/热更/合并（message.yaml 拆分后的家）
│   ├── session/                     # 会话状态、redis 封装、群上下文
│   ├── pipeline/                    # 消息捕获、合并、可靠发送（消息管道）
│   ├── ai/                          # AI 路由：多后端选择、重试、失败分类、超时
│   ├── intent/                      # 统一意图层（替代正则瀑布，见 §四）
│   └── platform/                    # Yunzai 适配（event、segment、发送回执）
├── plugins/                         # 每个域一个独立 Yunzai 插件（锅巴自然分页）
│   ├── chat/                        # 主聊天 agent（人设、表达、节奏）
│   ├── memory/                      # 长期记忆 + 群知识 + 表达学习
│   ├── group-admin/                 # 群管理 + 守卫 + 通知 + 广告语料
│   ├── dice/                        # 骰子（含 sealdice 语法兼容层）
│   ├── media/                       # B站搬运 + YouTube + 磁链 + 音乐提取
│   ├── games/                       # 赛马娘 + 三角洲
│   ├── emoji/                       # 表情包
│   ├── knowledge/                   # 知识库
│   └── archive/                     # 聊天归档 + 记录查询
├── config/commands.yaml             # 命令总表（已落地，热更新）
├── docs/commands.md                 # 自动生成的命令文档（已落地）
└── tests/                           # 全仓测试（保持现有 660+ 用例基线）
```

**关键约束**：
- 每个插件可独立禁用/部署/回滚；`config/commands.yaml` 的 `src` 字段即迁移地图。
- `core` 不依赖任何插件；插件之间不互相 import（跨域交互只走 core 或消息事件）。
- 配置从单一 `message.yaml` 拆为各插件自己的配置文件，提供一次性迁移脚本。

## 三、分阶段计划（每阶段结束都可部署、可回滚）

| 阶段 | 内容 | 风险 | 验收 |
| --- | --- | --- | --- |
| **P0 护栏**（已完成大半） | 测试基线 660+ 用例；服务器侧备份脚本化；部署 checklist 文档化 | 低 | CI 上全绿（除 2 个环境用例） |
| **P1 命令总表**（✅ 本次落地） | `commands.yaml` + `CommandHelp` 插件 + 文档生成 | 低 | `.命令` 可用，81 条全覆盖 |
| **P2 抽 core** | 从 test.js 剥离：配置/会话/管道/AI路由 → `core/`；test.js 引用 core，行为不变 | 中 | 全量测试绿 + 线上一周无回归 |
| **P3 域迁移**（逐域进行） | 顺序建议：knowledge → emoji → games（uma/deltaforce）→ dice → media → group-admin → memory → chat | 中 | 每域迁移后独立插件运行 3 天+原有测试通过 |
| **P4 agent 重做** | 统一意图层 + 工具清单 + 出站消息仲裁（详见 §四） | 高 | 泳装图类事件回放全过 |
| **P5 sealdice 兼容层** | JS 移植骰句语法：`.r/.ra/.rh/.st/.deck/.setcoc` 等 + COC/DND 模板，接现有 DiceRulePack | 中 | sealdice 标准骰句用例集回放一致 |

## 四、Agent 重做要点（P4，对应"不智能"）

1. **统一意图层**：现在一段话要过 15+ 组正则瀑布（TOOL_INTENT/IMAGE_*/EMOJI_*/...），漏一个就静默降级。改为：单一 `classifyIntent(text, context)` 入口 + 模型兜底（快速模型），所有正则降级为快速路径而非唯一裁决。
2. **工具清单与契约**：每个工具声明能力（触发词、输入 schema、超时、失败文案），skill 注册统一走 manifest；调用失败一律直发预制事实文案（泳装图教训：已知事实不进模型）。
3. **出站消息仲裁**：一个回合的所有出站消息（正文/承诺/工具结果/失败跟进）过同一个有序队列，工具结果未决时不许发承诺类文案。
4. **可观测性**：每个回合输出一条结构化 trace（意图→路由→工具→耗时→结果），出问题不用翻 journalctl。

## 五、sealdice 兼容层设计（P5）

- 范围：骰句语法（`.r 1d100+5`、`.ra 属性 值`、暗骰 `.rh`、奖池 `.deck`）、COC7/DND5e 成长与检定模板、人物卡 `.st` 的最小实现（属性存取）。
- 不做：sealdice 的多平台接入、云端牌堆同步、UI。
- 落点：`plugins/dice/sealdice/` 语法解析器（纯函数，重点单测）+ 现有 `DiceRulePackManager` 之上的一层官方语法包。参考实现逐条对照 sealdice-core 的 `dice/rollvm` 测试样例移植。

## 六、风险与原则

- **线上机器人不停机**：每阶段小步部署 + 观察 3 天；出问题回滚单个插件而不是整个仓库。
- **配置迁移**：写 `scripts/migrate-config.mjs`（message.yaml → 各插件配置），迁移前后 diff 报告。
- **不重写而搬迁**：P3 各域的 utils 基本原样搬目录 + 改 import，逻辑不动；重写只发生在 P4 意图层。
- **回滚锚点**：服务器上每次部署前 `cp -r plugins/bl-chat-plugin plugins/bl-chat-plugin.bak-<stage>-<date>`（沿用现有习惯）。

## 七、当前完成项

- ✅ 命令总表：`config_default/commands.yaml`（11 模块 81 条，热更新）
- ✅ `.命令 / .命令 <模块> / .命令 导出` 帮助插件：`apps/CommandHelp.js`
- ✅ 文档生成：`docs/commands.md` + `scripts/gen-commands-doc.mjs`
- ✅ 单测：`tests/commandRegistry.test.js`
- ✅ P2 切片一（2026-09-16）：`core/intent/messageIntent.js`——31 组意图模式常量 + 24 个纯分类函数从 apps/test.js 迁出（325 行），test.js 8688→8363 行；行为由 `tests/messageIntentCore.test.js` 锁定；已部署线上观察无回归
- ⏸ core/config 抽取：推迟到 P3 拆第一个功能域时一并做（现在只有 test.js 一个消费方，提前抽只会多一层无意义转发）
- ✅ 命令管理页（2026-09-16）：`utils/commandsWebApp.js` 挂载在 Yunzai express 上（`/bl-chat/commands`），网页表格化增删改查命令表，令牌鉴权（`config/commands-web.json`），保存即热生效并同步 docs/commands.md；端到端验证（改/读/还原/非法拒绝）通过
- ✅ 锅巴跳转（2026-09-16）：锅巴页面右下角常驻「📖 命令管理」悬浮按钮（注入 Guoba index.html，升级锅巴后需重新注入，备份在 Guoba 目录）；管理页顶栏有「返回锅巴」
- ✅ P3 切片一（2026-09-16）：core/config/configStore.js（配置加载/深合并/热更内核，onChange 解耦）+ knowledge 域迁至 `domains/knowledge/`（app/Searcher/Expander，apps/knowledge.js 变加载入口）；线上热更与插件加载验证通过
- ✅ P3 切片二（2026-09-16）：emoji 域迁至 `domains/emoji/`（app/EmojiPackManager/emojiSelection，apps/EmojiPackImport.js 变加载入口；根 index.js 的表情收集器与 SendLocalEmojiTool 改引域路径）；线上零报错验证通过
- ✅ P3 切片三（2026-09-16）：games 域迁至 `domains/games/{uma,deltaforce}/`（含渲染器与 model 模板，DeltaForceTool 改引域路径）；锅巴跳转按钮升级为**守卫注入**（`utils/guobaJumpLink.js`：启动检查 + 文件监听，锅巴升级重写后自动补回，模拟升级实测通过）
- ✅ P3 切片四（2026-09-16）：media 域——B站高清搬运从 MessageManager 拆出为独立 app（`domains/media/bilibili/`，插件数 36→37）+ 磁链搜索迁至 `domains/media/magnetsearch/`（含渲染器与 model）；音乐提取/音乐卡片转发暂留 MessageManager（与去重状态耦合，待 chatlog 域拆分时处理）；dice 域按主人决定推迟到 sealdice 集成（P5）一并做
- 📌 搬迁经验：迁 renderer 时 Yunzai lib 路径按目录深度 = `../../../../../lib/puppeteer/puppeteer.js`（3 层域目录），已踩两次，后续域直接用
- ✅ P3 切片五（2026-09-16）：group-admin 域——守卫（增删查）/通知（增删）/广告语料共 6 app + 6 manager 迁至 `domains/group-admin/`；mentionTargets 因骰子共用留在 utils
- ✅ P3 切片六（2026-09-16）：memory 域——情感/长期记忆/表达学习/人物画像 5 个 manager + engine 子包（原 utils/memory 15 模块）迁至 `domains/memory/`；test.js 与 ForgetGroupKnowledgeTool 改引域路径；线上 37 插件零报错
- ⏸ 剩余：chat 域（test.js 主文件拆分 + 记忆命令规则外迁）与 P4 agent 重做绑定执行，动工前需主人确认设计取舍
- ✅ P4 前置（2026-09-16）：①记忆与表达 17 条命令从 test.js 拆出为 `domains/memory/commandsApp.js`（经 `core/runtime/sharedRuntime.js` 取共享 memoryManager，test.js 减负约 700 行）；②回放测试集 `tests/agentReplay.test.js`（泳装星野/画一个星野/骂街接梗/防误判边界 4 用例）；③主人已定：意图层采用**全模型判定优先**（正则仅保留精确命令直配与模型故障降级）
- ⚠️ 事故记录（2026-09-16 13:12-13:21）：批量脚本误写 GoogleAnalysisTool.js 致主聊天 9 分钟未加载。教训：①多文件 python 批量改写必须逐文件独立缓冲并 diff 校验；②部署健康检查的 grep 必须覆盖「载入插件错误/插件加载超时/ERRO」等 Yunzai 实际用词，不能只搜 ERROR/Cannot find；③每次部署后必须确认主聊天处理链（SmartSkip/触发合并）有新日志
- ✅ P4 切片一·影子模式（2026-09-16）：`core/intent/modelIntentClassifier.js`——全模型意图判定器（14 类意图、严格 JSON、6s 超时、失败即 unavailable 走正则兜底）+ 影子统计（等价类合并一致率、分歧采样）+ `.意图影子` 主人命令。**已在 test.js 并行运行但不影响任何行为**；分类模型独立配置 `intentAiConfig`（线上指向 DeepSeek，避开 terra 高延迟）。下一步：攒 1-2 天分歧数据 → 修复高频分歧 → 切换为主判定
- ⏭ 待定分叉：多插件物理拆分（siblings 目录）需要先解决部署/`#bl更新` 流程——当前以"单部署根 + domains/ 逻辑分域"推进，不阻塞后续域迁移
