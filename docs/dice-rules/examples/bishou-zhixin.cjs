// JS 规则包示例：匕首之心（演示版）
//
// 用法：在群里引用本文件发送 `.dice rule 匕首之心`，预检后 `.骰规则确认 bishou-zhixin`，
// 再 `.骰规则启用 bishou-zhixin`，群成员即可使用 `.bz 攻击 3`。
//
// 规则对象与 YAML 规则包同 schema（见 骰娘自定义规则接入指南.md）；
// functions 里可注册受限表达式的自定义公式函数，公式里直接调用。

module.exports = {
  version: 1,
  id: "bishou-zhixin",
  name: "匕首之心",
  aliases: ["bz", "匕首"],
  description: "匕首之心演示规则：心眼加成与背刺判定的 JS 版实现。",

  identity: {
    display_name: "{attr.name}",
    fallback: "{sender.card}"
  },

  character: {
    fields: {
      name: { type: "string", label: "角色名", default: "{sender.card}", max_length: 30 },
      agi: { type: "integer", label: "敏捷", default: 6, min: 1, max: 20 },
      eye: { type: "integer", label: "心眼", default: 1, min: 0, max: 5 },
      // 公式里调用自定义函数 heartBonus（见下方 functions）
      backstab: { type: "integer", label: "背刺加成", default: 0, formula: "heartBonus(attr.agi, attr.eye)" }
    }
  },

  commands: [
    {
      id: "strike",
      aliases: ["strike", "攻击", "刺击"],
      label: "匕首刺击",
      description: "掷 2d6 + 敏捷修正进行刺击，命中后追加背刺加成。",
      arguments: [
        { id: "target_ac", label: "目标防护", type: "integer", required: true, min: 0, max: 30 }
      ],
      rolls: {
        dmg: "dice(2, 6)"
      },
      let: {
        hit: "roll.dmg.total + floor(attr.agi / 2)",
        final: "let.hit + attr.backstab"
      },
      branches: [
        { when: "let.final >= arg.target_ac + 4", result: "要害刺穿", effects: { character: { eye: "+1" } } },
        { when: "let.final >= arg.target_ac", result: "命中" },
        { result: "落空" }
      ],
      output: "{actor} 刺出匕首：{roll.dmg.detail} + 敏捷修正 = {let.hit}，含背刺 {attr.backstab} 共 {let.final} 对防护 {arg.target_ac}，{result}。"
    }
  ],

  // 自定义公式函数：在任意 formula/let/when 表达式中按名字调用。
  // 签名 (args, ctx) => number|string|boolean；数字结果仍受安全上限约束。
  functions: {
    heartBonus(args) {
      const agi = Number(args[0]) || 0
      const eye = Number(args[1]) || 0
      // 心眼等级每 2 级把敏捷的 1/3 转化为背刺加成
      return Math.floor((agi / 3) * Math.max(1, eye / 2))
    }
  }
}
