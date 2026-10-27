# shiloh-plugin

> 基于 TRSS-Yunzai + NapCat 的 QQ 群聊 LLM Agent 平台

TRSS-Yunzai · OneBot v11（NapCat）· Node.js ≥ 22.12 · TypeScript 严格模式 · MIT

shiloh-plugin 不只是一个"能回话的聊天插件"。它把一个大模型 Agent 需要的对话编排、多层记忆、函数调用工具、消息可靠投递、群自动化管理和运营观测做成了一个完整平台，并在 23 个群、周消息 3.4 万条、峰值日 6,500+ 条的真实环境里持续运行。

本项目基于上游 shiloh-plugin（作者 Cat-bl）深度二次开发：业务代码已 100% 迁移到 TypeScript 严格模式并按领域分层重写，消息管道、语义记忆、Agent 调度、群管系统、控制台均为本仓库重新实现。与上游的关系见文末[致谢](#致谢与上游)。

## 目录

- [核心亮点](#核心亮点)
- [功能总览](#功能总览)
- [快速开始](#快速开始)
- [配置体系](#配置体系)
- [常用指令](#常用指令)
- [Web 控制台](#web-控制台)
- [独立功能插件](#独立功能插件)
- [架构概览](#架构概览)
- [开发与测试](#开发与测试)
- [使用建议](#使用建议)

## 核心亮点

### 1. 两级 LLM 调度，不靠正则瀑布路由

群聊 90% 的消息不需要 AI 回复。消息先经过轻量时机闸门（TimingGate）判断"是否值得回应"，命中后再由一次语义分类调用同时产出意图、工具选择和参考图角色规划，最后才交给主模型执行。无关消息不出成本，正则路由只作失败兜底。全链路有 `#观测日志` 流水和控制台"运行观测"页可查每次路由决策与模型耗时。

### 2. 三层记忆体系

- **长期记忆**：以群为作用域、以实体为中心的 Redis 结构化存储（用户实体、别名映射、用户事实、群事实）。AI 负责判断内容类型（明确教学 / 自我陈述 / 偏好 / 群共识 / 闲聊），代码负责边界、归一化和安全落库；工具输出与机器人回复不会污染记忆。事实积累后自动触发反思压缩，embedding 语义召回与近重复合并让"同一件事不会被写一百遍"。
- **语义记忆（RAG）**：直接在自己产出的群聊归档上建索引——按群滑窗分块，BM25（CJK bigram）与向量检索双路召回，RRF 融合后再用交叉编码器重排。实测 recall@10 达 94%，P50 检索延迟 386ms，且检索超时自动跳过、绝不阻塞回复。配套专属后台页：量化总览、检索游乐场、分块浏览器、评估历史。
- **中期记忆与画像**：会话摘要缓冲、情绪状态、人物画像自动注入上下文，让"上周聊过的那个游戏"和每个人的说话风格都能被想起。

### 3. 恰好一次的消息管道

QQ 事件处理内嵌了一套微型事件处理系统：Redis 任务存储（事件 / 投递两类 job）+ 按会话串行队列 + 租约锁防多实例并发 + 指数退避重试 + 启动恢复 + 媒体 outbox。进程重启不丢消息、不重复搬运；媒体发送失败可可靠重试。全量消息按群按天 NDJSON 归档，撤回事件幂等回写 `recalled` 标记，本地仍可查。

### 4. 40 个函数调用工具 + MCP 扩展

生图 / 修图 / 识图、联网搜索、网页解析、视频分析、音乐 / 视频 / Pixiv / Bing 图片搜索、思维导图、文本转图、Excel 工作簿、语音合成、提醒、聊天记录查询，以及禁言、戳一戳、点赞、@成员、送礼物等群互动工具。长任务工具可加 `(dedupe)` 防止重复触发。

支持标准 MCP（Model Context Protocol）：在 `config/mcp-servers.yaml` 声明 stdio / SSE 服务器，外部工具自动注入主模型，带自动重连与结果截断。

### 5. 海豹（SealDice）兼容骰娘

COC7 / DND 全套指令（`.r` `.ra` `.st` `.pc` `.sc` `.ri` `.log` 等约 85 条路由），牌堆、人物卡按群隔离、先攻、对抗、团录导出 txt/html、跑团期间 AI 对话自动静默。声明式 YAML 自定义规则包（运行时 2.0）支持自定义骰池、NPC、群共享状态、权限、战役 / 章节与快照——不执行任意 JavaScript，不接受自然语言触发跑团操作。扩展兼容层按 sealdice-core 源码逐项对齐语义。

### 6. 全自动群管理

入群答题验证（超时 / 答错可踢出）、广告与刷屏检测（10 条内置规则加权打分 + 广告语料库相似度 + 可选模型复审，提醒 / 撤回 / 禁言 / 踢出分级动作）、超长消息与连发消息自动折叠为合并转发、可配复合规则（连发条数 + 单条字数 + 总字数组合）、入群欢迎与退群通知。群管理员用 `.群管` 面板即可查看和修改本群策略，无需接触配置文件。

### 7. AI 主持的群游戏

海龟汤（AI 出题、主持、提示与投降、赛后评分，支持 AI 生成新题库存）、赛马娘养成竞速（属性、词条、训练、全局积分排行）、三角洲行动数据查询（今日密码、物品价值、价格曲线、改枪码）。游戏会话与主对话互相隔离，互不打断。

### 8. Web 管理控制台

独立 Vue 3 + TypeScript 控制台（默认 8787 端口），15 个页面覆盖机器人状态、群聊统计、群管策略、对话设置、人设绑定、AI 渠道、命令与骰子规则、语义记忆、自主仿真、消息管道、风控策略、运行观测、令牌与花费和生图工作台。配置保存带 revision 乐观锁、凭据脱敏读写、YAML 定点更新保留注释与无关字段。

### 9. 风控与表达质量

出站消息走审查 + 随机延迟 + 令牌桶限流；风控信号三级响应（记录失败码 → 管理群加急告警 → 低调模式加倍延迟）。回复侧有违禁词护栏、人设守护、思考过程转发开关、全局表达学习与风格反馈（`.希洛反馈`），长任务先发确认再后台执行，工具失败不向群里抛原始报错。

### 10. 工程质量

- 业务代码 100% TypeScript 严格模式（`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`），src 下 491 个 TS 文件按 domain / application / infrastructure 分层。
- `npm run test:boundaries` 用 AST 强制分层边界：纯路径禁止 IO、禁止引用 `Bot` / `redis` / `global` 等全局。
- 后端 1800+ 项、前端 30+ 项单测全绿；类型负例、发布产物加载合约、影子机器人 E2E（注入假 OneBot 客户端跑全链路，不污染真实群）。
- 发布包带逐文件哈希 manifest，支持校验、原子安装与自动回滚。

## 功能总览

| 能力域 | 说明 | 主要入口 |
| --- | --- | --- |
| 智能对话 | 时机闸门、语义意图路由、人设切换与群绑定、私聊支持、违禁词 | 群内自然聊天 + 触发前缀 |
| 自主仿真 | 仿真模式（按群启用）：AI 用工具自主读消息、连发、等待下文、自管唤醒/潜水，文本永不自动外发 | `.仿真 开` |
| 记忆 | 长期记忆、语义记忆 RAG、中期记忆、情绪与画像 | `#记忆状态`、`.语义记忆` |
| 知识 | 主人知识库、群知识（谁是谁 / 黑话） | `#知识库添加`、`#群知识` |
| 表情包 | 自动收集、VLM 打标、语义搜索斗图、入库双维审核 | `#表情包列表` |
| 工具 | 40 个函数调用工具，工具清单单一声明点 | `#tool <内容>` |
| MCP | 标准 MCP 服务器接入，工具注入主模型 | `#mcp 列表` |
| 骰娘 | COC7 / DND、牌堆、团录、YAML 规则包 2.0 | `.r`、`.骰规则` |
| 游戏 | 海龟汤、赛马娘、三角洲行动 | `.游戏`、`.赛马娘`、`.三角洲` |
| 群管理 | 入群验证、广告 / 刷屏、折叠、复合规则、通知 | `.群管` |
| 消息搬运 | B 站高清搬运（可扫码取会员）、抖音 / YouTube / Pixiv 卡片、磁链搜索 | `.高清搬运`、`.磁力搜索` |
| 聊天记录 | NDJSON 归档、撤回回写、关键词搜索、音乐提取 | `#查看群聊记录` |
| 风控观测 | 出站审查限流、三级风控响应、观测日志 | `#观测日志` |
| 运维 | 命令总表（121 条）、一键部署与回滚、Web 控制台 | `.命令`、`scripts/deploy.sh` |

## 快速开始

### 环境要求

- TRSS-Yunzai（自带 Redis，消息管道 / 记忆 / 统计依赖它）
- NapCat 或其他 OneBot v11 适配器
- Node.js ≥ 22.12
- Chromium（puppeteer 渲染兜底：QQ 信息卡片、抖音解析、文本转图；系统已有 Chromium 时可设 `PUPPETEER_SKIP_DOWNLOAD=true` 跳过下载）

### 安装

在 Yunzai 根目录执行（目录名必须是 `shiloh-plugin`，独立功能插件按相对路径引用它）：

```bash
git clone --depth=1 https://github.com/WoJiSama/shiloh-plugin.git plugins/shiloh-plugin
cd plugins/shiloh-plugin
npm install
npm run backend:build
```

TypeScript 编译产物 `dist/backend` 不随仓库分发，`npm run backend:build` 是必需步骤；构建带 manifest 校验，失败自动回滚旧产物。启动时如果产物缺失，插件会明确报错而不是静默降级。

首次启动自动创建 `config/` 目录。不要删除 `config_default/`（默认配置模板与命令总表）。

### 更新

项目已启用 TypeScript 编译发布，群内 `#bl更新` 自动更新已停用（不会拉取代码或重启服务）。维护者更新方式二选一：

```bash
# 手动：拉取 → 装依赖 → 重建 → 重启 Yunzai
git pull && npm install && npm run backend:build

# 或一键部署（先跑全量验收，再打包校验、原子安装、健康检查，失败自动回滚）
bash scripts/deploy.sh
```

### 最小可用配置

编辑 `config/message.yaml`：

```yaml
pluginSettings:
  enable: true
  enableGroupWhitelist: true
  allowedGroups:
    - 你的群号
  chatTriggerMode: strict
  triggerPrefixes:
    - 你的触发词

  chatAiConfig:
    chatApiUrl: "https://你的-openai-兼容-接口/v1"
    chatApiKey: "sk-..."
    chatApiModel: "..."
```

配好 `chatAiConfig` 即可聊天；要用工具再加 `toolsAiConfig`，要长期记忆再加 `memoryAiConfig`。重启 Yunzai 生效。

## 配置体系

### 三个配置入口

| 入口 | 覆盖范围 |
| --- | --- |
| Web 控制台（推荐） | 对话与权限、AI 渠道、人设、管道、群管策略、风控、骰子基础、追踪与记忆策略，带凭据脱敏和 revision 冲突保护 |
| `config/message.yaml` | 全量配置的持久化源，控制台即写此文件 |
| 锅巴面板 | 仅剩控制台未覆盖的字段（表情策略、语音、工具凭据、娱乐模块等），已迁移字段会拒绝保存并提示 |

### AI 模型配置

所有模型块都走 OpenAI 兼容接口，按需分角色配置，各块可指向不同供应商（自建网关 / Gemini / 火山 Ark 等）：

```yaml
trackAiConfig:      # 时机闸门 / 会话跟踪（建议小而快）
intentAiConfig:     # 语义意图与工具分类
toolsAiConfig:      # 工具调用模型
chatAiConfig:       # 主聊天模型
imageEditAiConfig:  # 修图 / 图生图
analysisAiConfig:   # 识图 / 截图分析
searchAiConfig:     # 联网搜索总结
memoryAiConfig:     # 记忆抽取与反思
embeddingAiConfig:  # 知识库与语义记忆召回（选稳定便宜的即可）
```

### 长期记忆

```yaml
pluginSettings:
  memorySystem:
    enabled: true
    saveStrictness: normal
    semanticRecallEnabled: true   # 语义召回需另配 embeddingAiConfig
    promptMaxGroupFacts: 6
    promptMaxEntityFacts: 6
    promptMaxChars: 1200
```

抽取有 debounce、攒批和群级最小间隔，刷屏不会打爆模型；失败静默降级不影响聊天。

### 工具开关

`pluginSettings.oneapi_tools` 控制暴露给模型的工具，长任务建议加 `(dedupe)` 防重复触发：

```yaml
oneapi_tools:
  - bananaTool(dedupe)
  - googleImageEditTool(dedupe)
  - googleImageAnalysisTool
  - searchInformationTool
  - textImageTool
```

### MCP 服务

编辑 `config/mcp-servers.yaml` 声明 stdio / SSE 服务器（连接与调用超时、结果截断、自动重连均可配），然后发 `#mcp 重载`。工具测试用 `#mcp 测试 <工具名> <JSON参数>`。

## 常用指令

完整命令总表（121 条，11 个模块）在群里发 `.命令` 查看，或读 [docs/commands.md](docs/commands.md)。高频指令：

```text
# 帮助与观测
.命令 / .帮助                # 命令总表菜单
#观测日志 [条数]              # 工具调用与路由决策流水

# 人设与表达
#人设列表 / #切换人设 <名称> / #人设绑定列表
#思考过程 开启|关闭
.希洛反馈 <意见>              # 对说话风格提意见

# 记忆
#记忆状态 / #我的记忆 / #群记忆
#搜索记忆 <关键词> / #删除记忆 <ID>
#清空我的记忆 / #禁用我的记忆
.语义记忆 状态|查询|评估|重建

# 知识与表情
#知识库添加|删除|列表|搜索|统计
#表情包导入|列表|删除|打标|统计|巡检

# 游戏
.游戏                        # 游戏中心（海龟汤等）
.赛马娘 / .三角洲

# 群管理
.群管                        # 本群群管面板（开关、规则、帮助）
.广告入库 <样本> / .广告样本 统计

# 搬运与记录
.高清搬运 <B站链接>
.磁力搜索 <关键词>
#查看群聊记录 [条数] / #搜索聊天记录 <关键词>
.音乐提取                    # 引用音乐卡片

# MCP
#mcp 状态 / #mcp 列表 / #mcp 测试 <工具> <JSON> / #mcp 重载
```

骰娘指令（`.r` `.ra` `.st` `.pc` `.coc7` `.dnd` `.ri` `.log` 等约 85 条）与自定义规则包见 [骰娘自定义规则接入指南](docs/dice-rules/骰娘自定义规则接入指南.md)。

## Web 控制台

控制台是独立 Koa + Vue 3 服务，安装、构建和环境变量详见 [console/README.md](console/README.md)：

```bash
npm --prefix console/frontend ci
npm --prefix console/frontend run build
npm run console:start    # 默认 0.0.0.0:8787
```

首次访问创建管理员账号（scrypt 密码哈希 + HttpOnly 会话）。页面分四组：日常运营（机器人 / 群聊 / 群管理）、机器人能力（对话 / 人设 / AI 模型 / 命令骰子 / 语义记忆）、消息与运行（管道 / 风控 / 观测）、创作工具（生图工作台）。

## 独立功能插件

`standalone/` 下有 7 个可选拆分插件：`bl-dice-plugin`、`bl-emoji-plugin`、`bl-games-plugin`、`bl-group-admin-plugin`、`bl-knowledge-plugin`、`bl-media-plugin`、`bl-memory-plugin`。它们是主插件领域代码的独立入口，**必须与主插件以兄弟目录形式共存**，配置仍读写同一份 `message.yaml`，不会双重注册命令：

```bash
bash scripts/deploy-standalone.sh [yunzai根目录]
```

拆分部署后对应命令只由独立插件加载。主插件更新后需重跑上面的脚本同步独立插件。

## 架构概览

```
src/
  contracts/        # 共用契约：DTO、端口（模型网关/回执/配置）、错误
  adapters/         # QQ / Yunzai / HTTP 平台适配，平台对象只在此转换
  modules/<域>/
    domain/           # 纯策略与值对象：零 IO、零全局、可独立测试
    application/      # 用例编排，依赖 domain 与端口
    infrastructure/   # 端口实现：Redis、模型网关、文件、SDK
```

22 个业务模块：conversation（对话编排）、memory（三层记忆）、tools / toolSupport / qqTools / content（工具体系）、messaging（消息管道与归档）、image（生图）、knowledge、emoji、dice、games、groupAdmin、media、rendering、models（LLM 网关）、platform（QQ / 多 bot 联邦 / 命令闸门 / 控制台服务）、config、runtime、host（Yunzai 装配）、foundation / shared（横切设施）。

构建产物为 `dist/backend`（带逐文件哈希 manifest，启动时校验）。根目录 `apps/`、`utils/`、`domains/`、`functions/` 等旧 JS 文件全部是登记在案的兼容薄壳，仅 re-export 编译产物，`npm run migration:report` 维护 366 条旧路径 → 新实现的映射并逐一校验。

## 开发与测试

| 命令 | 说明 |
| --- | --- |
| `npm run backend:typecheck` | 两个 tsconfig 严格类型检查 |
| `npm run backend:build` | 编译到 dist/backend（原子替换，失败回滚） |
| `npm test` | 全量测试：legacy + TS 测试一起编译执行（node:test） |
| `npm run test:boundaries` | AST 分层边界检查 |
| `npm run test:artifacts` | 发布产物加载合约测试 |
| `npm run migration:report` | 旧路径兼容层映射校验 |
| `npm run verify:phase` | 聚合以上全部 + 前端检查 / 测试 / 构建 |
| `npm run console:dev` … | 控制台开发 / 构建 / 检查 / 冒烟 |
| `npm run release:pack` / `release:verify` | 发布打包与校验（支持原子安装与回滚） |

自定义本地工具放 `custom_tools/`（不要改 `functions/functions_tools` 内置工具）：复制 `exampleTool.js.example`，实现 `func()`，把工具名加进 `oneapi_tools`，重启或改一次配置触发热更新。

## 使用建议

- 先配 `chatAiConfig`，跑通聊天后再逐个加 `toolsAiConfig`、`memoryAiConfig`，最后开 `semanticRecallEnabled`。
- `trackAiConfig` / `intentAiConfig` 选快而便宜的模型，闸门延迟直接决定群里"像不像人在看消息"。
- 群聊量大的群调大记忆抽取的 debounce 与最小间隔，避免频繁调用模型。
- 生图、修图、识图分开配模型，不要共用一个慢模型；长任务工具都加 `(dedupe)`。
- 部署到生产建议走 `npm run verify:phase` + `release:pack` 流程，产物带校验、可回滚。

## 致谢与上游

本项目源自上游 shiloh-plugin（作者 Cat-bl），感谢上游提供的 Yunzai 插件结构与初始能力。本仓库随后完成了 TypeScript 全量迁移、分层重写、消息管道、语义记忆、控制台等大规模重构，代码组织与运行方式已与上游不同；上游原有能力请以上游文档为准。只需要原版插件的用户建议直接使用上游仓库。

## 许可证

MIT
