# 与 sealdice-core 的骰娘差异对照报告

> 对照基准：sealdice-core@main（2026-09 克隆）`dice/ext_coc7.go`、`dice/ext_deck.go`、`dice/dice_attrs_manager.go`
> 我方实现：`domains/dice/DiceManager.js`
> 结论：核心骨架一致，但 **6 处语义性差异**（会算错结果）+ 2 块功能缺失

## 一、语义性差异（会出错误结果）

### 1. setcoc 规则 4 实现错误 ⚠️
- **sealdice**（ext_coc7.go:1575-1586）：大成功 = `min(5, 判定值/10)`；大失败线 = `min(96 + 判定值/10, 100)`
- **我们**：大成功 = `roll<=5 && roll<=value`；大失败 = 仅 `roll===100`
- 例：`.ra 侦查 30` 规则4 → sealdice 大成功需 ≤3；我们 ≤5 就算。完全不同。

### 2. setcoc 规则 5 实现错误 ⚠️
- **sealdice**（1587-1594）：大成功 = `min(2, 判定值/5)`（出 1-2 且 < 判定值/5）；大失败：判定值<50 → ≥96，≥50 → ≥99
- **我们**：大成功 = 仅 roll===1；大失败 = 仅 roll===100
- 例：判定值 80 规则5 → sealdice 出 99 也大失败；我们 99 只是普通失败。

### 3. 规则 0/1 的大失败线用错基数 ⚠️
- **sealdice**（1523-1531）：`checkVal < 50` 时大失败线 96——**checkVal 是折算后的判定值**（受难度前缀影响，如困难检定 80→40）
- **我们**：`value < 50` 用**原始技能值**。困难检定时两者结果不同。

### 4. `.ra` 不支持难度前缀 ⚠️
- **sealdice**：`.ra 困难侦查` / `.ra 极难侦查60` / `.ra 大成功斗殴`（含繁体「困難」「極難」），难度前缀把判定线折半/五分一（difficultyPrefixMap，ext_coc7.go:24）
- **我们**：`parseCheckArgs` 完全没有难度前缀概念，`.ra 困难侦查` 会去找名为"困难侦查"的技能

### 5. `.sc` 缺三个参数语义 ⚠️
- **sealdice**（ext_coc7.go:1180-1310）：
  - `/half` 修正符：扣除量减半
  - `cap=N`：扣除量上限
  - **大失败时损失骰取最大值**（`BigFailDiceOn: successRank == -2`）
- **我们**：`.sc 成功/失败 [san]` 三段式，以上都没有；另我方的"当日累计 1/5 不定疯狂"提示是自创加分项（sealdice 无此逻辑，可保留）

### 6. `.rav` 对抗检定的同档裁定细则
- **sealdice**（ext_coc7.go:596-620）：双方成功等级相同时——属性检定比属性值高者胜；斗殴场景默认被攻击者（闪避方）胜；dg 规则比骰点
- **我们**：handleOpposed 只有 rank 比较，同档行为未按此细则

## 二、功能缺失

### 7. 牌堆系统（sealdice 为 `.draw` 命令，非 `.deck`）
- `.draw <牌组>` 抽牌；`.draw list / search <关键词> / keys / desc / reload`
- 牌堆文件：社区 JSON/YAML 格式（`牌组名: [条目]`），支持 `{draw:其他牌组}` 嵌套抽取、 `$t` 变量、压缩包牌堆自动解压（ext_deck.go）

### 8. `.st` 子命令缺口
- sealdice：`show/showall/del/clr/rm/hide/fmt` + 卡规则转换提示
- 我们：`show/查看/del/删除/clr/清空` + 录卡增减（`san-1`）——缺 `showall/hide/fmt`

## 三、已对齐的部分（抽查确认）

- 档位顺序：大成功→极难(÷5)→困难(÷2)→成功→失败→大失败 ✓
- 规则1/2/3 语义 ✓（规则2 的 fumble 边界等价）
- 规则0 的"出1必然大成功、出100必然大失败" ✓
- `.en` 成长：roll > 技能值才成长，+1d10，写卡 ✓
- `.r` 表达式：`#`多轮、kh/kl/dh/dl、四则 ✓
- `.set d20` 默认骰、`.coc7` 属性、`.ti/.li` 疯狂表 ✓

## 四、修复优先级建议

1. **P0**（算错结果）：差异 1、2、3（judgeCoc 重写为 sealdice 的 ResultCheckBase 移植）
2. **P1**（高频用法）：差异 4（难度前缀）、5（sc 参数）
3. **P2**：6（对抗细则）、8（st 子命令）
4. **P3**（新功能）：7（牌堆 .draw 系统）
5. 全部完成后用 sealdice 的判定用例做回放测试锁定


## 五、修复记录（2026-09-16 P5 切片一）

- ✅ 差异1/2/3：`judgeCoc` 重写为 sealdice `ResultCheckBase` 忠实移植（`computeCocRank`），规则0-5 语义全部对齐
- ✅ 差异4：`.ra` 支持难度前缀（困难/極難/大成功，含繁体），按 sealdice `GetResultTextWithRequire` 展示"难度检定成功/失败"（大成功/大失败作附加语）
- ✅ 差异5：`.sc` 支持 `--half`（扣除减半）、`--cap=N`（扣除上限）、大失败时损失骰取最大面数（BigFailDiceOn）
- ✅ 差异6：`.rav` 同成功等级改为平局（对齐 sealdice 现行实现，其属性比较分支已被官方停用）
- ✅ 差异8：`.st showall / hide / unhide`
- ✅ 差异7（牌堆 .draw 系统）：`domains/dice/DeckManager.js`——seal 格式 JSON/YAML、{牌组}/[方括号] 嵌套、{%牌组}=放回、::N::权重（含不放回池）、_前缀隐藏、{player}/{self}、深度防死循环；命令 .draw 及 keys/list/search/desc/reload；示例牌堆已放 config/decks/
- ✅ 回放测试：`tests/cocRuleSealdiceCompat.test.js` 12 用例锁死（期望值按 Go 源码逐条推导）
