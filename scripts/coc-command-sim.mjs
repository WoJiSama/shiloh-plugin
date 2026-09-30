#!/usr/bin/env node
// COC 骰娘命令全量群消息模拟测试
// 运行方式: cd /opt/coc-sim && node coc-command-sim.mjs
// 原理: 以生产插件真实代码(domains/dice/app.js)+真实线上配置(staging 副本)运行,
//       构造群消息事件走 Yunzai 同款规则匹配, 捕获回复而不真正发送到 QQ 群。
// 隔离: 数据写在 /opt/coc-sim/plugins/shiloh-plugin/data/ 下, 不碰生产 state.json。

const PROD_PLUGIN = "/opt/trss-yunzai/plugins/shiloh-plugin"
process.chdir("/opt/coc-sim")

// ---- 最小运行时全局(模拟 Yunzai 环境) ----
global.plugin ||= class {
  constructor(options = {}) {
    this.name = options.name
    this.dsc = options.dsc
    this.event = options.event
    this.priority = options.priority
    this.rule = options.rule || []
  }
}
const logs = []
global.logger = {
  info: (...a) => logs.push(["info", a.map(String).join(" ")]),
  warn: (...a) => logs.push(["warn", a.map(String).join(" ")]),
  error: (...a) => logs.push(["error", a.map(String).join(" ")]),
  mark: (...a) => logs.push(["mark", a.map(String).join(" ")]),
  debug: (...a) => logs.push(["debug", a.map(String).join(" ")])
}
globalThis.logger = global.logger
global.segment = {
  image: p => ({ type: "image", data: { file: p } }),
  at: q => ({ type: "at", data: { qq: q } }),
  record: p => ({ type: "record", data: { file: p } }),
  file: p => ({ type: "file", data: { file: p } })
}
// 假 redis: 只需让可选依赖(puppeteer 渲染链/记忆链)拿到接口形状, 不连生产库
const fakeRedisStore = new Map()
globalThis.redis = {
  async get(k) { return fakeRedisStore.get(String(k)) ?? null },
  async set(k, v) { fakeRedisStore.set(String(k), String(v)); return "OK" },
  async del(k) { return fakeRedisStore.delete(String(k)) ? 1 : 0 },
  async keys(p) { return [...fakeRedisStore.keys()].filter(k => k.startsWith(String(p).replace(/\*$/, ""))) },
  async exists(k) { return fakeRedisStore.has(String(k)) ? 1 : 0 }
}

const GROUP_ID = 999000111
const SELF_ID = 10000
const USERS = {
  member: { user_id: 28800000001, nickname: "测试调查员", card: "测试调查员", role: "member", isMaster: false },
  admin: { user_id: 28800000002, nickname: "测试群主", card: "测试群主", role: "owner", isMaster: false },
  master: { user_id: 28800000003, nickname: "测试主人", card: "测试主人", role: "member", isMaster: true }
}

const privates = []
const fileUploads = []
globalThis.Bot = {
  pickFriend: uid => ({ sendMsg: async m => { privates.push({ uid, text: describe(m) }) } }),
  pickUser: uid => ({ sendMsg: async m => { privates.push({ uid, text: describe(m) }) } })
}

function describe(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(describe).join(" ")
  if (content && content.type) return `[segment:${content.type}]`
  return String(content ?? "")
}

function makeEvent(as, msg) {
  const u = USERS[as] || USERS.member
  const replies = []
  const e = {
    msg,
    raw_message: msg,
    message: [{ type: "text", data: { text: msg } }],
    message_type: "group",
    post_type: "message",
    sub_type: "normal",
    group_id: GROUP_ID,
    user_id: u.user_id,
    sender: { user_id: u.user_id, nickname: u.nickname, card: u.card, role: u.role },
    isMaster: u.isMaster,
    isGroup: true,
    self_id: SELF_ID,
    time: Math.floor(Date.now() / 1000),
    message_id: Math.floor(Math.random() * 1e9),
    reply: async (content, quote) => { replies.push(describe(content)); return { retcode: 0, status: "ok" } },
    group: { sendFile: async (url, name) => { fileUploads.push({ via: "group.sendFile", name }) } },
    friend: { sendFile: async (url, name) => { fileUploads.push({ via: "friend.sendFile", name }) } },
    bot: {
      uin: String(SELF_ID),
      pickFriend: uid => ({ sendMsg: async m => { privates.push({ uid, text: describe(m) }) } }),
      sendApi: async (action, params = {}) => {
        fileUploads.push({ via: action, name: params?.name })
        return { retcode: 0, status: "ok" }
      }
    }
  }
  return { e, replies }
}

// ---- 加载生产插件 ----
const { DicePlugin } = await import(`${PROD_PLUGIN}/domains/dice/app.js`)
const { diceManager } = await import(`${PROD_PLUGIN}/domains/dice/DiceManager.js`)
const plugin = new DicePlugin()

// Yunzai 同款规则匹配: 依序匹配 rule.reg, 处理函数返回 true 表示消费
// 同时模拟 DiceLogRecorder(priority 10045): log 开启期间记录每条群消息
async function dispatch(e) {
  const matched = []
  let consumed = false
  for (const rule of plugin.rule) {
    let re
    try { re = new RegExp(rule.reg) } catch { continue }
    if (!re.test(e.msg)) continue
    let res
    try { res = await plugin[rule.fnc](e) } catch (error) { return { matched, consumed: false, thrown: String(error?.stack || error) } }
    matched.push({ fnc: rule.fnc, ret: res })
    if (res === true) { consumed = true; break }
  }
  try { await diceManager.recordLogMessage(e) } catch (error) { logs.push(["warn", `log记录失败: ${error.message}`]) }
  return { matched, consumed, thrown: null }
}

// ---- 测试步骤 ----
const L = "大成功|极难成功|困难成功|成功|失败|大失败"
const STEPS = [
  // 导航与帮助
  { id: "01", group: "导航", cmd: ".dice", as: "member", expect: /骰娘命令导航|骰娘/ },
  { id: "02", group: "导航", cmd: ".dice help", as: "member", expect: /COC 骰娘/ },
  { id: "03", group: "导航", cmd: ".骰娘帮助", as: "member", expect: /COC 骰娘/ },
  // 基础掷骰
  { id: "04", group: "掷骰", cmd: ".r 1d100", as: "member", expect: /D100\[\d+\]/ },
  { id: "05", group: "掷骰", cmd: ".r2d6+3", as: "member", expect: /2D6\[\d+[+,]\d+\]/ },
  { id: "06", group: "掷骰", cmd: ".r 3#1d100", as: "member", expect: /D100\[\d+\][\s\S]*D100\[\d+\][\s\S]*D100\[\d+\]/ },
  { id: "07", group: "掷骰", cmd: ".r 4d6kh3", as: "member", expect: /4D6/ },
  { id: "08", group: "掷骰", cmd: ".r (2d6+3)*2", as: "member", expect: /2D6/ },
  { id: "09", group: "掷骰", cmd: "。r 1d20", as: "member", expect: /D20\[\d+\]/ },
  { id: "10", group: "掷骰", cmd: ".r abc", as: "member", expect: /格式|错误|无效|无法|支持/, note: "坏表达式应友好报错不崩" },
  { id: "11", group: "掷骰", cmd: ".r 99999d100", as: "member", expect: /没能执行|1-100/, note: "超限应友好拦截" },
  { id: "12", group: "掷骰", cmd: ".bp 2", as: "member", expect: /奖励/ },
  { id: "13", group: "掷骰", cmd: ".pp 2", as: "member", expect: /惩罚/ },
  // 人物卡录入(为后续检定/SAN/成长做数据)
  { id: "14", group: "人物卡", cmd: ".st 侦查 60", as: "member", expect: /更新|已|侦查/ },
  { id: "15", group: "人物卡", cmd: ".st san 65", as: "member", expect: /更新|已|san/i },
  { id: "16", group: "人物卡", cmd: ".st san-1", as: "member", expect: /更新|已|san/i, note: "san 增减语法" },
  { id: "17", group: "人物卡", cmd: ".st show", as: "member", expect: /侦查[\s\S]*60/ },
  { id: "18", group: "人物卡", cmd: ".st showall", as: "member", expect: /侦查|san/i },
  // COC 检定
  { id: "19", group: "检定", cmd: ".ra 侦查 60", as: "member", expect: new RegExp(`检定[\\s\\S]*(${L})`) },
  { id: "20", group: "检定", cmd: ".ra 侦查 60 困难", as: "member", expect: new RegExp(`检定[\\s\\S]*(${L})`) },
  { id: "21", group: "检定", cmd: ".ra b 侦查 60", as: "member", expect: new RegExp(`检定|奖励[\\s\\S]*(${L})`), note: "奖惩骰前缀" },
  { id: "22", group: "检定", cmd: ".ra p 侦查 60", as: "member", expect: new RegExp(`检定|惩罚[\\s\\S]*(${L})`) },
  { id: "23", group: "检定", cmd: ".ra 侦查", as: "member", expect: new RegExp(`(${L})`), note: "无值时读卡(侦查=60)" },
  { id: "24", group: "检定", cmd: ".ra 70", as: "member", expect: new RegExp(`(${L})`), note: "纯数字目标" },
  { id: "25", group: "检定", cmd: ".rc 侦查 60", as: "member", expect: new RegExp(`(${L})`) },
  { id: "26", group: "检定", cmd: ".rb 侦查 60", as: "member", expect: /奖励/ },
  { id: "27", group: "检定", cmd: ".rp 侦查 60", as: "member", expect: /惩罚/ },
  { id: "28", group: "检定", cmd: ".rav A 60 vs B 50", as: "member", expect: /对抗检定/ },
  { id: "29", group: "检定", cmd: ".rh 侦查 60", as: "member", expect: /暗骰/, expectPrivate: true },
  { id: "30", group: "检定", cmd: ".rav 斗殴 50 @对手", as: "admin", expect: /对抗|格式|用法|检定/, note: "at 对抗语法(无真 at 段时应有友好提示)" },
  // SAN 与成长
  { id: "31", group: "SAN/成长", cmd: ".sc 1/1d6", as: "member", expect: /SAN Check/, note: "基础 SAN Check" },
  { id: "32", group: "SAN/成长", cmd: ".sc 0/1", as: "member", expect: /SAN/ },
  { id: "33", group: "SAN/成长", cmd: ".sc 1/1d6 --cap=3", as: "member", expect: /SAN/, note: "--cap 上限参数" },
  { id: "34", group: "SAN/成长", cmd: ".en 侦查", as: "member", expect: /成长检定/ },
  { id: "35", group: "SAN/成长", cmd: ".en 不存在的技能", as: "member", expect: /没有|未找到|找不到|格式|错误/, note: "未录卡技能成长应友好提示" },
  // 属性生成
  { id: "36", group: "属性", cmd: ".coc7", as: "member", expect: /COC7 调查员属性|力量/ },
  { id: "37", group: "属性", cmd: ".coc7 2", as: "member", expect: /力量/ },
  { id: "38", group: "属性", cmd: ".coc7 100", as: "member", expect: null, validate: (r) => {
      const rows = (r.allText.match(/(?:^|\n)\d+\. /g) || []).length
      return rows === 20 ? null : `生成数量应被 cap 到 20, 实际 ${rows} 行`
    }, note: "数量超限应 cap 到 maxRounds=20" },
  { id: "39", group: "属性", cmd: ".jrrp", as: "member", expect: /今日人品/ },
  { id: "40", group: "属性", cmd: ".db STR 60 SIZ 50", as: "member", expect: /伤害加值/ },
  { id: "41", group: "属性", cmd: ".db", as: "member", expect: /伤害加值|格式|STR/, note: "无参数提示" },
  // 疯狂表
  { id: "42", group: "疯狂", cmd: ".ti", as: "member", expect: /\d+\./ },
  { id: "43", group: "疯狂", cmd: ".li", as: "member", expect: /\d+\./ },
  // 房规
  { id: "44", group: "房规", cmd: ".setcoc", as: "member", expect: /房规|规则|setcoc/i },
  { id: "45", group: "房规", cmd: ".setcoc 5", as: "admin", expect: /5|房规|规则/ },
  { id: "46", group: "房规", cmd: ".setcoc 无大失败", as: "admin", expect: /无大失败|房规|规则/ },
  { id: "47", group: "房规", cmd: ".setcoc 0", as: "admin", expect: /0|房规|规则/ },
  // 昵称
  { id: "48", group: "昵称", cmd: ".nn 大侦探", as: "member", expect: /大侦探|昵称|已/ },
  { id: "49", group: "昵称", cmd: ".nn", as: "member", expect: /格式|昵称|名字/ },
  { id: "50", group: "昵称", cmd: ".sn on", as: "admin", expect: /名片|sn|开启|已/i },
  { id: "51", group: "昵称", cmd: ".sn off", as: "admin", expect: /名片|sn|关闭|已/i },
  { id: "51b", group: "昵称", cmd: ".sn coc", as: "member", validate: r => (/名片已按内置模板 coc 设置为：.+SAN/.test(r.allText) && r.files.some(f => String(f).includes("set_group_card")) ? null : "应命中内置 coc 名片模板"), note: "用户原命令:现命中内置模板" },
  { id: "51c", group: "昵称", cmd: ".sn 我的江湖名", as: "member", validate: r => (/骰娘昵称已设置为：我的江湖名，群名片已同步/.test(r.allText) ? null : "未知词应回退为设昵称+同步名片"), note: "非模板非保留词:昵称回退" },
  // 牌堆
  { id: "52", group: "牌堆", cmd: ".draw", as: "member", expect: /牌堆|draw|格式/i },
  { id: "53", group: "牌堆", cmd: ".draw list", as: "member", expect: /牌堆|示例|没有/i },
  { id: "54", group: "牌堆", cmd: ".draw 示例牌堆", as: "member", expect: /[\s\S]+/, note: "抽一次示例牌堆" },
  { id: "55", group: "牌堆", cmd: ".draw 完全不存在的牌堆", as: "member", expect: /没有|未找到|找不到|不存在/ },
  // 规则包
  { id: "56", group: "规则包", cmd: ".骰规则", as: "member", expect: /规则包/ },
  { id: "57", group: "规则包", cmd: ".骰规则列表", as: "admin", expect: /规则包|启用|没有/ },
  { id: "58", group: "规则包", cmd: ".骰规则列表", as: "member", expect: /只有主人|管理员|权限/, note: "权限门" },
  // 跑团日志
  { id: "59", group: "日志", cmd: ".log on 越权测试", as: "member", expect: /只有主人、群主或管理员/, note: "普通成员应被拒" },
  { id: "60", group: "日志", cmd: ".log on 测试团", as: "admin", expect: /跑团 log 已开启|已经开启/ },
  { id: "61", group: "日志", cmd: ".r 1d20", as: "member", expect: /D20\[\d+\]/, note: "log 期间掷骰仍可用" },
  { id: "62", group: "日志", cmd: ".log", as: "member", expect: /测试团|开启|状态/ },
  { id: "63", group: "日志", cmd: ".log end 测试团", as: "admin", expect: /已结束|导出/, expectFile: true },
  { id: "64", group: "日志", cmd: ".log", as: "member", expect: /已结束|没有开启/, note: "结束后状态展示" },
  { id: "65", group: "日志", cmd: ".log export", as: "admin", expect: null, expectFile: true, note: "历史日志导出(只发文件)" },
  // 先攻
  { id: "66", group: "先攻", cmd: ".ri 1d20+3", as: "member", expect: /先攻/ },
  { id: "67", group: "先攻", cmd: ".ri 1d20", as: "admin", expect: /先攻/ },
  { id: "68", group: "先攻", cmd: ".init list", as: "member", expect: /先攻/ },
  { id: "69", group: "先攻", cmd: ".init clear", as: "member", expect: /先攻|清|已/ },
  // 兼容开关
  { id: "70", group: "开关", cmd: ".bot on", as: "admin", expect: /开启|on|已/i },
  { id: "71", group: "开关", cmd: ".bot off", as: "admin", expect: /退群命令需要先艾特我/, note: "裸命令不退群" },
  { id: "72", group: "开关", cmd: ".reply on", as: "member", expect: /开启|on|已|reply/i },
  // 杂项
  { id: "73", group: "杂项", cmd: ".send 这是一条测试留言", as: "member", expect: /已收到|转达|格式/ },
  { id: "74", group: "杂项", cmd: ".find 测试词条", as: "member", expect: /没有|找到|词条|知识|找不到/ },
  { id: "75", group: "杂项", cmd: ".set d20", as: "admin", expect: /默认骰|d20/i, note: "默认骰设置" },
  { id: "76", group: "杂项", cmd: ".r 1d6", as: "member", expect: /1D6\[\d+\]/, note: "改默认骰后显式表达式仍按表达式" },
  // 人物卡删除/多卡
  { id: "77", group: "多卡", cmd: ".pc new 备用卡", as: "member", expect: /备用卡|新建|创建|已/ },
  { id: "78", group: "多卡", cmd: ".pc list", as: "member", expect: /备用卡|列表|没有/ },
  { id: "79", group: "多卡", cmd: ".pc tag 主线卡", as: "member", expect: /tag|标签|主线|已/i },
  { id: "80", group: "多卡", cmd: ".pc lock", as: "member", expect: /lock|锁定|已/i },
  { id: "81", group: "多卡", cmd: ".st hide 侦查", as: "member", expect: /隐藏|hide|已/i },
  { id: "82", group: "多卡", cmd: ".st del 侦查", as: "member", expect: /删除|已|侦查/ },
  { id: "83", group: "多卡", cmd: ".st clr", as: "member", expect: /清空|已|人物卡/ },
  // 未知命令兜底
  { id: "84", group: "兜底", cmd: ".完全未知的测试命令xyz", as: "member", expect: null, note: "记录兜底行为(允许静默忽略或友好提示)" },
  // 2026-09-28 修复回归:奖惩前缀/多轮/切分
  { id: "85", group: "修复回归", cmd: ".rab#3 今天开团 60", as: "member", validate: r => {
      const lines = r.allText.split("\n").filter(l => l.includes("今天开团"))
      if (lines.length !== 3) return `应输出 3 轮检定, 实际 ${lines.length} 行: ${r.allText.slice(0, 100)}`
      if (!lines.every(l => /奖励骰/.test(l) && /\/60 /.test(l))) return "每轮应带奖励骰且对 60 检定"
      return null
    }, note: "用户案例:rab#3 = 3 轮奖励骰检定" },
  { id: "86", group: "修复回归", cmd: ".ra b 侦查 60", as: "member", expect: /奖励骰[\s\S]*\/60 /, note: "空格 b 前缀不再被丢弃" },
  { id: "87", group: "修复回归", cmd: ".ra p 侦查 60", as: "member", expect: /惩罚骰[\s\S]*\/60 /, note: "空格 p 前缀不再被丢弃" },
  { id: "88", group: "修复回归", cmd: ".ra b2 侦查 60", as: "member", expect: /奖励骰\[十位:\d+\/\d+\/\d+,个位:\d+\][\s\S]*\/60 /, note: "b2=两个奖励骰(三个十位)" },
  { id: "89", group: "修复回归", cmd: ".ra 3# 今天开团 60", as: "member", validate: r => {
      const lines = r.allText.split("\n").filter(l => l.includes("今天开团"))
      return lines.length === 3 ? null : `应输出 3 轮检定, 实际 ${lines.length}`
    }, note: "参数区 3# 前缀多轮" },
  { id: "90", group: "修复回归", cmd: ".rab 3# 今天开团 60", as: "member", validate: r => {
      const lines = r.allText.split("\n").filter(l => l.includes("今天开团"))
      if (lines.length !== 3) return `应输出 3 轮, 实际 ${lines.length}`
      if (!lines.every(l => /奖励骰/.test(l))) return "每轮应带奖励骰"
      return null
    }, note: "rab + 3# 组合" },
  { id: "91", group: "修复回归", cmd: ".ra 3#今天开团 60", as: "member", validate: r => {
      const lines = r.allText.split("\n").filter(l => l.includes("今天开团"))
      return lines.length === 3 ? null : `紧贴式 3# 应输出 3 轮, 实际 ${lines.length}`
    }, note: "紧贴式 3#技能" },
  { id: "92", group: "修复回归", cmd: ".rah#2 侦查 60", as: "member", expect: /暗骰/, expectPrivate: true, note: "暗骰多轮:私聊应含 2 轮" },
  { id: "93", group: "修复回归", cmd: ".ra 侦查 60", as: "member", expect: new RegExp(`(${L})`), note: "常规单轮不受影响" },
  { id: "94", group: "修复回归", cmd: ".rab3 侦查 60", as: "member", expect: /奖励骰\[十位:\d+\/\d+\/\d+\/\d+,个位:\d+\][\s\S]*\/60 /, note: "rab3=三个奖励骰(四个十位)保持原行为" },
  // P0/P1 新功能(2026-09-28 海豹差距补齐)
  { id: "95", group: "旁观模式", cmd: ".obon", as: "member", expect: /已进入旁观模式/, note: "进入旁观" },
  { id: "96", group: "旁观模式", cmd: ".r 1d100", as: "member", expect: null, validate: r => (r.allText.trim() === "" ? null : `旁观者掷骰应静默, 实际有回复: ${r.allText.slice(0, 80)}`), note: "旁观期间骰点被静默" },
  { id: "97", group: "旁观模式", cmd: ".ra 侦查 60", as: "member", expect: null, validate: r => (r.allText.trim() === "" ? null : "旁观期间检定应静默"), note: "旁观期间检定被静默" },
  { id: "98", group: "旁观模式", cmd: ".ob list", as: "admin", expect: /旁观名单（1 人）/, note: "旁观名单" },
  { id: "99", group: "旁观模式", cmd: ".oboff", as: "member", expect: /已退出旁观模式/, note: "退出旁观" },
  { id: "100", group: "旁观模式", cmd: ".r 1d100", as: "member", expect: /D100\[\d+\]/, note: "退出后骰点恢复" },
  { id: "101", group: "先攻轮转", cmd: ".ri +5", as: "member", expect: /先攻/ },
  { id: "102", group: "先攻轮转", cmd: ".ri +2", as: "admin", expect: /先攻/ },
  { id: "103", group: "先攻轮转", cmd: ".init next", as: "member", expect: /第1轮：轮到/, note: "首位行动者" },
  { id: "104", group: "先攻轮转", cmd: ".init next", as: "member", expect: /第1轮：轮到/, validate: r => (/▶ 2\./.test(r.allText) ? null : "第2次 next 应标记第2位行动者"), note: "推进到第2位" },
  { id: "105", group: "先攻轮转", cmd: ".init 下一回合", as: "member", expect: /第2轮：轮到/, note: "轮完一圈进第2轮" },
  { id: "106", group: "HTML团录", cmd: ".log on 美化团", as: "admin", expect: /跑团 log 已开启/ },
  { id: "106b", group: "HTML团录", cmd: ".r 1d20", as: "member", expect: /D20\[\d+\]/, note: "log期间掷骰(结果入档)" },
  { id: "106c", group: "HTML团录", cmd: ".ra 侦查 60", as: "member", expect: new RegExp(`(${L})`), note: "log期间检定(结果入档)" },
  { id: "107", group: "HTML团录", cmd: ".log end 美化团", as: "admin", expect: /已结束/, expectFile: true },
  { id: "108", group: "HTML团录", cmd: ".log export html", as: "admin", expect: null, validate: r => (r.files.some(f => /\.html$/.test(String(f))) ? null : "应导出 .html 文件"), note: "HTML 美化导出" },
  { id: "109", group: "HTML团录", cmd: ".log list", as: "member", expect: /美化团[\s\S]*测试团/, note: "团录列表(含历史)" },
  { id: "110", group: "卡模板", cmd: ".st hp 12", as: "admin", expect: /更新|已/ },
  { id: "111", group: "卡模板", cmd: ".st san 55", as: "admin", expect: /更新|已/ },
  { id: "112", group: "卡模板", cmd: ".st fmt HP:{hp} SAN:{san}", as: "admin", expect: /人物卡模板已保存/, note: "设置卡模板(群管理)" },
  { id: "113", group: "卡模板", cmd: ".st show", as: "admin", expect: /HP:12 SAN:55/, note: "按模板展示" },
  { id: "114", group: "卡模板", cmd: ".st fmt", as: "member", expect: /当前群人物卡模板/ },
  { id: "115", group: "卡模板", cmd: ".st fmt clr", as: "admin", expect: /恢复默认/ },
  { id: "116", group: "批量成长", cmd: ".st 射击 70", as: "admin", expect: /更新|已/ },
  { id: "117", group: "批量成长", cmd: ".st 闪避 50", as: "admin", expect: /更新|已/ },
  { id: "118", group: "批量成长", cmd: ".en 射击 闪避 不存在技能", as: "admin", validate: r => {
      if (!/射击 成长检定/.test(r.allText)) return "缺射击成长行"
      if (!/闪避 成长检定/.test(r.allText)) return "缺闪避成长行"
      if (!/不存在技能：找不到技能值/.test(r.allText)) return "缺失技能未提示"
      return null
    }, note: "批量成长+缺失提示" },
  { id: "119", group: "批量成长", cmd: ".en 射击 闪避 60", as: "admin", expect: /批量成长按人物卡数值结算/, note: "批量带数值应提示" },
  { id: "120", group: "随机姓名", cmd: ".name", as: "member", expect: /随机姓名（中文）：/ },
  { id: "121", group: "随机姓名", cmd: ".name en 3", as: "member", expect: /随机姓名（英文）：/ },
  { id: "122", group: "随机姓名", cmd: ".name jp 2", as: "member", expect: /随机姓名（日文）：/ },
  // 2026-09-28 比较计数(群真实需求:.r3#d100＜60 / .r6d6a4)
  { id: "123", group: "比较计数", cmd: ".r3#d100＜60", as: "member", validate: r => {
      const lines = r.allText.split("\n").filter(l => l.includes("D100<60"))
      if (lines.length !== 3) return `3 轮应各带 D100<60, 实际 ${lines.length} 行`
      if (!lines.every(l => /[✓✗]/.test(l) && /成功 [01]\/1/.test(l))) return "每轮应有✓/✗与成功数"
      return null
    }, note: "用户原命令(全角＜):3 轮逐骰判定" },
  { id: "124", group: "比较计数", cmd: ".r 6d6>4", as: "member", expect: /6D6>4=6D6\[[\d✓✗+]+\]=成功 \d\/6/, note: "逐骰>4 计数" },
  { id: "125", group: "比较计数", cmd: ".r6d6a4", as: "member", expect: /6D6>4=6D6\[[\d✓✗+]+\]=成功 \d\/6/, note: "用户原命令:aN 糖=骰池>N" },
  { id: "126", group: "比较计数", cmd: ".r 4d6kh3>=4", as: "member", validate: r => (/D6KH3\[\d+\+\d+\+\d+\+\d+=>[\d✓✗+]+\]/.test(r.allText) && /成功 \d\/3/.test(r.allText)) ? null : "kh 保留骰应带判定标记", note: "kh 与比较组合" },
  { id: "127", group: "比较计数", cmd: ".ww6a4", as: "member", validate: r => (!/WoD 骰池/.test(r.allText) && /WoD 没有 4-again/.test(r.allText) && /\.r 6d10>4/.test(r.allText) && /\.help ww/.test(r.allText)) ? null : "无效再骰线应拦下引导而不是掷骰", note: "用户原命令:直接拦下+引导" },
  { id: "131", group: "帮助主题", cmd: ".help ww", as: "member", validate: r => (/WoD 黑暗世界骰池/.test(r.allText) && !/\.r\[表达式\]/.test(r.allText) && !/\.log new/.test(r.allText)) ? null : "应只显示 ww 主题帮助", note: "用户原命令:分主题帮助" },
  { id: "132", group: "帮助主题", cmd: ".help ra", as: "member", validate: r => (/【ra 相关命令】/.test(r.allText) && /#N 多轮/.test(r.allText) && !/\.log new/.test(r.allText)) ? null : "ra 主题应显示命令总表完整描述(含#N多轮)", note: "命令总表驱动,desc不被#截断" },
  { id: "135", group: "帮助主题", cmd: ".help coc", as: "member", validate: r => (/骰子（\d+ 条）/.test(r.allText) && /COC 检定/.test(r.allText) && /SAN Check/.test(r.allText) && /跑团日志/.test(r.allText)) ? null : "coc 应落到骰子模块全量权威列表", note: "coc=骰子模块(命令总表)" },
  { id: "136", group: "帮助主题", cmd: ".help 记忆", as: "member", expect: /记忆与表达（\d+ 条）[\s\S]*#记忆状态/, note: "中文主题命中模块" },
  // 2026-09-28 未录值检定+同消息多指令(用户:.ra格斗 连发应投骰)
  { id: "137", group: "连发检定", cmd: ".ra格斗", as: "member", expect: /进行 格斗 检定：1D100=\d+\/5 (成功|失败|大成功|大失败|困难成功|极难成功)/, note: "官方默认值:格斗=5 直接判档" },
  { id: "138", group: "连发检定", cmd: ".ra格斗.ra格斗.ra格斗", as: "member", validate: r => {
      const n = r.allText.split("\n").filter(l => /格斗 检定/.test(l)).length
      return n === 3 ? null : `粘连三条应各投一次, 实际 ${n} 次`
    }, note: "用户原命令:粘连多指令拆分=投三次" },
  { id: "139", group: "连发检定", cmd: ".r1d100.r1d20", as: "member", validate: r => (/D100\[\d+\]/.test(r.allText) && /D20\[\d+\]/.test(r.allText)) ? null : "混合粘连应两掷", note: "混合命令拆分" },
  { id: "140", group: "连发检定", cmd: ".draw 示例.牌堆不存在", as: "member", expect: /牌组「示例\.牌堆不存在」不存在/, note: "防误拆:参数含点不拆分" },
  // 2026-09-28 退群命令守卫(用户需求:@机器人 .bot off 才退群)
  { id: "141", group: "退群守卫", cmd: ".bot off", as: "admin", expect: /退群命令需要先艾特我/, note: "无艾特不退" },
  { id: "142", group: "退群守卫", cmd: ".bot off", as: "admin", withAtBot: true, validate: r => (r.allText.includes("希洛先走了") && r.files.some(f => String(f).includes("set_group_leave")) ? null : "应有告别语并真实调用退群API"), note: "@机器人 .bot off=退群" },
  { id: "143", group: "退群守卫", cmd: ".bot off", as: "member", withAtBot: true, expect: /只有主人或群主\/管理员可以让希洛退群/, note: "艾特了但无权限" },
  { id: "133", group: "帮助主题", cmd: ".help 完全不存在的主题xyz", as: "member", expect: /没有找到「完全不存在的主题xyz」[\s\S]*COC 骰娘/, note: "未知主题回退全量" },
  { id: "134", group: "帮助主题", cmd: ".骰娘帮助", as: "member", expect: /COC 骰娘[\s\S]*\.log new/, note: "全量帮助不受影响" },
  // 2026-09-28 贴头轮数(用户需求:.ra3#格斗90)
  { id: "128", group: "检定轮数", cmd: ".ra3#格斗90", as: "member", validate: r => {
      const lines = r.allText.split("\n").filter(l => /格斗 检定/.test(l))
      return lines.length === 3 && lines.every(l => /\/90 /.test(l)) ? null : `应 3 连检定对 90, 实际 ${lines.length} 行`
    }, note: "用户原命令:贴头轮数与 .r3# 对齐" },
  { id: "129", group: "检定轮数", cmd: ".ra#3格斗90", as: "member", validate: r => (r.allText.split("\n").filter(l => /格斗 检定/.test(l)).length === 3 ? null : "应 3 连检定"), note: "#后轮数保持" },
  { id: "130", group: "检定轮数", cmd: ".rab3#格斗90", as: "member", validate: r => {
      const lines = r.allText.split("\n").filter(l => /格斗 检定/.test(l))
      return lines.length === 3 && lines.every(l => /奖励骰\[十位:\d+\/\d+,个位:\d+\]/.test(l) && /\/90 /.test(l)) ? null : `sealdice 语义:rab3#=3轮每轮1奖励骰,实际${lines.length}行`
    }, note: "rab3#=3轮每轮奖励骰(sealdice 3#语义)" }
]

// 2026-09-29 海豹语义全面对齐(源码审计)附加用例
STEPS.push(
  { id: "145", group: "海豹对齐", cmd: ".sc 1d6", as: "admin", expect: /SAN Check[\s\S]*理智损失/, note: "单参简易:成功扣0失败扣1d6(admin卡有SAN)" },
  { id: "146", group: "海豹对齐", cmd: ".sc b 0/1", as: "admin", expect: /SAN Check[\s\S]*奖励骰/, note: "sc 奖惩骰" },
  { id: "147", group: "海豹对齐", cmd: ".ra 侦查+10", as: "member", validate: r => (/侦查 检定：1D100=\d+\/35 /.test(r.allText) ? null : "活动卡无侦查应默认25+10=35"), note: "技能修正后缀:默认25+10=35" },
  { id: "148", group: "海豹对齐", cmd: ".ra3#p格斗90", as: "member", validate: r => {
      const lines = r.allText.split("\n").filter(l => /格斗 检定/.test(l))
      return lines.length === 3 && lines.every(l => /惩罚骰/.test(l) && /\/90 /.test(l)) ? null : `应3轮每轮惩罚骰,实际${lines.length}`
    }, note: "3#p=3轮每轮惩罚骰" },
  { id: "149", group: "海豹对齐", cmd: ".sn coc", as: "admin", expect: /名片已按内置模板 coc 设置为：/, note: "内置coc名片模板" },
  { id: "150", group: "海豹对齐", cmd: ".nn", as: "member", expect: /当前骰娘昵称：/, note: "nn无参查看" },
  { id: "151", group: "海豹对齐", cmd: ".pc new 临时卡", as: "admin", expect: /已保存并切换人物卡：临时卡/, note: "为 rename 准备" },
  { id: "152", group: "海豹对齐", cmd: ".pc rename 临时卡 主线卡", as: "admin", expect: /人物卡已改名：临时卡 → 主线卡/, note: "pc rename" },
  { id: "153", group: "全量审计", cmd: ".组队 猎犬小队 add @调查员 @群主", as: "admin", atIds: [28800000001, 28800000002], expect: /已添加 2 名玩家至团队 猎犬小队/, note: "组队 add" },
  { id: "154", group: "全量审计", cmd: ".组队 猎犬小队 ra 侦查", as: "admin", validate: r => (r.allText.split("\n").filter(l => /1D100=/.test(l)).length === 2 ? null : "全队应每人一次检定"), note: "组队全队检定" },
  { id: "155", group: "全量审计", cmd: ".组队 猎犬小队 call", as: "admin", expect: /呼叫 猎犬小队：\[CQ:at,qq=28800000001\] \[CQ:at,qq=28800000002\]/, note: "组队呼叫" },
  { id: "156", group: "全量审计", cmd: ".组队 猎犬小队 clear", as: "admin", expect: /清空了团队 猎犬小队/, note: "组队清空" },
  { id: "157", group: "全量审计", cmd: ".stat", as: "admin", validate: r => (/检定统计/.test(r.allText) || /还没有检定记录/.test(r.allText) ? null : "应输出统计或无记录提示"), note: "团录统计" },
  { id: "158", group: "全量审计", cmd: ".who 甲 乙 丙", as: "member", validate: r => (/随机分配结果：/.test(r.allText) && new Set(r.allText.match(/→ (甲|乙|丙)/g)).size === 3 ? null : "应随机置换分配"), note: "who 随机分配" },
  { id: "159", group: "全量审计", cmd: ".ping", as: "member", expect: /pong！希洛在线/, note: "存活检测" },
  { id: "160", group: "别名合同", cmd: ".ra 偵查", as: "member", validate: r => (/偵查 检定：1D100=\d+\/25 /.test(r.allText) || /侦查 检定：1D100=\d+\/25 /.test(r.allText) ? null : "繁体偵查应按官方默认25判档"), note: "繁体别名+官方默认" },
  { id: "161", group: "别名合同", cmd: ".st 聆聽 45", as: "admin", expect: /人物卡已更新/, note: "繁体录入(admin卡未锁)" },
  { id: "162", group: "别名合同", cmd: ".ra 聆听", as: "admin", validate: r => (/聆听 检定：1D100=\d+\/45 /.test(r.allText) ? null : "简体检定应命中繁体录入的45"), note: "读写别名互通(候选键)" },
  { id: "163", group: "代骰", cmd: ".st san 50 侦查 65", as: "admin", atIds: [28800000003], expect: /人物卡已更新/, note: "代录成员卡" },
  { id: "164", group: "代骰", cmd: ".st show", as: "admin", atIds: [28800000003], expect: /侦查:65/, note: "代查成员卡" },
  { id: "165", group: "代骰", cmd: ".r 1d20", as: "admin", atIds: [28800000003], validate: r => (/掷骰：1D20=/.test(r.allText) ? null : "代掷应显示结果"), note: "代掷" },
  { id: "166", group: "代骰", cmd: ".sc 0/2", as: "admin", atIds: [28800000003], expect: /SAN Check[\s\S]*理智损失/, note: "代扣成员SAN" },
  { id: "167", group: "代骰", cmd: ".ra(1)50", as: "member", expect: /检定：1D100=\d+\/50 /, note: "表达式形式(N)M" },
  { id: "168", group: "梨骰命运", cmd: ".r d20优势", as: "member", expect: /2D20KH1\[\d+\+\d+=>\d+\]/, note: "d20优势=2d20kh(豹骰梨骰算符)" },
  { id: "169", group: "梨骰命运", cmd: ".r d20劣势", as: "member", expect: /2D20KL1\[\d+\+\d+=>\d+\]/, note: "d20劣势=2d20kl" },
  { id: "170", group: "梨骰命运", cmd: ".r f", as: "member", validate: r => (/4F\[[+\-0]{4}\]=[-\d]/.test(r.allText) ? null : "命运骰应显示4符号与总和"), note: "命运骰f" },
  { id: "171", group: "梨骰命运", cmd: ".r 3f", as: "member", validate: r => (/3F\[[+\-0]{3}\]/.test(r.allText) ? null : "3f 应掷3颗"), note: "命运骰数量前缀" }
)

// ---- 执行 ----
const results = []
let stepIndex = 0
for (const step of STEPS) {
  stepIndex += 1
  const privatesBefore = privates.length
  const filesBefore = fileUploads.length
  const { e, replies } = makeEvent(step.as, step.cmd)
  if (step.withAtBot) {
    e.message = [{ type: "at", data: { qq: String(SELF_ID) } }, { type: "text", data: { text: step.cmd } }]
  }
  if (step.atIds) {
    const head = step.cmd.split(/@\S+/)[0]
    e.message = [{ type: "text", data: { text: head } }, ...step.atIds.map(id => ({ type: "at", data: { qq: String(id) } }))]
  }
  const startedAt = Date.now()
  let outcome
  try {
    outcome = await dispatch(e)
  } catch (error) {
    outcome = { matched: [], consumed: false, thrown: String(error?.stack || error) }
  }
  const ms = Date.now() - startedAt
  const stepPrivates = privates.slice(privatesBefore)
  const stepFiles = fileUploads.slice(filesBefore)
  const replyText = replies.join("\n").trim()
  const privateText = stepPrivates.map(p => p.text).join("\n").trim()
  const allText = [replyText, privateText].filter(Boolean).join("\n")

  const problems = []
  if (outcome.thrown) problems.push(`处理函数抛错: ${outcome.thrown.split("\n")[0]}`)
  if (!outcome.consumed && step.expect !== null) problems.push("命令未被消费(无规则匹配或处理器返回 false)")
  if (step.expect && !step.expect.test(allText)) problems.push(`回复不符合预期 ${step.expect}`)
  if (step.validate) { const vErr = step.validate({ allText, replyText, privateText, files: stepFiles.map(f => `${f.via}:${f.name}`) }); if (vErr) problems.push(vErr) }
  if (step.expectPrivate && !stepPrivates.length) problems.push("预期有私聊发送但未发生")
  if (step.expectFile && !stepFiles.length) problems.push("预期有文件上传但未发生")
  if (!replyText && !stepPrivates.length && !stepFiles.length && step.expect !== null) problems.push("没有任何回复")

  results.push({
    id: step.id,
    group: step.group,
    cmd: step.cmd,
    as: step.as,
    fnc: outcome.matched.map(m => `${m.fnc}:${m.ret === true ? "consumed" : m.ret}`).join(",") || "(无匹配)",
    ms,
    replies: replyText.slice(0, 200),
    privateTo: stepPrivates.map(p => p.uid),
    files: stepFiles.map(f => `${f.via}:${f.name}`),
    pass: problems.length === 0,
    problems,
    note: step.note || ""
  })
}

// ---- 自检:团录文件应包含骰娘结果行(dice_result) ----
{
  const logDir = "/opt/coc-sim/plugins/shiloh-plugin/data/dice/logs/999000111"
  try {
    const fs2 = (await import("node:fs")).default
    const path2 = (await import("node:path")).default
    const files = fs2.readdirSync(logDir).filter(f => f.endsWith(".jsonl"))
    const newest = files.map(f => ({ f, m: fs2.statSync(path2.join(logDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0]
    const lines = newest ? fs2.readFileSync(path2.join(logDir, newest.f), "utf8").trim().split("\n").map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []
    const diceCount = lines.filter(l => l.type === "dice_result").length
    const hasCommand = lines.some(l => !l.type && /^\.r 1d20$/.test(String(l.content || "")))
    const ok = diceCount >= 2 && hasCommand
    results.push({
      id: "144", group: "结果入档", cmd: "(自动检查团录NDJSON)", as: "-",
      fnc: `dice_result=${diceCount}/${lines.length}`,
      ms: 0,
      replies: `最新团录 ${newest?.f || "无"}：${lines.length} 行，其中骰娘结果 ${diceCount} 条${hasCommand ? "，命令原文在档" : "，缺命令原文"}`,
      privateTo: [], files: [], pass: ok,
      problems: ok ? [] : ["团录未包含骰娘结果行(dice_result)"],
      note: "sealdice 语义:命令+结果成对入档"
    })
  } catch (error) {
    results.push({ id: "144", group: "结果入档", cmd: "(自动检查团录NDJSON)", as: "-", fnc: "读取失败", ms: 0, replies: "", privateTo: [], files: [], pass: false, problems: [String(error?.message || error)], note: "自检异常" })
  }
}

// ---- 输出 ----
const passed = results.filter(r => r.pass).length
const failed = results.filter(r => !r.pass)
console.log("=".repeat(100))
console.log(`COC 命令群模拟测试: ${passed}/${results.length} 通过  |  环境: 生产代码+线上配置副本, 测试群 ${GROUP_ID}, 数据隔离于 /opt/coc-sim`)
console.log("=".repeat(100))
for (const r of results) {
  const flag = r.pass ? "✅" : "❌"
  console.log(`${flag} [${r.id}] (${r.group}/${r.as}) ${r.cmd}  -> ${r.fnc}  ${r.ms}ms`)
  if (r.replies) console.log(`     回复: ${r.replies.replace(/\n/g, " ⏎ ").slice(0, 180)}`)
  if (r.privateTo.length) console.log(`     私聊: -> ${r.privateTo.join(",")}`)
  if (r.files.length) console.log(`     文件: ${r.files.join(", ")}`)
  if (!r.pass) console.log(`     问题: ${r.problems.join(" | ")}`)
  if (r.note) console.log(`     备注: ${r.note}`)
}
console.log("=".repeat(100))
if (failed.length) {
  console.log(`失败清单(${failed.length}):`)
  for (const r of failed) console.log(`  [${r.id}] ${r.cmd} -> ${r.problems.join(" | ")}`)
}
const warnLogs = logs.filter(l => l[0] === "warn" || l[0] === "error")
if (warnLogs.length) {
  console.log(`\n运行期 warn/error 日志(${warnLogs.length}, 前 20 条):`)
  for (const [, msg] of warnLogs.slice(0, 20)) console.log(`  [${msg.slice(0, 160)}]`)
}
import fs from "fs"
fs.writeFileSync("/opt/coc-sim/result.json", JSON.stringify({ passed, total: results.length, results, logs: logs.slice(0, 200) }, null, 2))
console.log(`\n明细已写入 /opt/coc-sim/result.json`)
process.exit(failed.length ? 1 : 0)
