// 仿真模式（自主仿真会话）单例装配：dist 工厂 + Yunzai 全局注入。
// 借鉴 qq-bridge reserved2「一切皆工具」——消息不自动转发，AI 用工具自主读/发/等/设唤醒。
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createPersonaLibrary } from '../dist/backend/modules/conversation/infrastructure/personaLibrary.js'
import { decodeHostConfig } from '../dist/backend/modules/host/infrastructure/hostConfig.js'
import { getMidtermMemoryManager } from '../dist/backend/modules/memory/infrastructure/MidtermSummaryManager.js'
import { recallEpisodes, buildEpisodicPrompt, recordEpisode } from '../dist/backend/modules/memory/infrastructure/episodicMemory.js'
import { buildMemeExtractionPrompt } from '../dist/backend/modules/simulation/domain/simMemory.js'
import { localToolRegistry } from './LocalToolRegistry.js'
import { ExpressionLearner } from '../domains/memory/ExpressionLearner.js'
import { globalStyleLearnerManager } from '../domains/memory/GlobalStyleLearnerManager.js'
import { YTapi } from './apiClient.js'
import { tokenLedger } from './tokenLedger.js'
import { sideLLMCall } from '../dist/backend/adapters/sideLLM.js'
import path from 'node:path'
import fs from 'node:fs'
import YAML from 'yaml'

const logger = globalThis.logger
// 插件根目录:优先环境变量,其次按本文件位置定位——独立控制台进程 cwd 不是云崽根,不能依赖 process.cwd()
const pluginRoot = process.env.CONSOLE_PLUGIN_ROOT
  || path.resolve(path.dirname(new URL('.', import.meta.url).pathname), '..')
// bot 进程内走 model/config.js(带云崽配置联动);独立控制台进程没有云崽 cwd,导入会失败——降级直读 yaml(默认值+用户值合并)
let modelConfig = null
if (globalThis.Bot) {
  // 仅 bot 进程走 model/config.js(带云崽配置联动);控制台进程导入虽不抛错但内部路径按错误 cwd 解析,会读到空配置
  try { modelConfig = (await import('../model/config.js')).default } catch { modelConfig = null }
}

const expressionLearner = new ExpressionLearner()
let styleDigestCache = { key: '', at: 0, text: '' }

export function readPluginSettings() {
  if (modelConfig) {
    const raw = modelConfig.getConfig('message')
    return raw && typeof raw === 'object' ? raw.pluginSettings || {} : {}
  }
  try {
    const read = file => YAML.parse(fs.readFileSync(file, 'utf8'))?.pluginSettings || {}
    return { ...read(path.join(pluginRoot, 'config_default/message.yaml')), ...read(path.join(pluginRoot, 'config/message.yaml')) }
  } catch { return {} }
}

const personaLibrary = createPersonaLibrary({
  libraryPath: path.join(pluginRoot, 'config/persona-library.yaml'),
  getBasePersona: () => ({ ...(readPluginSettings().persona || {}) }),
  logger: { error: (...args) => logger?.error?.(...args) }
})

function currentBot() {
  const Bot = globalThis.Bot
  if (!Bot) return { id: '', name: '' }
  const primary = Array.isArray(Bot.uin) ? Bot.uin[0] : Bot.uin
  let nickname = String(Bot.nickname || '')
  if (!nickname && Bot.bots) {
    const entry = Object.values(Bot.bots).find(b => b && typeof b === 'object' && b.uin !== undefined)
    nickname = String(entry?.nickname || '')
  }
  return { id: String(primary ?? ''), name: nickname }
}

function botById(hint) {
  const Bot = globalThis.Bot
  if (!Bot?.bots) return null
  const entry = Object.values(Bot.bots).find(b => b && String(b.uin) === String(hint))
  return entry || null
}

// bot 进程用 Yunzai 全局 redis;独立控制台进程没有 globalThis.redis——按需自建本机连接(与 bot 同实例,键互通)。
// 代理按方法名惰性转发,避免装配期就连 redis;连接失败时各调用自行报错,不炸控制台进程。
function lazyRedis() {
  if (globalThis.redis) return globalThis.redis
  let client = null
  const connect = async () => {
    if (!client) {
      const { createClient } = await import('redis')
      client = createClient({ url: process.env.CONSOLE_SIM_REDIS_URL || 'redis://127.0.0.1:6379' })
      client.on('error', () => {})
      await client.connect()
    }
    return client
  }
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return (...args) => connect().then(connected => connected[prop](...args))
    }
  })
}

export const simulationRuntime = createSimulationRuntime({
  logger,
  redis: lazyRedis(),
  getSection: () => readPluginSettings().simulation || {},
  getExecutionConfig: () => {
    try {
      return decodeHostConfig(readPluginSettings())
    } catch (error) {
      logger?.warn?.(`[仿真] 宿主配置解码失败，使用原始配置：${error?.message || error}`)
      return readPluginSettings()
    }
  },
  // 人设名优先:QQ 昵称常是"这里是希洛!"这类长句,而群友只叫"希洛"——
  // nameMention 按 name 做 includes 匹配,用长昵称会导致点名永远唤不醒(实测 11-29 瓦尔哈拉哑火)。
  // 短名匹配同时覆盖全名场景(包含关系)。
  getSelf: (selfIdHint) => {
    const personaName = String(readPluginSettings().persona?.name || '').trim()
    const hint = String(selfIdHint ?? '')
    if (hint) {
      const entry = botById(hint)
      return { id: hint, name: personaName || String(entry?.nickname || currentBot().name || '') }
    }
    const bot = currentBot()
    return { id: bot.id, name: personaName || bot.name || '' }
  },
  YTapi: (requestData, execConfig) => YTapi(requestData, execConfig),
  // B站卡片分享:按关键词或链接解析视频并生成 QQ 卡片 JSON(搜索走 B站开放接口,图片由 QQ 客户端自行加载)
  resolveBilibiliCard: async (input) => {
    try {
      const { extractBilibiliBvid, ensureBilibiliBuvidCookie } = await import('../dist/backend/modules/media/infrastructure/bilibiliMessage.js')
      const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      const baseHeaders = { 'user-agent': UA, referer: 'https://www.bilibili.com', accept: 'application/json' }
      let bvid = input?.url ? extractBilibiliBvid(String(input.url)) : ''
      if (!bvid && input?.query) {
        // B站风控:无设备指纹 cookie 的搜索会被 412/HTML 拦——先 finger/spi 拿 buvid3/4 再搜(与 SearchVideoTool 同姿势)
        let cookieHeader = ''
        try {
          const spi = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'user-agent': UA, Referer: 'https://www.bilibili.com' }, signal: AbortSignal.timeout(10000) })
          const spiData = (await spi.json())?.data || {}
          if (spiData.b_3 && spiData.b_4) cookieHeader = `buvid3=${spiData.b_3}; buvid4=${spiData.b_4}`
        } catch { /* 拿不到指纹就裸搜 */ }
        const searchUrl = `https://api.bilibili.com/x/web-interface/search/type?keyword=${encodeURIComponent(String(input.query).slice(0, 60))}&search_type=video`
        const searchHeaders = referer => ({ accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN,zh;q=0.9', Referer: referer, 'user-agent': UA, ...(cookieHeader ? { cookie: cookieHeader } : {}) })
        let raw = await fetch(searchUrl, { headers: searchHeaders('https://www.bilibili.com'), signal: AbortSignal.timeout(15000) }).then(r => r.text()).catch(() => '')
        if (raw.trimStart().startsWith('<!DOCTYPE') || raw.includes('request was banned')) {
          raw = await fetch(searchUrl, { headers: searchHeaders('https://search.bilibili.com'), signal: AbortSignal.timeout(15000) }).then(r => r.text()).catch(() => '')
        }
        let first = null
        try {
          const json = JSON.parse(raw)
          if (Number(json.code) === -412) return { ok: false, error: 'B站搜索触发风控,稍后再试' }
          first = (json.data?.result || []).find?.(item => item?.bvid)
        } catch { /* 非JSON=风控页 */ }
        if (!first) return { ok: false, error: `B站没搜到「${input.query}」相关的视频(或被风控拦截)` }
        bvid = String(first.bvid)
      }
      if (!bvid) return { ok: false, error: '无法从输入解析出B站视频' }
      const view = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
        headers: baseHeaders, signal: AbortSignal.timeout(15000)
      }).then(r => r.json()).catch(() => null)
      const data = view?.data
      if (Number(view?.code) !== 0 || !data?.bvid) return { ok: false, error: 'B站视频信息获取失败' }
      const title = String(data.title || 'B站视频').replace(/[\n\r\[\]]/g, ' ').slice(0, 40)
      const owner = String(data.owner?.name || '')
      const views = Number(data.stat?.view) || 0
      const desc = `${owner}${views ? ` · ${views >= 10000 ? (views / 10000).toFixed(1) + '万' : views}播放` : ''}`.slice(0, 40)
      const card = {
        app: 'com.tencent.structmsg', view: 'news', ver: '0.0.0.1',
        prompt: `[分享] ${title}`,
        meta: { news: { appid: '100951776', style: 2, cta: '去看看', title, desc, preview: String(data.pic || ''), jump_url: `https://www.bilibili.com/video/${data.bvid}`, tag: '哔哩哔哩', app_type: 1 } },
        config: { type: 'normal', forward: true, autosize: true },
      }
      return { ok: true, title, cardJson: JSON.stringify(card) }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  },

  // 看图转述：仿真主模型多为纯文本(实测 glm-5.3 收 image_url 直接 400),图片经视觉模型(analysisApiConfig)转文字注入
  describeImages: async (images, context) => {
    const cfg = readPluginSettings().analysisAiConfig || {}
    if (!cfg.analysisApiUrl || !cfg.analysisApiKey || cfg.analysisApiKey === 'sk-xxxxx' || !cfg.analysisApiModel) return null
    const content = [
      { type: 'text', text: `用中文简洁描述这几张图片的关键信息(每张一行,总共不超过120字),供群聊机器人接话参考:${context?.label || ''}` },
      ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }))
    ]
    const result = await sideLLMCall({ url: cfg.analysisApiUrl, apikey: cfg.analysisApiKey, model: cfg.analysisApiModel, messages: [{ role: 'user', content }], temperature: 0.2, maxTokens: 300, timeoutMs: 30000 })
    return result.ok ? result.content : null
  },
  sendGroupMessage: async (groupId, segments) => {
    const Bot = globalThis.Bot
    try {
      const group = Bot?.pickGroup?.(Number(groupId))
      if (!group?.sendMsg) return { ok: false, error: '群对象不可用' }
      const ret = await group.sendMsg(segments)
      // 回执 message_id：表情包等额外工具靠它确认投递（TRSS sendMsg 返回 {message_id} 或 {data:{message_id}}）
      const messageId = ret?.message_id ?? ret?.data?.message_id ?? null
      return { ok: true, ...(messageId !== null && messageId !== undefined ? { messageId: String(messageId) } : {}) }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  },
  getPersona: (groupId, selfId) => {
    const settings = readPluginSettings()
    const resolved = personaLibrary.resolve({ messageType: 'group', groupId: String(groupId), selfId: String(selfId) })
    return {
      persona: resolved?.persona || settings.persona || {},
      systemContent: String(settings.systemContent || ''),
    }
  },
  // extraTools 白名单：从 localToolRegistry 快照取实例（含 custom_tools 热加载）
  getExtraTools: (names) => {
    const snapshot = localToolRegistry.getSnapshot()
    return names
      .map(name => snapshot.toolInstances[name])
      .filter(tool => !!tool)
  },
  // 按人挖口头禅的数据源：读归档近 N 天消息（data/message_archive/group/{gid}/日期.ndjson）
  readArchiveMessages: async (groupId, days) => {
    try {
      const fs = (await import('node:fs')).default
      const path = (await import('node:path')).default
      const base = path.join(pluginRoot, 'data/message_archive/group', String(groupId))
      const out = []
      for (let i = 0; i < Math.min(14, Math.max(1, days)); i += 1) {
        const d = new Date(Date.now() - i * 86400000 + 8 * 3600000)
        const file = path.join(base, d.toISOString().slice(0, 10) + '.ndjson')
        if (!fs.existsSync(file)) continue
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-500)
        for (const line of lines) {
          try {
            const r = JSON.parse(line)
            const text = String(r?.raw_message || r?.msg || '')
            const userId = String(r?.user_id || '')
            if (userId && text && !/^[#.\/]/.test(text)) out.push({ userId, text: text.slice(0, 160) })
          } catch { /* 坏行跳过 */ }
          if (out.length >= 3000) return out
        }
      }
      return out
    } catch {
      return []
    }
  },
  // 说话风格参考：群级表达学习（这群人怎么说话）+ 全局表达学习（跨群沉淀的表达策略）
  getStyleDigest: async (groupId) => {
    const key = String(groupId || '')
    const now = Date.now()
    if (styleDigestCache.key === key && now - styleDigestCache.at < 60_000) return styleDigestCache.text
    const settings = readPluginSettings()
    let text = ''
    try {
      const group = await expressionLearner.getExpressionPromptForGroup(key)
      if (group) text += group
    } catch { /* 群级学习不可用则跳过 */ }
    try {
      const global = globalStyleLearnerManager?.buildPrompt?.(settings.globalStyleLearning || {})
      if (global) text += (text ? '\n' : '') + global
    } catch { /* 全局学习不可用则跳过 */ }
    text = String(text || '').slice(0, 1200)
    styleDigestCache = { key, at: now, text }
    return text
  },
  // 中期记忆的"本群近期主线"
  getGroupDigest: (groupId) => {
    try {
      return getMidtermMemoryManager()?.getSummaryPrompt?.(String(groupId)) || ''
    } catch {
      return ''
    }
  },
  // 近两天情节时间线（"这两天聊过/做过什么"）
  getRecentEpisodesText: (groupId) => {
    try {
      const episodes = recallEpisodes({ groupId: String(groupId), days: 2, limit: 6 })
      return episodes.length ? buildEpisodicPrompt(episodes) : ''
    } catch {
      return ''
    }
  },
  // 仿真回合补记情节（仿真群不走主链路，主链路的 recordEpisode 不会触发）
  recordEpisode: (input) => {
    try {
      recordEpisode({
        groupId: input.groupId,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.userName ? { userName: input.userName } : {}),
        summary: input.summary,
        reply: input.reply,
      })
    } catch (error) {
      logger?.warn?.(`[仿真] 情节补记失败：${error?.message || error}`)
    }
  },
  // 本群专属梗提取：memoryAiConfig 小模型单次调用（不出机：只喂群内消息，不联网）
  // 令牌账本：仿真回合/梗提取的归组记录 + 当日花费查询（预算闸）
  recordTokens: input => { try { tokenLedger.record({ scope: input.scope, stage: input.stage, model: input.model, usage: input.usage, ms: input.ms }) } catch { /* 账本不可用 */ } },
  getTodaySpendCny: scope => { try { return tokenLedger.todayCostOfScope(String(scope)) } catch { return 0 } },
  // 仿真回合表情冷却：与主链路同参（emojiSystem.postSendCooldownMs，默认 90s）
  getEmojiCooldownMs: () => Number(readPluginSettings().emojiSystem?.postSendCooldownMs) || 90000,
  // 图片下载（simGetMessageImages）：限 http(s)、2MB、15s 超时
  fetchImageBase64: async url => {
    try {
      const target = String(url || '')
      if (!/^https?:\/\//.test(target)) return { error: '仅支持 http(s) 图片' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(target, { signal: controller.signal })
      clearTimeout(timer)
      if (!response.ok) return { error: `下载失败 ${response.status}` }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > 2 * 1024 * 1024) return { error: '图片超过 2MB' }
      const mime = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
      if (!String(mime).startsWith('image/')) return { error: `非图片内容 ${mime}` }
      return { mime: String(mime), base64: buffer.toString('base64') }
    } catch (error) {
      return { error: error?.message || String(error) }
    }
  },
  // 戳群成员（TRSS pickGroup.pokeMember）
  pokeMember: async (groupId, userId) => {
    try {
      const group = globalThis.Bot?.pickGroup?.(Number(groupId))
      if (typeof group?.pokeMember !== 'function') return { ok: false, error: '当前适配器不支持戳一戳' }
      await group.pokeMember(Number(userId))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  },
  // 群成员列表（TRSS pickGroup.getMemberMap）
  getGroupMembers: async groupId => {
    const group = globalThis.Bot?.pickGroup?.(Number(groupId))
    const map = await group?.getMemberMap?.()
    if (!map || typeof map[Symbol.iterator] !== 'function') return []
    const out = []
    for (const [userId, info] of map) {
      out.push({ userId: String(userId), nick: String(info?.card || info?.nickname || info?.nick || userId || '') })
      if (out.length >= 120) break
    }
    return out
  },
  // 合并转发内容（OneBot get_forward_msg → 纯函数渲染：媒体标记化、内嵌转发可递归）
  getForwardContent: async forwardId => {
    try {
      const Bot = globalThis.Bot
      const raw = await (Bot?.getForwardMsg?.(forwardId) ?? Bot?.pickFriend?.(0)?.getForwardMsg?.(forwardId))
      const nodes = Array.isArray(raw) ? raw : Array.isArray(raw?.message) ? raw.message : []
      if (!nodes.length) return { lines: [], error: '转发内容为空或解析失败' }
      const { renderForwardNodes } = await import('../dist/backend/modules/simulation/domain/forwardView.js')
      const rendered = renderForwardNodes(nodes)
      return {
        lines: rendered.lines,
        total: rendered.total,
        ...(rendered.truncated ? { truncated: true } : {}),
        ...(rendered.nestedForwardIds.length ? { nestedForwardIds: rendered.nestedForwardIds } : {}),
        ...(rendered.imageUrls.length ? { imageUrls: rendered.imageUrls } : {}),
      }
    } catch (error) {
      return { lines: [], error: error?.message || String(error) }
    }
  },
  // 精选收藏表情（下载 → emojiPackManager.addFromBuffer 走 VLM 审核打标管线）
  collectStickerImage: async (groupId, url) => {
    try {
      const { emojiPackManager } = await import('../domains/emoji/EmojiPackManager.js')
      if (!emojiPackManager?.config?.enabled) return { ok: false, error: '表情包系统未启用' }
      const response = await fetch(String(url), { signal: AbortSignal.timeout(15000) })
      if (!response.ok) return { ok: false, error: `下载失败 ${response.status}` }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > 5 * 1024 * 1024) return { ok: false, error: '图片超过 5MB' }
      const result = await emojiPackManager.addFromBuffer(buffer, { source: 'sim' })
      return { ok: !String(result?.reason || '').includes('reject') }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  },
  memeExtract: async (messages) => {
    const cfg = readPluginSettings().memoryAiConfig || {}
    if (!cfg.memoryAiUrl || !cfg.memoryAiApikey || cfg.memoryAiApikey === 'sk-xxxxx' || !cfg.memoryAiModel) {
      throw new Error('memoryAiConfig 未配置，梗提取不可用')
    }
    const result = await sideLLMCall({
      url: cfg.memoryAiUrl,
      apikey: cfg.memoryAiApikey,
      model: cfg.memoryAiModel,
      messages: [
        { role: 'system', content: '你是群聊梗提取器，只输出 JSON 数组，不输出任何其他内容。' },
        { role: 'user', content: buildMemeExtractionPrompt(messages) },
      ],
      temperature: 0.2,
      maxTokens: 400,
      timeoutMs: 15000,
    })
    if (!result.ok) throw new Error(result.error)
    return result.content
  },
})

export const SIMULATION_COMMAND_HELP = [
  '【仿真模式命令】（群管理/主人）',
  '.仿真 开 —— 本群切换为仿真模式（AI 自主收发消息）',
  '.仿真 关 —— 本群切回普通模式',
  '.仿真 模式 仅@ / 自主 —— 回复模式：仅被@才回（仍看全部消息）或观察全部消息自主插话',
  '.仿真 状态 —— 查看唤醒配置/水位/预算',
  '.仿真 记忆 —— 查看 AI 的长期记忆（待跟进/记事/印象）',
  '.仿真 重置 —— 清空本群仿真会话（历史/水位/预算；记忆与好感度保留）',
  '.好感度 —— 查看群友好感排行（自己的会标在末尾）',
].join('\n')

export function parseSimulationCommand(text) {
  const match = String(text || '').trim().match(/^\.仿真\s*(开|关|状态|重置|记忆|帮助|模式)?(?:\s+(仅@|自主))?/)
  if (!match) return null
  return { action: match[1] || '帮助', mode: match[2] }
}

export function isSimulationManager(e) {
  if (!e) return false
  if (e.isMaster) return true
  const role = e?.sender?.role
  return role === 'admin' || role === 'owner'
}

export async function startSimulationRuntime() {
  try {
    await simulationRuntime.start()
  } catch (error) {
    logger?.error?.('[仿真] 启动失败（本周期仿真模式不可用）', error)
  }
}
