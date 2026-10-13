# bl-chat 控制台

控制台前端采用 Vue 3、TypeScript、Vite、Vue Router 和 Naive UI。`console/server.js` 保留独立 Node 服务，提供认证、配置和运营 API，并直接返回 `console/frontend/dist/index.html` 与构建后的静态资源。前端源码不再拼接进服务文件。

## 安装、构建和启动

前端构建需要 **Node 20.19 及以上的 20.x，或 Node 22.12 及以上**，建议使用受支持的 LTS。Vite 7 不支持更早的 Node 版本。以下命令均从插件根目录执行；插件根目录的依赖仍需按现有部署流程安装。

```sh
npm --prefix console/frontend ci
npm --prefix console/frontend run build
npm run console:start
```

`build` 会先运行 TypeScript 检查，再生成 `console/frontend/dist/`。`dist`、前端 `node_modules` 和 Vite 缓存不提交 Git；提交源码与 `console/frontend/package-lock.json`，在目标机器或构建流水线执行 `npm ci` 和构建，再交付 `dist`。

更新已运行的控制台时，**先完成构建，再重启控制台服务**。沿用示例 systemd unit 的机器可在构建成功后运行：

```sh
sudo systemctl restart bl-console
```

本轮还更新了 Yunzai 页面接口及规则导入的 `stageId` 协议。部署时需要一起交付相关插件代码，并让机器人 / Yunzai 服务加载新版本；仅更新控制台会使旧上游接口缺少 `stageId`，前端无法确认规则导入。

构建产物不存在或首页不可读时，首页返回 HTTP 503，并提示安装、构建命令。服务不会回退到旧模板；配置 API 与鉴权仍可用。HTML 使用 `no-store`，带内容哈希的资源使用长期 immutable 缓存。

插件根目录提供快捷脚本：

| 命令 | 用途 |
| --- | --- |
| `npm run console:dev` | 启动 Vite 开发服务，`/api`、`/img`、`/bl-chat` 代理至本机 8787 |
| `npm run console:build` | 类型检查并构建前端 |
| `npm run console:check` | 仅运行前端 TypeScript 检查 |
| `npm run console:test` | 运行前端 Vitest 测试 |
| `npm run console:smoke` | 用构建产物、localhost 假 API 和 Chrome 运行跨页/主题/宽度浏览器检查 |
| `npm run console:start` | 启动控制台 Node 服务 |

开发模式下分别启动 `console:start` 和 `console:dev`。默认控制台端口为 8787。容器采集需要 Docker；收发统计和管道记录需要本机 Redis；命令、语义记忆和完整运行明细需要 Yunzai 页面服务。

## 页面和地址

继续使用 hash 路由，原 `#/`、`#/persona`、`#/ai`、`#/draw`、`#/commands`、`#/observe`、`#/semantic` 地址保持可用。新增 `#/conversation`（对话设置）、`#/groups`、`#/pipeline`、`#/risk` 和 `#/bot/<QQ>` 等页面。

命令 / 骰子与语义记忆已经使用原生 Vue 页面，通过现有 `/bl-chat/*` API 代理访问 Yunzai；命令表、骰子设置、牌堆规则和表情包等能力沿用已有后端。运行观测 `#/observe` 展示聚合概览，`#/observe/details` 保留原工具的完整运行明细入口，可在嵌入页查看或在新窗口打开。

群聊页在群号旁显示群名，并支持按群名搜索。名称优先读取 Yunzai 各机器人已有群列表；上游不可用时回退插件与 Yunzai 主目录的 `data/group_names.json` 缓存，仍未知的名称显示“群名未获取”。名称补齐不会改变白名单及今日活动组成的群聊列表。

## 认证和配置保存

账密登录使用服务端 scrypt 密码哈希和 HttpOnly、SameSite=Lax 的会话 Cookie；现有控制台令牌仍支持查询参数 `token` 和 `x-console-token`，方便脚本和受保护图片访问。浏览器进入带令牌链接后会移除地址栏中的查询参数。首次创建管理员、修改密码、退出登录沿用现有认证 API。

已认证的 `/bl-chat/*` 请求由控制台在服务端装配对应 Yunzai 页面凭据，不需要前端读取 `commands-web.json`。向 Yunzai 转发时剔除控制台令牌头、会话 Cookie 和 referer；`/api/apps` 返回不含页面令牌的路径。独立原工具使用自身页面令牌的访问方式仍兼容。

通用配置页以独立配置 schema 为字段声明源，`message.yaml` 为持久化配置源。第一批对话设置与思考程度来自 `models/configSchemas/`，锅巴旧路径保留兼容导出；其他已迁移页面的声明逐批迁出，台账见 `docs/console-guoba-migration.md`：

- GET 返回字段分组、组件约束、`revision`、`applyMode` 和 `applyHint`。明确的密码字段返回 `value: ''`、`secret: true` 和 `configured`，不返回原凭据。
- PUT 提交 `{ values, secrets, revision }`，`values` 仅包含变更字段。凭据使用 `{ action: 'keep' }`、`{ action: 'replace', value: '...' }` 或 `{ action: 'clear' }`；脱敏占位符不能写成真实凭据。
- 服务端校验数字必填、范围和步长、子表组件与必填约束。校验失败返回 400；当前配置与提交 revision 不同返回 409，前端保留草稿供核对。
- 仅在有变化时备份，再通过 YAML 定点更新写入；保留无关字段和注释，最多保留 10 份控制台备份。
- 保存成功表示已持久化。消息管道初始化参数与搬运授权初始化项需要重启机器人服务；健康报告配置在下一调度周期读取；风控约 10 秒内读取更新。字段说明给出具体生效时机，保存不会自动重启机器人。

AI 渠道提供不含凭据的稳定 `_consoleId`，按 ID 保留各行原 API Key，重排不会把其他行凭据套进当前行。API Key 支持 `apiKeyAction: 'keep' | 'replace' | 'clear'`，脱敏行探测由服务端恢复原 key。AI 配置各组与人设库也返回 revision，保存可携带 revision 防止旧页面覆盖新配置。旧客户端未携带 revision 的提交仍兼容。

`GET /api/pipeline/jobs` 支持 `kind=all|event|delivery`、`status` 和 `limit=1..200`。返回的是 Redis TTL 内仍保留的任务记录，状态表示最后持久化结果，不能据此确认 worker 当前存活。扫描达到上限会标明 `scanTruncated`；Redis 不可达返回 503，不伪造任务量或运行状态。

## 服务环境变量

| 变量 | 默认值 / 用途 |
| --- | --- |
| `CONSOLE_HOST` | `0.0.0.0`，监听地址 |
| `CONSOLE_PORT` | `8787`，监听端口 |
| `CONSOLE_YUNZAI_HOST` | `127.0.0.1`，Yunzai 页面服务地址 |
| `CONSOLE_YUNZAI_PORT` | `2536`，Yunzai 页面服务端口 |
| `CONSOLE_DRAW_DIR` | `/var/lib/bl-console/draw`，生图历史文件目录 |
| `CONSOLE_PLUGIN_ROOT` | 当前代码的插件根目录；用于部署根目录覆盖或隔离测试 fixture |

## 后端定向验证

以下测试使用纯模块、本地临时 fixture 和 localhost 假上游，不读取真实 `config` 或访问生产：

```sh
node --test tests/consoleSchemaConfig.test.js tests/consoleProviderCredentials.test.js tests/consoleRuntimeRead.test.js tests/consoleFrontendStatic.test.js tests/consoleServerIntegration.test.js tests/guobaAiProviderConfig.test.js tests/aiProviderProbe.test.js tests/personaLibrary.test.js tests/diceRulePackManager.test.js tests/commandsWebApp.test.js
```

浏览器回归先执行 `npm run console:build`，再运行 `npm run console:smoke`。默认使用系统 Google Chrome（macOS 路径），其他环境可通过 `CHROME_PATH` 指定可执行文件；输出报告与截图写入 `/tmp/bl-console-vue-review`，可通过 `CONSOLE_SMOKE_OUTPUT` 覆盖。夹具只读取默认 schema 与非密默认配置，不连接真实控制台、Redis、Docker 或外部模型。测试覆盖的界面行为不能代替实际服务联调。

前端使用 `npm --prefix console/frontend run format` 与 `format:check` 统一源码格式。桌面侧栏底部显示构建 Git revision 和日期，鼠标悬停显示完整 UTC 构建时间。

规则包预检返回 `stageId`，原生页面与原工具确认时携带 `{ id, stageId }`。服务端在索引锁内比较暂存编号，预检被其他页面替换或已经确认时返回 409，不会导入与审核报告不一致的源码。无编号的旧客户端仍兼容。前端拒绝非法文件名，并在牌堆替换、规则确认及删除时给出确认提示。
