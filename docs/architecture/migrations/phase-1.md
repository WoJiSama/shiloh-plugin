# 阶段 1：后端 TypeScript 基础设施

基线：`d9c5f7d`；实施分支：`codex/ts-phase-1-foundation`。本阶段只做本地实现与验收，没有部署生产。

## 这部分的作用

- **严格类型与编译**：后端使用独立 NodeNext 配置，编译为 `dist/backend` 的普通 ESM JavaScript；前端 Vue 配置独立。错误参数、缺少回调、payload 类型不一致会在运行前被发现。
- **首批真实迁移**：插件导出识别和 QQ 转发分批的唯一业务实现移至 TS。原 `utils/*.js` 保留薄转导出，既有 QQ/宿主调用路径继续使用。前者决定哪些导出是插件并去重，后者按 100 节点拆分并顺序等待回执。
- **测试入口**：`npm test` 同时发现原 JS 和编译后的 TS 单测；类型负例单独编译验证。迁移模块核心测试不依赖 Yunzai，不允许跳过。
- **边界与统计**：AST 检查新纯模块不引用平台/全局/旧业务，固定源码清单并同时报告 JS 占比和基线剩余模块，避免数字失真。
- **发布保障**：编译/发布 manifest 记录源码、产物、编译器与 commit；启动拒绝缺失或不匹配产物。发布包先完整上传校验，停服务后安装，配置/data 保留，失败按文件清单回滚。

## 实际命令

`npm run backend:typecheck`、`npm run backend:build`、`npm run backend:test`、`npm run test:boundaries`、`npm run test:artifacts`、`npm run migration:report`、`npm run verify:phase` 已实现。`npm run release:pack` 要求干净 checkout；`node scripts/release.mjs verify <产物>` 校验完整发布包。生产运行无需 TS 编译器。

构建输出不提交。开发首次安装执行 `npm ci`、`npm ci --prefix console/frontend`，再执行 `npm run verify:phase`。运行服务前执行 `npm run backend:build`。Node 支持范围声明为 >=22.12；本地24.14.1、已只读核验线上24.16.0；22/24 CI矩阵已配置，尚未把远端CI当成已通过。

## 更新与回滚范围

- `scripts/deploy.sh` 改为完整验证与干净 commit 打包；依赖在同机暂存区安装后切换。不会直接发布当前脏工作目录。
- `scripts/deploy-standalone.sh` 在同步前检查共享编译产物。
- **群内自动更新暂时不可用**：原宿主 updater 拉取后立即重启，没有安全构建阶段。`#bl更新`/强制更新明确提示维护者使用发布脚本。恢复群内一键更新需要后续实现固定 commit 的暂存构建事务；不能称这项用户体验已经保留。
- 宿主 `#全部更新` 或外部定时 pull 不受插件命令控制；混用时启动校验拒绝不一致版本，应通过编译发布脚本更新此插件。
- 发布安装/回滚在临时目录做回归，验证 config/data、不归发布管理的文件保持不变。线上服务重启、正在执行任务的恢复和真实 QQ 插件全加载未在本轮操作；持久任务生命周期完整迁移仍属阶段5。
- 自定义 js/mjs/cjs 的测试验证 Node 模块格式及隔离目录加载；没有把它等同于依赖完整宿主的 LocalToolRegistry 端到端验证。

## 历史测试清理

55 项旧跳过已逐项登记在 [测试环境清单](phase-1-test-environments.md)。5 项已失效的 Bilibili 旧入口测试（3跳过、2无断言假通过）替换为当前消息管线2项回归。剩余宿主/Chromium集成条件另列；不为通过数字创建伪宿主。

## 验收记录

实现提交：`7994c57`（后续校验修正另列）。

- `npm run verify:phase`：严格类型、负类型契约、边界检查、后端全量、前端类型/34项测试/构建全部通过。该轮后端1491项，1439通过、52环境跳过。
- 增加首次安装旧编译文件清理回归后，再跑 `npm test`：1492项、1440通过、0失败、52跳过。迁移TS单测11项无跳过；产物安装/回滚7项无跳过。
- `bash -n` 与 `git diff --check` 通过。
- 固定统计：首批迁移2个业务模块、56有效TS行，基线剩余370个业务JS模块；业务JS有效代码行占比99.937%。这是新固定口径，不与此前GitHub99.2%直接比较；源码清单完整保存在 source-baseline.json。
- 前端存在约670kB chunk告警，未将体积优化混入阶段1。
- 阶段2尚未开始；线上环境只读核验，不包含真实部署验收。

最终补验：修正提交 `86d07b9` 后，产物与启动校验15项全部通过、0跳过。独立干净checkout在Node24.14.1完成 `release:pack`，产物对应86d07b950c944796682e2fcee3084db9e94619ab，共509个文件；临时宿主目录实际安装、启动guard、回滚与config保留验证全部通过。源码checkout残留src不会误阻止发布，额外旧编译文件会清理并可恢复。未执行生产部署。
