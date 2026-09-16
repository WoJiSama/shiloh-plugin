# shiloh-plugin 个人改造版

> 本项目借鉴并基于 [Cat-bl/shiloh-plugin](https://github.com/Cat-bl/shiloh-plugin) 做二次改造。
>
> 这里不是上游项目的官方文档，也不是通用发行版说明。这个仓库主要记录我在原项目基础上，为自己的 TRSS Yunzai + NapCat 环境做了哪些重构、增强和定制。

## 项目定位

上游项目已经提供了 Yunzai 插件结构、OneAPI/工具调用框架、触发模式、本地工具、表情包等基础能力。本仓库的 README 不再重复说明这些原有能力，而是重点说明这个分支实际改动过的部分。

当前改造重点：

- 重构 Redis 长期记忆存储，不再把聊天内容混在一个大文本里。
- 用实体、别名、用户事实、群事实、元信息拆分记忆结构。
- 优化 embedding 语义召回和去重，让相关记忆更容易被取出来。
- 把记忆抽取、保存、召回、prompt 注入拆成更清晰的管线。
- 减少工具输出、系统消息、机器人回复、低价值闲聊污染长期记忆。
- 优化长任务期间的回复体验，避免用户不知道任务是否开始或是否卡住。
- 整理锅巴配置入口，让记忆相关参数更容易调。
- 清理仓库中的硬编码敏感信息，改成通过配置或环境变量注入。

当前只按我的环境维护：

- TRSS Yunzai
- NapCat
- Node.js 插件环境
- OpenAI 兼容接口 / Gemini / 火山 Ark 等模型服务按配置接入

其他 Yunzai 分支、适配器或部署方式没有保证。

## 和上游的关系

上游 [Cat-bl/shiloh-plugin](https://github.com/Cat-bl/shiloh-plugin) 是本仓库的基础来源。上游已有能力仍然以原项目为准，本仓库主要是在其基础上继续维护个人化改造。

如果你想找更通用的原版说明，请优先看上游项目。

## 我主要做了什么

以下内容根据本仓库 git 记录整理，重点覆盖 `memory`、Redis 存储、embedding 召回、上下文注入、记忆配置、图像任务体验和敏感信息清理相关提交。

### 1. Redis 记忆结构重构

原来的长期记忆更接近“把聊天内容抽取后塞进一段记忆”。现在改成以群为作用域、以实体为中心的结构化 Redis 存储。

核心 Redis key：

```text
ytbot:mem:g:<groupId>:entities
ytbot:mem:g:<groupId>:alias
ytbot:mem:g:<groupId>:facts
ytbot:mem:g:<groupId>:meta
```

主要改造：

- `entities` 存用户实体、别名、用户事实和事实来源。
- `alias` 单独存别名到 QQ 的映射，支持同一个人多个称呼。
- `facts` 单独存群事实、群共识和群内长期状态。
- `meta` 存群记忆开关、用户 opt-out、抽取失败次数等运行状态。
- 写入前会做 slim 化，避免旧字段、临时字段、过大的运行时对象继续膨胀 Redis。
- 旧记忆和新结构隔离，降低历史脏数据污染新召回链路的概率。

相关文件：

- `utils/MemoryManager.js`
- `utils/memory/redisStore.js`
- `utils/memory/entityModel.js`
- `utils/memory/constants.js`

### 2. 记忆分类和写入边界

这次重构的重点不是“代码决定一切”，而是让 AI 负责判断内容类型，代码只负责边界、归一化和安全落库。

抽取结果会被路由成几类：

- `explicit_teaching`：用户明确教机器人记住某个称呼、关系或事实。
- `self_statement`：用户对自己的稳定描述。
- `user_preference`：用户偏好、习惯、长期倾向。
- `group_consensus`：群内共识、长期约定、共同背景。
- `ordinary_chat`：普通闲聊，不写长期记忆。

代码侧主要做这些事：

- 只接受结构化 JSON 结果，解析失败就放弃写入。
- 过滤工具结果、系统提示、机器人输出、空消息和低信号文本。
- refs 只保留纯数字 QQ，避免模型幻觉出无效引用。
- 群记忆抽取只允许写入群事实或教学型别名，避免把无主语用户事实乱写给别人。
- 支持用户关闭自己的记忆写入。
- 支持按群禁用长期记忆。

相关文件：

- `utils/memory/extractor.js`
- `utils/memory/boundary.js`
- `utils/memory/conflictResolver.js`

### 3. Embedding 语义召回和去重

`embeddingAiConfig` 现在不仅服务知识库，也可以用于长期记忆的语义召回和近重复合并。

主要改造：

- 用户事实和群事实可以补 embedding。
- 召回时如果有 query embedding，会优先按语义相似度排序。
- 没有 embedding 或模型失败时，自动降级为置信度、权限和时间排序。
- 通过 `semanticDupCosine` 合并语义上高度相近的事实，减少“同一件事写很多遍”。
- 对 embedding 失败保持静默降级，不影响正常聊天。
- 增加 embedding 单测，覆盖向量归一化、相似度排序和去重阈值。

相关配置：

```yaml
memorySystem:
  semanticRecallEnabled: false
  semanticDupCosine: 0.92

embeddingAiConfig:
  embeddingApiUrl: ""
  embeddingApiKey: ""
  embeddingModel: ""
```

相关文件：

- `utils/memory/embeddings.js`
- `utils/memory/retriever.js`
- `utils/MemoryManager.js`
- `tests/memory/embeddings.test.js`

### 4. 上下文记忆注入

记忆不是只负责“存”，还要在回复前把真正相关的内容注入 prompt。

主要改造：

- 回复前读取 speaker 自己的记忆。
- 解析消息里提到的人，召回被提及对象的相关记忆。
- 注入群事实和别名提示。
- 支持 pending/time-sensitive 信息，让“几天后”“上周”“某天”等时间信息能参与上下文。
- 用 `promptMaxChars`、`promptMaxGroupFacts`、`promptMaxEntityFacts` 控制注入长度。
- 空记忆不注入，避免污染主 prompt。

相关配置：

```yaml
memorySystem:
  promptMaxGroupFacts: 6
  promptMaxEntityFacts: 6
  promptMaxChars: 1200
  recallMaxMentionedEntities: 3
```

相关文件：

- `utils/memory/mentionResolver.js`
- `utils/memory/retriever.js`
- `utils/MemoryManager.js`
- `apps/test.js`

### 5. 记忆反思和压缩

为了避免 Redis 里长期积累重复、冲突、过期事实，新增了反思整理链路。

主要改造：

- 用户实体事实达到阈值后，可以触发实体级反思。
- 群事实达到阈值后，可以触发群级反思。
- 反思产物标记为 `origin: reflection`，和直接抽取的事实区分。
- `origin: config` 的事实不会被反思覆盖，避免配置锚点被模型改写。
- 反思失败静默降级，不影响原始记忆写入。

相关配置：

```yaml
memorySystem:
  reflectEntityThreshold: 12
  reflectGroupThreshold: 30
```

相关文件：

- `utils/memory/reflector.js`
- `utils/MemoryManager.js`
- `tests/memory/reflector.test.js`

### 6. 抽取节流、批处理和刷屏保护

群里有人连续刷消息时，记忆系统不能每条都跑一次模型。

主要改造：

- 用户记忆支持 debounce。
- 用户消息支持攒批后统一抽取。
- 群记忆支持最小抽取间隔。
- 群记忆支持最大批处理条数。
- 抽取失败会记录 failureCount，方便状态诊断。
- 增加内存队列，避免同一个群的记忆读写并发互相覆盖。

相关配置：

```yaml
memorySystem:
  userExtractDebounceSeconds: 8
  userExtractMaxBatchMessages: 5
  groupExtractMinIntervalMinutes: 10
  groupExtractMaxBatchMessages: 12
```

相关文件：

- `utils/MemoryManager.js`
- `utils/memory/stats.js`
- `tests/memory/manager.test.js`

### 7. 记忆管理指令

为了能在群里直接检查和纠错，补齐了记忆管理入口。

常用指令：

```text
#记忆状态
#我的记忆
#群记忆
#搜索记忆 <关键词>
#删除记忆 <记忆ID>
#清空我的记忆
#清空群记忆
#禁用我的记忆
#启用我的记忆
```

这些指令主要用于：

- 查看当前群记忆是否开启。
- 看自己的事实和别名。
- 搜索群事实。
- 删除错误记忆。
- 清空当前群的记忆 Redis key。
- 关闭或恢复自己的记忆写入。

### 8. 图像任务和长文本体验修正

这部分不是上游能力本身的说明，而是围绕实际群聊体验做的修正。

主要改造：

- 生图、修图、识图等长任务开始前先发一条自然确认，避免用户以为没响应。
- 长任务放到后台执行，减少生成图片时阻塞后续聊天。
- 图像需求会尽量补足引用消息、近期上下文和指代内容。
- 对敏感图像需求先做含蓄化、全年龄化表达，再决定是否继续调用工具。
- 工具失败、审核拦截、上游超时等情况不直接暴露原始 API 报错。
- 长文本转图支持更适合阅读的羊皮纸样式和正文/口头补充分离。

相关文件：

- `functions/functions_tools/BananaTool.js`
- `functions/functions_tools/GoogleImageEditTool.js`
- `functions/functions_tools/GoogleAnalysisTool.js`
- `functions/functions_tools/TextImageTool.js`
- `apps/test.js`

### 9. 配置整理和敏感信息清理

主要改造：

- 记忆配置集中到 `memorySystem` 和锅巴记忆页。
- 模型配置继续使用 `memoryAiConfig`、`embeddingAiConfig` 等独立块。
- 移除仓库里的硬编码第三方 API key、cookie 和 session。
- 视频分析、ModelScope、小红书等运行时凭据改为配置或环境变量读取。
- README 只保留配置入口，不写任何真实密钥。

相关文件：

- `config_default/message.yaml`
- `models/Guoba/schemas/memory.js`
- `models/Guoba/schemas/aiModels.js`
- `functions/functions_tools/VoiceTool.js`
- `functions/functions_tools/VideoAnalysisTool.js`
- `functions/functions_tools/xiaohongshu/config/config.js`
- `utils/apiClient.js`

## 快速安装

在 Yunzai 根目录执行：

```bash
git clone --depth=1 https://github.com/WoJiSama/shiloh-plugin plugins/shiloh-plugin
cd plugins/shiloh-plugin
pnpm install
```

如果你想安装上游原版，请使用：

```bash
git clone --depth=1 https://github.com/Cat-bl/shiloh-plugin plugins/shiloh-plugin
```

首次启动会自动创建 `config` 文件夹。

不要删除：

- `config_default/`
- `config_default/message.yaml`
- `config_default/mcp-servers.yaml`

运行时主要改：

- `config/message.yaml`
- `config/mcp-servers.yaml`

## 推荐使用锅巴配置

本仓库配置项较多，建议用锅巴改配置。

在 Yunzai 根目录执行：

```bash
git clone --depth=1 https://gitee.com/guoba-yunzai/guoba-plugin.git ./plugins/Guoba-Plugin/
pnpm install --filter=guoba-plugin
```

重启 Yunzai 后，发送：

```text
#锅巴登录
```

打开锅巴面板后，可以在 Web UI 里管理本插件的大部分配置。

## 常用指令

### 插件管理

```text
#bl更新
#bl强制更新
#对话插件更新
#对话插件强制更新
#全局方案添加白名单群组 <群号>
#全局方案删除白名单群组 <群号>
#清除群聊记录
```

### MCP 管理

```text
#mcp 重载
#mcp 状态
#mcp 列表
#mcp 测试 <工具名> <JSON参数>
```

### 记忆管理

```text
#记忆状态
#我的记忆
#群记忆
#搜索记忆 <关键词>
#删除记忆 <记忆ID>
#清空我的记忆
#清空群记忆
#禁用我的记忆
#启用我的记忆
```

### 知识库管理

```text
#知识库添加 <知识内容>
#知识库删除 <关键词>
#知识库列表 [页码]
#知识库搜索 <文本>
#知识库清空
#知识库统计
```

### 表情包管理

表情包能力主要来自原有系统，这里只保留常用入口，具体能力以代码和上游文档为准。

```text
#表情包导入
#表情包列表 [页码]
#表情包预览 [hash前缀]
#表情包删除 [hash前缀]
#表情包封禁 [hash前缀]
#表情包解封 [hash前缀]
#表情包打标 [hash前缀]
#表情包统计
#表情包重载
#表情包巡检
#表情包清空 [确认]
```

## 关键配置入口

### 基础对话

```yaml
pluginSettings:
  enable: true
  allowedGroups: []
  chatTriggerMode: strict
  triggerPrefixes:
    - 你的触发词
```

### 模型配置

常用模型配置块：

```yaml
trackAiConfig:        # 会话跟踪 / Gate 判断
toolsAiConfig:        # 工具调用模型
chatAiConfig:         # 普通聊天模型
imageEditAiConfig:    # 修图 / 图生图
analysisAiConfig:     # 识图 / 截图分析
searchAiConfig:       # 联网搜索总结
memoryAiConfig:       # 记忆抽取和反思
embeddingAiConfig:    # 知识库和语义记忆召回
```

### 长期记忆

```yaml
memorySystem:
  enabled: true
  saveStrictness: normal
  semanticRecallEnabled: true
  promptMaxGroupFacts: 6
  promptMaxEntityFacts: 6
  promptMaxChars: 1200
```

开启长期记忆至少需要配置：

- `memoryAiConfig`

如果要用语义召回，还需要配置：

- `embeddingAiConfig`

### 图片生成 / 修图 / 识图

```yaml
imageEditAiConfig:
  imageEditApiUrl: ""
  imageEditApiKey: ""
  imageEditApiModel: ""

analysisAiConfig:
  analysisApiUrl: ""
  analysisApiKey: ""
  analysisApiModel: ""
```

图像相关工具会根据消息自动选择：

- 文字画图：`bananaTool`
- 修图 / 图生图：`googleImageEditTool`
- 看图 / 分析截图：`googleImageAnalysisTool`

### 工具列表

`oneapi_tools` 控制暴露给模型的工具。

执行时间长的工具可以加 `(dedupe)`：

```yaml
oneapi_tools:
  - bananaTool(dedupe)
  - googleImageEditTool(dedupe)
  - videoAnalysisTool(dedupe)
  - textImageTool
  - googleImageAnalysisTool
  - searchInformationTool
  - webParserTool
```

`(dedupe)` 只用于防止同一用户重复触发同一个长任务，模型看到的工具名仍然是不带后缀的原名。

### 自定义骰娘规则包

开启 `diceSystem.customRulesEnabled` 后，主人可以导入声明式 YAML 规则包，群管理员再按群启用具体版本。规则运行时 2.0 支持自定义骰点与成功骰池、按群隔离人物卡、角色目标、NPC、群共享状态、权限、可恢复私密结果、对抗、团录审计、战役/章节/记录、团务历史与快照、先攻、持续状态、可执行物品/技能事件、自动群名片请求、版本迁移/回滚和中文句号命令，不执行任意 JavaScript，也不接受自然语言触发跑团操作。

完整字段说明、表达式语法、权限、固定命令、操作步骤和四个可导入范例见 [自定义骰娘规则包教程](docs/dice-rules/骰娘自定义规则接入指南.md)。

## 自定义本地工具

不要直接改 `functions/functions_tools` 里的自带工具。自定义工具放这里：

```text
plugins/shiloh-plugin/custom_tools/
```

步骤：

1. 复制 `custom_tools/exampleTool.js.example`。
2. 修改类名、`this.name`、`description`、`parameters`。
3. 实现 `func()`。
4. 在 `config/message.yaml` 的 `oneapi_tools` 里加入工具名。
5. 重启，或修改一次配置触发热更新。

## 项目内文件速查

```text
apps/test.js
  主对话入口、触发逻辑、工具选择、最终回复清理、会话追踪。

functions/functions_tools/
  本地工具目录。生图、修图、识图、文字转图、搜索、提醒等都在这里。

utils/MemoryManager.js
  记忆系统门面，负责提取、保存、召回、反思和 prompt 组装。

utils/memory/
  记忆重构后的核心模块，包括 Redis 存储、抽取路由、embedding、召回和反思。

models/Guoba/schemas/
  锅巴配置 schema。

config_default/message.yaml
  默认配置模板。

config_default/mcp-servers.yaml
  MCP 服务默认配置模板。
```

## 使用建议

- 先把 `chatAiConfig` 和 `toolsAiConfig` 配好，再开工具。
- 长期记忆先配 `memoryAiConfig`，确认抽取稳定后再打开 `semanticRecallEnabled`。
- `embeddingAiConfig` 优先选稳定、便宜、延迟低的模型；只要召回质量够用，不必一开始就上最贵模型。
- 群聊量大的群建议调大 `userExtractDebounceSeconds` 和 `groupExtractMinIntervalMinutes`，避免频繁抽取。
- 生图、修图、识图建议分别配适合的模型，不要所有任务共用一个慢模型。
- 长任务工具建议加 `(dedupe)`，防止群里连续刷同一个请求。
- 如果你只想要原版插件，建议直接使用上游 [Cat-bl/shiloh-plugin](https://github.com/Cat-bl/shiloh-plugin)。

## 维护说明

这个 README 主要面向我自己的改造版，内容会优先描述本仓库的设计目标和改造主线。

详细参数最终以 `config_default/message.yaml`、锅巴 schema 和实际代码为准。上游功能如果发生变化，本仓库不保证同步更新说明。
