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
  { id: "71", group: "开关", cmd: ".bot off", as: "admin", expect: /关闭|off|已/i },
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
  { id: "122", group: "随机姓名", cmd: ".name jp 2", as: "member", expect: /随机姓名（日文）：/ }
]

// ---- 执行 ----
const results = []
let stepIndex = 0
for (const step of STEPS) {
  stepIndex += 1
  const privatesBefore = privates.length
  const filesBefore = fileUploads.length
  const { e, replies } = makeEvent(step.as, step.cmd)
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
