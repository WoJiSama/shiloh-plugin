# JS 规则包教程

> 面向**机器人主人**的高级通道：用纯 JavaScript 写规则包。YAML 教程见《骰娘自定义规则接入指南》（`.dice import yaml` 获取）。
> 两者共用同一套规则运行时：命令、人物卡、群状态、持久化、版本管理完全一致，只是"包怎么写"不同。

## 1. 五分钟上手

1. 获取示例：群里发送 `.dice import js`，会收到本教程和示例文件 `bishou-zhixin.cjs`。
2. 照着改：把 `id`、字段、命令换成你的规则。
3. 在群里**发送这个 .js 文件**，然后**引用它**发送 `.dice rule 你的规则名`。
4. 看预检报告（会真实加载并试掷），没问题发送 `.骰规则确认 <id>`。
5. 在目标群发送 `.骰规则启用 <id>`，群成员用 `.<前缀> 命令` 开玩。

## 2. 文件长什么样

规则包就是一个导出对象的普通 JS 文件（`module.exports = {...}` 或 `export default {...}` 均可）：

```js
module.exports = {
  version: 1,                    // 固定为 1
  id: "my-rule",                 // 小写字母开头，[a-z0-9-]，3~48 位
  name: "我的规则",
  aliases: ["mr"],               // 群里 .mr 即可调用，至少 1 个
  description: "一句话说明",

  identity: {                    // 可选：角色显示名与群名片
    display_name: "{attr.name}",
    sync_group_card: true,
    group_card: "{attr.name} 希望{attr.hope}/{attr.hope_max}"
  },

  character: { fields: { /* 人物卡字段，schema 与 YAML 完全相同 */ } },
  commands: [ /* 命令声明，schema 与 YAML 完全相同 */ ],

  // JS 独有能力：注册受限表达式里的自定义公式函数
  functions: {
    heartBonus(args) { return Math.floor((args[0] / 3) * Math.max(1, args[1] / 2)) }
  }
}
```

- `character` / `commands` 的全部字段（字段类型、掷骰、分支、effects、群状态、物品、先攻、战役……）与 YAML 教程第 3~17 节**完全一致**，请以那份为准，本文不重复。
- 模板里写 JS 时注意引号：YAML 里 `type: integer` 是裸 token，JS 里必须写 `type: "integer"`。

## 3. functions：自定义公式函数

`functions` 里的每个函数会注册进骰娘的受限表达式，任何 `formula` / `let` / `when` / `duration` 等表达式里都能按名字调用：

```js
character: {
  fields: {
    agi: { type: "integer", default: 6, min: 1, max: 20 },
    backstab: { type: "integer", formula: "heartBonus(attr.agi)" }  // ← 直接调用
  }
},
commands: [{
  id: "strike", aliases: ["strike"],
  let: { dmg: "calcDamage(attr.backstab, 2)" },                     // ← let 里也能用
  // ...
}],
functions: {
  heartBonus(args) { return Math.floor(args[0] / 2) },
  calcDamage(args) { return args[0] + args[1] }
}
```

规则与限制：

- 函数签名 `(args, ctx) => number | string | boolean`，`args` 是**已求值**的参数数组；数字结果仍受安全上限约束（防溢出）。
- 函数名必须匹配 `[A-Za-z][A-Za-z0-9_]*`，最多 32 个；不能与内置函数重名覆盖（内置有 min/max/clamp/floor/abs/dice/pool 等，同名会按内置优先报冲突，换名即可）。
- 函数是**纯计算**用途：不要在里面掷随机数（掷骰请用表达式里的 `dice()`，保证可审计）、不要访问网络或文件、不要有副作用（人物卡变更走命令的 effects 声明）。
- 函数**本体不会**进入版本存档和序列化产物，只在运行时从你导入的源文件加载；改了函数重新导入新版本即可。

## 4. 持久化与隔离（不用你写任何存储代码）

- 每次命令产生的数值变化（effects 自动改、`.<前缀> 设 hope=3` 手动改）都会事务式落盘，重启不丢。
- 存储 = **用户 × 规则包 × 群** 三维隔离：A 群改的数值不影响 B 群，也不影响 COC 内置人物卡。
- GM 授权后（`.<前缀> 权限 gm @某人`）可以改任何人的数值。
- `formula` 派生字段不存储，实时按公式计算——改了基础字段，派生值自动跟着变。

## 5. 群名片同步

`identity.sync_group_card: true` 时，玩家本人在群里发送 `.sn on`（一次性，机器人需为群管理）后，每次成功执行规则命令都会按 `identity.group_card` 模板自动刷新他的群名片。规则包**不能**改别人的名片、不能绕过 `.sn`。

## 6. 安全边界

- 导入与确认都要求**主人**权限；普通群成员永远无法让骰娘执行 JS。
- JS 会在骰娘进程里执行——主人本来就把控服务器，这不增加攻击面；但**不要导入来源不明的 JS**（YAML 才是给普通群主分享用的格式）。
- 配置 `diceSystem.customJsRulesEnabled: false` 可整体关闭 JS 通道（YAML 不受影响）。

## 7. 排错

- 预检报 `JS 规则包加载失败：xxx`：多半是语法错误或没导出对象，看具体行号修。
- 报 `不支持的函数 xxx`：函数没写进 `functions`，或函数名拼错。
- 报 `未知模板变量 attr.xxx`：输出模板里引用了不存在的字段；`formula` 派生字段不能直接 `{attr.xxx}` 引用，需要的话在命令 `let` 里算。
- 语法没问题但行为不对：先 `.骰规则预览 <id>` 看试掷报告，再 `.骰规则查看 <id>` 对照字段。

## 8. 完整示例

`examples/bishou-zhixin.cjs`（发送 `.dice import js` 时随本教程一起发出）演示了：字段默认值、formula 调用自定义函数、命令掷骰/分支/effects（命中要害 → 心眼+1）、输出模板。
