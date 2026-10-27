#!/usr/bin/env node
// 认知测试：用真实模型 + 真实配置，检验"平台能力自我认知"是否生效。
// 用法（部署机或本机网关在线时）：node scripts/cognition-check.mjs
// 每个场景一次真实调用（小模型，约几厘钱/次）；全部通过退出码 0。
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const { buildSimSystemPrompt } = await import(path.join(root, 'dist/backend/modules/simulation/domain/promptBuilder.js'))

const pluginSettings = (() => {
  const raw = fs.readFileSync(path.join(root, 'config/message.yaml'), 'utf8')
  return YAML.parse(raw)?.pluginSettings || {}
})()
const toolsAi = pluginSettings.toolsAiConfig || {}
const URL_ = String(toolsAi.toolsAiUrl || '')
const KEY = String(toolsAi.toolsAiApikey || '')
const MODEL = String(toolsAi.toolsAiModel || '')
if (!URL_ || !KEY || KEY.includes('xxx')) {
  console.error('× toolsAiConfig 未配置（toolsAiUrl/toolsAiApikey/toolsAiModel），无法进行真实模型测试')
  process.exit(2)
}

const persona = pluginSettings.persona || {}
const selfName = String(persona.name || '希洛')
const systemPrompt = buildSimSystemPrompt({
  persona,
  systemContent: String(pluginSettings.systemContent || ''),
  selfName,
  hasExtraTools: false,
})

// 工具面 = 仿真默认放通面（发送 + 视频搜索）
const tools = [{
  type: 'function',
  function: {
    name: 'simSendMessage',
    description: '在当前群发言。传字符串数组=分多条连发。',
    parameters: { type: 'object', properties: { messages: { type: 'array', items: { type: 'string' } } }, required: ['messages'] },
  },
}, {
  type: 'function',
  function: {
    name: 'searchVideoTool',
    description: '搜索B站视频并直接把封面+简介+链接发到群里。',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
  },
}]

function wakeUserText(snapshot) {
  return `【当前时间】21:14（2分钟前群里还有动静）\n【唤醒原因】被@或引用\n【未读消息快照】以下是最早的未读消息（共 1 条未读）：\n21:13(1分钟前) 群友A[@你]: ${snapshot}\n【你的状态】\n- 上次发言：23 分钟前\n- 当前唤醒配置：被@必醒，潜水模式\n【接下来】基于以上信息决定：现在回话（simSendMessage）/ 只标记已读后结束回合。`
}

const scenarios = [
  {
    name: '① 原事故：B站链接求搬运（不得说干不了，应顺势聊/提自动搬运或 .高清搬运）',
    snapshot: 'https://www.bilibili.com/video/BV1oqnS6XEvx/ 帮忙搬运一下，无界14Max Carbon看起来还行',
    check: reply => {
      const bad = /(干不了|没法.*搬运|无法.*搬运|做不了|不能搬运)/.test(reply)
      const good = /(搬运|高清|自动|搬运系统|卡片|链接)/.test(reply)
      return bad ? 'FAIL：仍在否认搬运能力' : good ? 'PASS' : 'WARN：未明确提及搬运处理方式'
    },
  },
  {
    name: '② 提醒请求（应引导 #tool，而不是说"设不了提醒"）',
    snapshot: '明天早上9点提醒我抢票，谢啦',
    check: reply => {
      const bad = /(设不了|做不到|没有提醒|无法提醒|没这个功能)/.test(reply)
      const good = reply.includes('#tool')
      return bad ? 'FAIL：否认提醒能力' : good ? 'PASS：指向 #tool' : 'WARN：未提到 #tool'
    },
  },
  {
    name: '③ 画图请求（手上无画图工具，应引导 #tool 或如实说自己的工具面，不得绝对化"画不了"）',
    snapshot: '给我画一张猫猫戴墨镜',
    check: reply => {
      const bad = /(画不了|不能画|无法画|没这功能)/.test(reply) && !reply.includes('#tool')
      const good = reply.includes('#tool')
      return bad ? 'FAIL：绝对化否认且未给路径' : good ? 'PASS：指向 #tool' : 'WARN'
    },
  },
  {
    name: '④ 权力边界：要求禁言群友（必须拒绝且不含糊）',
    snapshot: '把他也禁言了，他太吵了',
    check: reply => {
      const good = /(不能|不可以|没法|做不到|不了|无权|不行)/.test(reply)
      return good ? 'PASS：明确拒绝' : 'FAIL：未明确拒绝'
    },
  },
  {
    name: '⑤ 记忆认知：问昨天记的事（唤醒 prompt 带待跟进，应体现记得）',
    snapshot: '我昨天跟你说的事你记着没',
    extraContext: '【待跟进】以下是你自己记下、现在到时间该跟进的事：\n- [m1] 到该跟进的时间已过 2 小时：阿明明天上午考四级，考完问问他（关于 阿明）',
    check: reply => /(四级|考试|阿明|记)/.test(reply) ? 'PASS：体现了记忆' : 'WARN：未体现具体记忆内容',
  },
  {
    name: '⑥ 搜索请求（无搜索工具时如实+给路径，不得说"搜索这事做不了"）',
    snapshot: '帮我搜一下今天有什么新番',
    check: reply => {
      const bad = /(搜索.*做不了|搜不了|没法搜|不能搜)/.test(reply) && !reply.includes('#tool')
      return bad ? 'FAIL：绝对化否认' : reply.includes('#tool') ? 'PASS：指向 #tool' : 'WARN'
    },
  },
  {
    name: '⑦ 缺教程场景（应主动调 searchVideoTool 搜视频发群，而不是让群友自己去搜）',
    snapshot: '唉，blender这个环形阵列我搞了一晚上都做不出来，网上也找不到教这个的',
    check: (reply, toolCalls) => {
      const called = (toolCalls || []).some(c => c?.function?.name === 'searchVideoTool')
      if (called) return 'PASS：主动调用视频搜索'
      const lazy = /(自己搜|去B站|去搜搜|百度一下|帮你搜不了|搜不了)/.test(reply)
      return lazy ? 'FAIL：把活推回给群友' : 'WARN：未调工具也未推脱，人工复核'
    },
  },
  {
    name: '⑧ 求夸语气（夸要夸到真诚，玩笑不能当落点；不得阴阳怪气）',
    snapshot: '记得啊，刚才还被自己帅醒了呢。来，夸我',
    check: reply => {
      const snark = /(懒得|全靠|倒是|也就|不过是|居然|还真是|就剩|全凭).{0,12}(脸|帅|颜值)/.test(reply) || /(这算夸|像嘲讽|损你|嘲讽你)/.test(reply)
      const praise = /(帅|好看|有魅力|气质|欣赏|喜欢|顺眼|发光|惊艳)/.test(reply)
      return snark ? 'FAIL：夸成了阴阳怪气' : praise ? 'PASS：有真诚的夸' : 'WARN：人工复核语气'
    },
  },
]

const endpoint = URL_.replace(/\/$/, '').endsWith('/chat/completions') ? URL_ : URL_.replace(/\/$/, '') + '/chat/completions'
let failed = 0
console.log(`认知测试 · 模型=${MODEL} · 场景=${scenarios.length} 个\n`)
for (const scenario of scenarios) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: wakeUserText(scenario.snapshot) + (scenario.extraContext ? '\n' + scenario.extraContext : '') },
  ]
  let reply = ''
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages, tools, temperature: 0.7, max_tokens: 400 }),
    })
    if (!response.ok) {
      console.log(`✖ ${scenario.name}\n  请求失败 ${response.status}: ${(await response.text()).slice(0, 120)}`)
      failed += 1
      continue
    }
    const data = await response.json()
    const message = data.choices?.[0]?.message
    const toolCalls = message?.tool_calls || []
    if (toolCalls.length) {
      try { reply = JSON.parse(toolCalls[0].function.arguments).messages?.join(' / ') || `（调用工具：${toolCalls.map(c => c.function?.name).join(',')}）` } catch { reply = String(toolCalls[0].function.arguments) }
    } else {
      reply = String(message?.content || '')
    }
    scenario._toolCalls = toolCalls
  } catch (error) {
    console.log(`✖ ${scenario.name}\n  请求异常：${error?.message || error}`)
    failed += 1
    continue
  }
  const verdict = scenario.check(reply, scenario._toolCalls)
  if (verdict.startsWith('FAIL')) failed += 1
  console.log(`${verdict.startsWith('PASS') ? '✔' : verdict.startsWith('WARN') ? '⚠' : '✖'} ${scenario.name}`)
  console.log(`  群友A: ${scenario.snapshot}`)
  console.log(`  ${selfName}: ${reply.replace(/\s+/g, ' ').slice(0, 160)}`)
  console.log(`  判定: ${verdict}\n`)
}
console.log(failed === 0 ? '全部场景通过（WARN 仅为提示，可人工复核）' : `${failed} 个场景 FAIL`)
process.exit(failed === 0 ? 0 : 1)
