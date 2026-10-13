# 阶段 1：测试环境与发布路径审计

审计日期：2026-10-13。下表是迁移前基线，来源 `/tmp/baseline-backend-tests-2.log`（1,461 项，1,406 通过，55 跳过），不是阶段 1 完成后的测试结果。

## 运行环境

- 本机已记录 Node `v24.14.1`。
- 2026-10-13 经 SSH 只读查询，线上 Node `v24.16.0`。`trss-yunzai` 与 `bl-console` 均使用 `/usr/bin/node`，分别执行宿主 `app.js start` 和插件 `console/server.js`。
- 当前 standalone 脚本默认同步到同一 `/opt/trss-yunzai` 宿主；其他 standalone 安装的 Node 版本没有核验，应遵守本仓 engines/CI 声明的范围。
- 线上 Yunzai 配置 `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`；这不等于本地截图测试已通过。
- 本次只读查询，没有部署或重启。

## 55 项历史跳过的逐文件分类

| 测试文件 | 跳过数 | 原因 |
| --- | ---: | --- |
| `tests/agentApiRouting.test.js` | 4 | Yunzai 宿主 config 模块未安装 |
| `tests/bananaDurableQueue.test.js` | 20 | Yunzai 宿主 config 模块未安装 |
| `tests/bilibiliArchiveMedia.test.js` | 1 | Yunzai 宿主 config 模块未安装 |
| `tests/bilibiliAutoRelay.test.js` | 3 | 2 项缺宿主 config；1 项引用已删除 MessageArchiveRecorder.js |
| `tests/imageAnalysisProgress.test.js` | 5 | Yunzai 宿主 config 模块未安装 |
| `tests/imageEditDurableRecovery.test.js` | 1 | Yunzai 宿主 config 模块未安装 |
| `tests/imageEditEmptyRetryPolicy.test.js` | 3 | Yunzai 宿主 config 模块未安装 |
| `tests/imageEditProgress.test.js` | 3 | Yunzai 宿主 config 模块未安装 |
| `tests/imageEndpointRouting.test.js` | 1 | Yunzai 宿主 config 模块未安装 |
| `tests/imagePromptContextPolicy.test.js` | 5 | Yunzai 宿主 config 模块未安装 |
| `tests/imageProviderTrust.test.js` | 2 | Yunzai 宿主 config 模块未安装 |
| `tests/messageStorageIdempotence.test.js` | 1 | Yunzai 宿主 config 模块未安装 |
| `tests/taskBackendEffort.test.js` | 3 | apiClient 导入失败被捕获，3 项使用无原因 skip；宿主依赖链待隔离 |
| `tests/textImageDocument.test.js` | 2 | Chromium 未安装（截图集成） |
| `tests/videoGroupContext.test.js` | 1 | Yunzai 宿主 config 模块未安装 |

分类合计：49 项日志明确缺少宿主 `lib/config/config.js`；3 项 `taskBackendEffort` 吞掉 `ERR_MODULE_NOT_FOUND` 后跳过；1 项引用删除文件；2 项缺 Chromium。共 55 项。

`dependence/dependencies.js:12-14` 直接导入宿主 config、puppeteer、common，是大量业务测试无法在独立 checkout 执行的入口。迁移模块应通过纯接口注入宿主能力；宿主适配器保留单独集成验证。新迁移核心用例必须 0 跳过，不能补一个空宿主模块后视为真实宿主验证。

另有基线未计入跳过的漏洞：`tests/bilibiliAutoRelay.test.js:33-38` 导入删除文件后只 diagnostic/return，测试被报告通过但没有执行主要断言。该项需修复旧入口引用或明确登记集成环境要求；不能作为搬运链路已通过的证据。

补验方式：业务逻辑使用 fake provider、fake clock、临时目录和内存存储；QQ 适配使用最小宿主夹具；截图集成在明确装有 Chromium 的测试任务执行；删除入口对应的旧测试按现存消息管线重新定义验收。不得对整个 ERR_MODULE_NOT_FOUND 使用通用跳过来隐藏自身模块路径错误。

## 发布和更新路径（改动前审计）

- `index.js:16-21` 只扫描 `.js` 应用；standalone 的各 `index.js:6` 同样只扫描 `.js`。保持 JS 入口/兼容导出，显式引入编译后的 JS；无需让宿主认识 TS。
- `scripts/deploy.sh:42-60` 原流程测试后直接 rsync 工作目录，没有后端产物验证。需在触碰服务器前编译、校验产物和前端构建；同步必须包含 `dist`，并防止旧产物残留。`--skip-tests` 也不能跳过编译和产物检查。
- `scripts/deploy-standalone.sh:8-12` 原流程只同步 standalone 子目录。当前包装器复用主插件模块时，需先保证目标主插件的源码与 dist 一致，失败应在 mkdir/rsync 之前报错；未来 standalone 独立迁移需独立构建清单。
- `apps/update.js:18-21` 原流程直接调用宿主 `Update.update()`。已只读核验线上宿主 `/opt/trss-yunzai/plugins/other/update.js`：其先 `git pull`（强制模式先 reset），再更新依赖，然后立即 restart；没有编译钩子。不能直接沿用并期望重启自动生成 dist。
- 安全更新需固定目标 commit，在临时目录完成编译、产物校验后才改线上 checkout；最终只重启已验证 commit。仅预编译远端分支后再调用宿主 pull 存在远端变动竞态。仅覆盖 restart 则只能阻止重启，不能撤销已更新源码，必须记录局限。
- 尚未构建/产物不匹配必须明确报错，禁止自动退回旧 JS 实现掩盖遗漏发布。

本文件记录审计基线和验收要求；实际阶段 1 的完成状态以阶段报告和最终脚本实现为准。

## 本阶段落实的审计修正

- `apps/update.js` 已移除宿主 updater 委托；`#bl更新` 和强制更新均向主人明确提示使用 `bash scripts/deploy.sh`，不拉取、不重启、不把失败说成更新成功。群内自动更新是暂时受限的功能，后续恢复时须实现固定 commit 的预构建发布事务。宿主自带 `#全部更新`、定时 pull 等其他路径不经过该命令，TS 迁移期间应由运维避免用它们更新此插件；启动产物校验必须拒绝源码/产物不一致。
- 实际清点发现 `bilibiliAutoRelay.test.js` 的 5 项测试都属于删除的旧入口：3 项显式跳过，另 2 项仅 diagnostic 后返回，被错误报告通过。已用 2 项当前 `MessagePipeline` 的短/长视频重复事件回归替代，验证真实归档与媒体 outbox 入队恰好一次，并保留视频标识、时长和链接。媒体下载、OneBot 转发等细节由现存 `bilibiliMediaRelay`、`mediaOutbox`、`deliveryGateway` 测试负责，不声称本文件完成真实 QQ 投递。
- `node --test tests/bilibiliAutoRelay.test.js tests/pluginUpdateBuild.test.js`：5 通过、0 失败、0 跳过。该结果不是后端全量验收。
