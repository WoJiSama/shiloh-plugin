// bl-dice-plugin：独立骰子插件（物理拆分首例）
// 实体代码在 shiloh-plugin/domains/dice/，这里只做 Yunzai 加载入口。
// 配置仍读写 shiloh-plugin 的 message.yaml diceSystem 段（单数据源，避免两份配置漂移）。
export * from "../../shiloh-plugin/domains/dice/app.js"
