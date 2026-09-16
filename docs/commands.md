# 命令总表

> 本文档由 `config_default/commands.yaml` 生成（`.命令 导出` 或运行 scripts/gen-commands-doc.mjs）。
> 生成时间：2026-09-16 06:27:40 ｜ 共 83 条命令 / 11 个模块

## 🧠 记忆与表达

长期记忆、群记忆、群工作流、全局表达学习

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `#记忆状态` | 查看记忆系统运行状态 | 所有人 | `domains/memory/commandsApp.js memoryStatus` |
| `#记忆统计` | 查看记忆库统计 | 所有人 | `domains/memory/commandsApp.js memoryStats` |
| `#我的记忆` | 列出我的长期记忆 | 所有人 | `domains/memory/commandsApp.js listMyMemory` |
| `#群记忆` | 列出本群共享记忆 | 所有人 | `domains/memory/commandsApp.js listGroupMemory` |
| `#搜索记忆 <关键词>` | 搜索记忆库 | 所有人 | `domains/memory/commandsApp.js searchMemory` |
| `#删除记忆 <ID>` | 删除指定记忆条目 | 所有人 | `domains/memory/commandsApp.js deleteMemory` |
| `#清空我的记忆 / #清空群记忆` | 清空个人或本群记忆 | 所有人 | `domains/memory/commandsApp.js clearMyMemory/clearGroupMemory` |
| `#禁用我的记忆 / #启用我的记忆` | 开关我个人记忆写入 | 所有人 | `domains/memory/commandsApp.js disableMyMemory/enableMyMemory` |
| `#群工作流` | 查看本群自动通知工作流 | 所有人 | `domains/memory/commandsApp.js listGroupWorkflows` |
| `#删除群工作流 <ID>` | 删除指定工作流 | 所有人 | `domains/memory/commandsApp.js deleteGroupWorkflow` |
| `#群知识` | 查看本群知识绑定（谁是谁、黑话等） | 所有人 | `domains/memory/commandsApp.js listGroupKnowledge` |
| `#删除群知识 <ID>` | 删除指定群知识 | 所有人 | `domains/memory/commandsApp.js deleteGroupKnowledge` |
| `.表达学习 [状态|记忆|报告|总结|清空]` | 全局表达学习管理（无参数看帮助） | 仅主人 | `domains/memory/commandsApp.js globalStyleLearningCommand` |
| `.希洛反馈 <内容>` | 对机器人说话风格提意见 | 所有人 | `domains/memory/commandsApp.js recordPersonaFeedback` |

## 🛠 工具与MCP

本地工具调用与 MCP 服务管理

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `#tool <内容>` | 调用本地工具 | 所有人 | `apps/test.js handleTool` |
| `#mcp 重载` | 重新加载 MCP 服务配置 | 仅主人 | `apps/test.js reloadMCP` |
| `#mcp 列表` | 列出可用 MCP 工具 | 所有人 | `apps/test.js listMCPTools` |
| `#mcp 状态` | 查看 MCP 连接状态 | 所有人 | `apps/test.js mcpStatus` |
| `#mcp 测试 <工具名>` | 测试指定 MCP 工具 | 仅主人 | `apps/test.js testMCPTool` |

## 🎲 骰子

自定义规则包骰子系统（JS 规则包，规划中兼容 sealdice 骰句语法）

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `.draw <牌组> [keys|list|search|desc|reload]` | 牌堆抽牌与管理（牌堆文件放 config/decks/） | 所有人 | `domains/dice/DeckManager.js` |
| `.<规则包命令>` | 规则包定义的任意骰子命令，如 .r 1d100、.ra 力量 70（以已加载规则包为准） | 所有人 | `apps/DicePlugin.js customDiceRule` |
| `.骰子规则 [列表|详情|帮助]` | 查看已加载的规则包与命令（以规则包内置帮助为准） | 所有人 | `utils/DiceRulePackManager.js` |

## 🔫 三角洲

三角洲行动游戏数据查询

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `.三角洲` | 三角洲模块帮助 | 所有人 | `domains/games/deltaforce/app.js showHelp` |
| `.三角洲 密码` | 今日/每日密码 | 所有人 | `domains/games/deltaforce/app.js dailyKeyword` |
| `.三角洲 物品价值 <名称>` | 查物品价值/价格 | 所有人 | `domains/games/deltaforce/app.js objectValueSearch` |
| `.三角洲 价格历史 <名称>` | 价格走势折线图 | 所有人 | `domains/games/deltaforce/app.js priceHistory` |
| `.三角洲 改枪码 [方案]` | 改枪方案列表/详情 | 所有人 | `domains/games/deltaforce/app.js solutionList` |
| `.三角洲 特勤处利润 [设施]` | 制造利润查询 | 所有人 | `domains/games/deltaforce/app.js placeProfit` |
| `.三角洲 利润排行` | 制造利润排行 | 所有人 | `domains/games/deltaforce/app.js profitRank` |

## 🐎 赛马娘

赛马娘养成与竞速小游戏

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `.赛马娘` | 赛马娘模块帮助 | 所有人 | `domains/games/uma/app.js showHelp` |
| `.赛马娘 领养 <名字>` | 领养/创建你的赛马娘 | 所有人 | `domains/games/uma/app.js adoptUma` |
| `.赛马娘 重新领养 <名字>` | 重新领养（重置养成） | 所有人 | `domains/games/uma/app.js readoptUma` |
| `.赛马娘 弃养 [确认]` | 弃养当前赛马娘 | 所有人 | `domains/games/uma/app.js abandonUma` |
| `.赛马娘 属性` | 查看赛马娘六维信息 | 所有人 | `domains/games/uma/app.js showUma` |
| `.赛马娘 词条` | 查看小马词条 | 所有人 | `domains/games/uma/app.js showAffix` |
| `.赛马娘 重铸` | 洗练词条 | 所有人 | `domains/games/uma/app.js rerollAffix` |
| `.赛马娘 词条池` | 查看词条池列表 | 所有人 | `domains/games/uma/app.js showAffixPool` |
| `.赛马娘 训练` | 查看训练状态 | 所有人 | `domains/games/uma/app.js showTrainingStatus` |
| `.赛马娘 训练 <项目>` | 执行训练 | 所有人 | `domains/games/uma/app.js trainUma` |
| `.赛马娘 开始` | 发起一场竞速 | 所有人 | `domains/games/uma/app.js startRace` |
| `.赛马娘 加入` | 报名参加比赛 | 所有人 | `domains/games/uma/app.js joinRace` |
| `.赛马娘 决策 <选择>` | 比赛中的策略选择 | 所有人 | `domains/games/uma/app.js raceDecision` |
| `.赛马娘 开跑` | 开始比赛 | 所有人 | `domains/games/uma/app.js runRace` |
| `.赛马娘 取消` | 取消当前比赛 | 所有人 | `domains/games/uma/app.js cancelRace` |
| `.赛马娘 加积分 <QQ> <数量>` | 调整积分 | 群管理 | `domains/games/uma/app.js adjustScore` |
| `.赛马娘 积分` | 查看我的积分 | 所有人 | `domains/games/uma/app.js showScore` |
| `.赛马娘 排行 [页码]` | 积分排行榜 | 所有人 | `domains/games/uma/app.js showRank` |

## 😹 表情包

表情包库管理（全部仅主人）

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `#表情包导入` | 从引用/图片导入表情包 | 仅主人 | `domains/emoji/app.js importEmoji` |
| `#表情包列表 [页码]` | 分页浏览表情包库 | 仅主人 | `domains/emoji/app.js listEmoji` |
| `#表情包删除 [ID]` | 删除表情包 | 仅主人 | `domains/emoji/app.js deleteEmoji` |
| `#表情包打标 [ID]` | 重新生成表情包标签 | 仅主人 | `domains/emoji/app.js retagEmoji` |
| `#表情包预览 [ID]` | 预览表情包 | 仅主人 | `domains/emoji/app.js previewEmoji` |
| `#表情包封禁 [ID] / #表情包解封 [ID]` | 封禁/解封表情包 | 仅主人 | `domains/emoji/app.js banEmoji/unbanEmoji` |
| `#表情包重载` | 重载表情包库 | 仅主人 | `domains/emoji/app.js reloadEmoji` |
| `#表情包统计` | 表情包库统计 | 仅主人 | `domains/emoji/app.js emojiStats` |
| `#表情包巡检` | 执行维护巡检 | 仅主人 | `domains/emoji/app.js runMaintenance` |
| `#表情包清空 [确认]` | 清空表情包库（危险） | 仅主人 | `domains/emoji/app.js clearAll` |

## 🛡 群管理与广告

广告语料库与群内容治理

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `.广告入库` | 将引用消息存入广告语料库 | 群管理 | `domains/group-admin/moderationMessage.js` |
| `.广告出库` | 处理待审广告样本 | 群管理 | `domains/group-admin/moderationMessage.js` |
| `.广告样本 [列表|统计]` | 查看广告语料库 | 群管理 | `domains/group-admin/moderationMessage.js` |
| `.广告样本 删除 <ID>` | 删除广告样本 | 群管理 | `domains/group-admin/moderationMessage.js` |

## 📜 聊天记录与管道

聊天记录查询、消息可靠管道、B站搬运

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `#查看群聊记录 [条数] / #查看私聊记录 [条数]` | 查看最近聊天记录 | 仅主人 | `apps/MessageManager.js` |
| `#清除群聊记录 / #清除私聊记录` | 清除本地记录缓存 | 仅主人 | `apps/MessageManager.js` |
| `#搜索聊天记录 <关键词>` | 搜索历史聊天记录 | 所有人 | `apps/MessageManager.js` |
| `.群聊天记录 管理员添加 <QQ> / 管理员删除 <QQ>` | 聊天记录查询权限管理 | 仅主人 | `apps/MessageManager.js` |
| `.群聊天记录 <关键词>` | 群员查询群聊天记录（需授权） | 所有人 | `apps/MessageManager.js` |
| `.消息管道状态 [QQ]` | 查看消息可靠管道状态 | 所有人 | `apps/MessageManager.js` |
| `.B站授权 登录/状态/退出` | B站高清搬运授权管理 | 仅主人 | `domains/media/bilibili/app.js bilibiliAuth` |
| `.高清搬运 <链接>` | B站视频高清搬运（引用或链接） | 所有人 | `domains/media/bilibili/app.js relayBilibiliHighQuality` |
| `.高清搬运白名单 添加/删除/查看` | 高清搬运群白名单管理 | 仅主人 | `domains/media/bilibili/app.js manageBilibiliQualityWhitelist` |
| `.音乐提取` | 提取引用分享卡片里的音乐 | 仅主人 | `apps/MessageManager.js relayQuotedMusic` |

## 🧲 磁链

磁力链接搜索与受限下载

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `.磁力搜索 <关键词>` | 搜索磁力资源（.磁力/.磁链搜索 同义） | 所有人 | `domains/media/magnetsearch/app.js search` |
| `.磁力` | 磁链模块帮助 | 所有人 | `domains/media/magnetsearch/app.js showHelp` |

## 📚 知识库

主人维护的静态知识库（全部仅主人）

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `#知识库添加 <内容>` | 添加知识条目 | 仅主人 | `domains/knowledge/app.js addKnowledge` |
| `#知识库删除 <ID>` | 删除知识条目 | 仅主人 | `domains/knowledge/app.js deleteKnowledge` |
| `#知识库列表 [页码]` | 分页浏览知识库 | 仅主人 | `domains/knowledge/app.js listKnowledge` |
| `#知识库搜索 <关键词>` | 搜索知识库 | 仅主人 | `domains/knowledge/app.js searchKnowledge` |
| `#知识库统计` | 知识库统计 | 仅主人 | `domains/knowledge/app.js knowledgeStats` |
| `#知识库清空` | 清空知识库（危险） | 仅主人 | `domains/knowledge/app.js clearKnowledge` |

## ⚙ 系统维护

插件更新与查询工具

| 用法 | 说明 | 权限 | 实现位置 |
| --- | --- | --- | --- |
| `#bl更新 / #bl强制更新` | 更新插件 | 仅主人 | `apps/update.js update` |
| `#查询qq <QQ号>` | 查询QQ信息 | 所有人 | `apps/qqinfo1.js` |
| `.命令 [域名] / .帮助` | 本命令总表（.命令 导出 重新生成文档） | 所有人 | `apps/CommandHelp.js` |
| `.意图影子` | 查看 P4 影子判定统计（模型 vs 正则一致率） | 仅主人 | `apps/CommandHelp.js showShadowStats` |
