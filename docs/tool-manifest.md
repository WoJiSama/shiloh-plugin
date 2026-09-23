# 工具清单单一声明点(manifest)

## 问题背景

2026-09 接连出现的线上事故都指向同一个结构性问题:**新增一个工具需要同步修改
5-8 个地方,漏改任何一处就是事故**。

| 漏改的位置 | 实际事故 |
|---|---|
| `config/message.yaml` 的 `oneapi_tools` 白名单 | 工具对 LLM 完全不可见,快路匹配不到,模型调了别的工具 |
| `messageIntent.js` 的 `TERMINAL_TOOL_NAMES` | 工具执行后续轮 LLM 再次调用,同一请求发了两张卡面 |
| 工具 `description`(主模型唯一可见的信息) | 语义规划器之外回落主模型时,按旧习惯路由错工具 |
| 枚举参数校验 | 低模型填中文枚举被拒,大模型临场换错工具 |

根因:一个工具的"身份"分散在多个文件里(注册表、白名单、意图清单、终态集合、
三个提示面),没有任何机制保证它们一致。

## 方案:manifest 单一声明点

工具的全部路由/呈现声明集中在一个**轻量模块**里导出的 manifest 常量:

```js
// utils/xxxIntent.js(轻量:不得 import puppeteer/渲染器等重依赖)
export const XXX_TOOL_MANIFEST = {
  name: "xxxTool",
  terminal: true,            // 卡面/文件即回复,成功后不进 LLM 续轮
  background: false,         // 后台终态(带进度回报)
  description: "...",        // 主模型可见(函数 schema 里的一行说明)
  skill: { ... },            // 语义规划器的技能目录(whenToUse/boundaries/instructions)
  triggers: [/regex/],       // 意图候选触发词
  disclosure: "...",         // 语义规划器的详细参数抽取规则
  deterministicResolver: fn  // 可选:确定性快路参数解析(措辞无歧义时才提供)
}
```

派生链路(`utils/toolManifestRegistry.js` 是唯一枢纽):

- `LocalToolRegistry` 创建内置工具实例时,把实例上的 `manifest` 注册进中心
- `messageIntent.js` 的终态/后台终态集合改为中心的**活集合**(注册即可见)
- `toolIntentManifests.js` 的候选触发词/披露说明/确定性解析器走
  **合并视图**(注册清单 + 本地旧表,渐进迁移)
- `apps/test.js` 的 `initTools`:`oneapi_tools` 白名单**缺省 = 全部已注册工具**,
  配置了白名单时对被排除的已注册工具打启动告警

## 新增工具的检查清单(从 8 处减到 3 处)

1. 写工具类(`functions/functions_tools/XxxTool.js`),构造器挂
   `this.manifest = XXX_TOOL_MANIFEST`(name/description/skill 从 manifest 取)
2. 在轻量模块声明 manifest,并在 `toolIntentManifests.js` 的
   `registerToolManifests([...])` 追加一行
3. 在 `LocalToolRegistry.js` 的工厂列表加一行

不需要再改:messageIntent 终态集合、oneapi_tools 白名单(除非想显式禁用)、
三个提示面的任何一处。

## 迁移状态

- 已迁移:pixivSearchTool / pixivDownloadTool(参照实现,manifest 在
  `utils/pixivIntent.js`)
- 未迁移(仍在旧位置,行为不变):表情包/磁链/三角洲/提醒等;迁移时把对应
  条目从 `TOOL_INTENT_MANIFESTS`/`TERMINAL_TOOL_NAMES` 字面量挪进各自的
  manifest 即可,合并视图保证过渡期两套共存。

## 配套测试

`tests/toolManifestRegistry.test.js`:注册即可见、合并视图参与候选、重置恢复、
Pixiv manifest 完整性。
