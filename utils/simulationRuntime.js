// 仿真模式（自主仿真会话）单例装配：dist 工厂 + Yunzai 全局注入。
// 借鉴 qq-bridge reserved2「一切皆工具」——消息不自动转发，AI 用工具自主读/发/等/设唤醒。
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { resolveCharacterConsistencyRoute } from '../dist/backend/modules/simulation/infrastructure/characterConsistencyRouting.js'
import { createPersonaLibrary } from '../dist/backend/modules/conversation/infrastructure/personaLibrary.js'
import { decodeHostConfig } from '../dist/backend/modules/host/infrastructure/hostConfig.js'
import { getMidtermMemoryManager } from '../dist/backend/modules/memory/infrastructure/MidtermSummaryManager.js'
import { recallEpisodes, buildEpisodicPrompt, recordEpisode } from '../dist/backend/modules/memory/infrastructure/episodicMemory.js'
import { buildMemeExtractionPrompt } from '../dist/backend/modules/simulation/domain/simMemory.js'
import { localToolRegistry } from './LocalToolRegistry.js'
import { ExpressionLearner } from '../domains/memory/ExpressionLearner.js'
import { globalStyleLearnerManager } from '../domains/memory/GlobalStyleLearnerManager.js'
import { YTapi } from './apiClient.js'
import { createCharacterWorkerGateway } from '../dist/backend/modules/simulation/infrastructure/characterWorkerGateway.js'
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

function scopedBot(selfId) {
  if (!selfId) return globalThis.Bot
  const account = botById(selfId)
  if (account) return account
  return String(globalThis.Bot?.uin || '') === String(selfId) ? globalThis.Bot : null
}

// bot 进程用 Yunzai 全局 redis;独立控制台进程没有 globalThis.redis——按需自建本机连接(与 bot 同实例,键互通)。
// 代理按方法名惰性转发,避免装配期就连 redis;连接失败时各调用自行报错,不炸控制台进程。
export function lazyRedis() {
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
  getStyleBotUserIds: () => {
    try {
      const ids = [...(readPluginSettings().botUserIds || [])]
      const bots = globalThis.Bot?.bots || {}
      for (const key of Object.keys(bots)) if (/^\d+$/.test(key)) ids.push(key)
      if (globalThis.Bot?.uin) ids.push(String(globalThis.Bot.uin))
      return ids
    } catch { return [] }
  },
  getSection: () => readPluginSettings().simulation || {},
  getExecutionConfig: () => {
    try {
      const decoded = decodeHostConfig(readPluginSettings())
      // 仿真回合模型降档开关：simulation.turnModel 覆盖 tools 后端的模型（agent 回合实际读 toolsAiModel）
      const turnModel = String((readPluginSettings().simulation || {}).turnModel || '').trim()
      if (turnModel && decoded.toolsAiConfig) {
        return { ...decoded, toolsAiConfig: { ...decoded.toolsAiConfig, toolsAiModel: turnModel } }
      }
      return decoded
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
  reflectCharacter: (requestData, execConfig, signal) => YTapi(requestData, { ...execConfig, useTools: false }, undefined, undefined, {
    taskBackend: 'memory', signal, generation: { maxOutputTokens: 1200 },
  }),
  judgeSocialPermission: (requestData, execConfig, signal) => YTapi(requestData, { ...execConfig, useTools: false }, undefined, undefined, {
    taskBackend: 'memory', signal, generation: { maxOutputTokens: 300 },
  }),
  reviewCharacter: (requestData, execConfig, signal) => {
    const route = resolveCharacterConsistencyRoute(execConfig)
    return YTapi(requestData, route.config, undefined, undefined, {
      taskBackend: route.taskBackend, signal, generation: { maxOutputTokens: 900 },
    })
  },
  characterWorkerAvailable: () => {
    const worker = readPluginSettings().simulation?.worker
    return worker?.enabled === true && !!worker.endpoint
  },
  runCharacterWorker: (task, scope, signal) => {
    const worker = readPluginSettings().simulation?.worker
    if (worker?.enabled !== true || !worker.endpoint) throw new Error('工作器未配置或已停用')
    return createCharacterWorkerGateway({ endpoint: worker.endpoint, token: worker.token || '' })(task, scope, signal)
  },
  // B站卡片分享:按关键词或链接解析视频并生成 QQ 卡片 JSON(搜索走 B站开放接口,图片由 QQ 客户端自行加载)
  resolveBilibiliCard: async (input) => {
    try {
      const { extractBilibiliBvid, ensureBilibiliBuvidCookie } = await import('../dist/backend/modules/media/infrastructure/bilibiliMessage.js')
      const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      // B站风控收紧(实测 2026-11-03):view 详情接口裸请求也 -412——统一取 finger/spi 指纹
      // (ensureBilibiliBuvidCookie 自带 TTL 缓存与并发去重)，搜索与详情共用同一 cookie。
      let cookieHeader = ''
      try { cookieHeader = String(await ensureBilibiliBuvidCookie(fetch) || '') } catch { /* 拿不到指纹就裸试 */ }
      const baseHeaders = { 'user-agent': UA, referer: 'https://www.bilibili.com', accept: 'application/json', ...(cookieHeader ? { cookie: cookieHeader } : {}) }
      let bvid = input?.url ? extractBilibiliBvid(String(input.url)) : ''
      if (!bvid && input?.query) {
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
      // 番剧 URL（/bangumi/play/ss 或 ep）：走 pgc season API，卡片跳番剧页（先于 bvid 检查——番剧没有 BV 号）
      const bangumiMatch = String(input?.url || '').match(/bangumi\/play\/(?:ss(\d+)|ep(\d+))/)
      if (bangumiMatch) {
        const ssId = bangumiMatch[1] || ''
        const seasonUrl2 = ssId
          ? `https://api.bilibili.com/pgc/view/web/season?season_id=${ssId}`
          : `https://api.bilibili.com/pgc/view/web/season?ep_id=${bangumiMatch[2] || ''}`
        const seasonData = await fetch(seasonUrl2, { headers: baseHeaders, signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null)
        const sResult = seasonData?.result
        if (sResult?.title) {
          const bTitle = String(sResult.title || 'B站番剧').replace(/[\n\r[\]]/g, ' ').slice(0, 40)
          const bDesc = String(sResult.newest_ep?.desc || `${(sResult.episodes || []).length}集`).slice(0, 40)
          const bCard = {
            app: 'com.tencent.structmsg', view: 'news', ver: '0.0.0.1',
            prompt: `[分享] ${bTitle}`,
            meta: { news: { appid: '100951776', style: 2, cta: '去看番', title: bTitle, desc: bDesc, preview: String(sResult.cover || ''), jump_url: `https://www.bilibili.com/bangumi/play/ss${ssId || sResult.season_id}`, tag: '哔哩哔哩', app_type: 1 } },
            config: { type: 'normal', forward: true, autosize: true },
          }
          return { ok: true, title: bTitle, cardJson: JSON.stringify(bCard) }
        }
        return { ok: false, error: '番剧信息获取失败' }
      }
      if (!bvid) return { ok: false, error: '无法从输入解析出B站视频' }
      const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
      let view = await fetch(viewUrl, { headers: baseHeaders, signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null)
      // -412 兜底：换 search 域 Referer 重试一次（指纹缓存过期或风控抖动时仍有机会过）
      if (Number(view?.code) === -412) {
        view = await fetch(viewUrl, { headers: { ...baseHeaders, referer: 'https://search.bilibili.com' }, signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null)
      }
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
  sendGroupMessage: async (groupId, segments, selfId) => {
    // B2 排队动作发送前重查权限：入队时的校验约束不了排队等待期间的变化
    // （qq-bridge 5551e74：guard 在实际发送前重查静默/暂停/总开关）
    const settings = readPluginSettings()
    const simCfg = settings.simulation || {}
    if (simCfg.enabled === false) return { ok: false, error: '仿真模式已关闭' }
    if (Array.isArray(simCfg.groups) && simCfg.groups.length > 0 && !simCfg.groups.map(String).includes(String(groupId))) {
      // allGroups 模式不检查群清单，只有显式清单才检查
    }
    let attempted = false
    try {
      const group = scopedBot(selfId)?.pickGroup?.(Number(groupId))
      if (!group?.sendMsg) return { ok: false, error: '群对象不可用' }
      attempted = true
      const ret = await group.sendMsg(segments)
      // 回执 message_id：表情包等额外工具靠它确认投递（TRSS sendMsg 返回 {message_id} 或 {data:{message_id}}）
      const messageId = ret?.message_id ?? ret?.data?.message_id ?? null
      return { ok: true, ...(messageId !== null && messageId !== undefined ? { messageId: String(messageId) } : {}) }
    } catch (error) {
      // Once handed to the platform, an exception cannot prove non-delivery.
      return { ok: false, ...(attempted ? { unknown: true } : {}), error: error?.message || String(error) }
    }
  },
  getPersona: (groupId, selfId) => {
    const settings = readPluginSettings()
    const resolved = personaLibrary.resolve({ messageType: 'group', groupId: String(groupId), selfId: String(selfId) })
    return {
      personaId: resolved?.id || 'default',
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
  // toolPolicy open 模式的默认能力面：内置注册表名（builtInToolNames 由 JS 子类构造时的工厂填充）
  listRegistryToolNames: () => ({
    builtIn: [...localToolRegistry.builtInToolNames],
    all: Object.keys(localToolRegistry.getSnapshot().toolInstances),
  }),
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
  // 委托记忆（群友托付记的事，原文锚定）：独立控制台进程没有 redis 时降级为空
  loadDelegatedMemories: async (groupId) => {
    try {
      const { delegatedMemoryStore } = await import('../functions/functions_tools/DelegateMemoryTool.js')
      return await delegatedMemoryStore.load(String(groupId))
    } catch {
      return []
    }
  },
  // 长程语义召回：混合检索"两天情节窗之外"的更早相关片段（runtime 侧 1s 预算兜底，这里再给检索器 850ms）
  getSemanticRecall: async (groupId, query) => {
    try {
      const { getSemanticMemoryRuntime } = await import('../dist/backend/modules/memory/infrastructure/semanticRuntime.js')
      const runtime = getSemanticMemoryRuntime()
      if (!runtime?.retriever) return ''
      const result = await runtime.retriever.search(String(groupId), String(query || ''), { topK: 2, timeoutMs: 850 })
      const items = Array.isArray(result?.items) ? result.items : []
      const lines = items.map(item => {
        const text = String(item?.chunk?.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        return text ? `- ${text}` : ''
      }).filter(Boolean)
      return lines.slice(0, 2).join('\n')
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
  pokeMember: async (groupId, userId, selfId) => {
    try {
      const group = scopedBot(selfId)?.pickGroup?.(Number(groupId))
      if (typeof group?.pokeMember !== 'function') return { ok: false, error: '当前适配器不支持戳一戳' }
      await group.pokeMember(Number(userId))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  },
  // 生活线真实数据源：B 站番剧搜索定位 + 季详情同步（真实单集简介 + 观众热评，分块标注）
  lifeThreadResolve: async ({ title }) => {
    try {
      const { ensureBilibiliBuvidCookie } = await import('../dist/backend/modules/media/infrastructure/bilibiliMessage.js')
      const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      let cookie = ''
      try { cookie = String(await ensureBilibiliBuvidCookie(fetch) || '') } catch {}
      const headers = { 'user-agent': UA, Referer: 'https://search.bilibili.com', accept: 'application/json', ...(cookie ? { cookie } : {}) }
      const url = `https://api.bilibili.com/x/web-interface/search/type?keyword=${encodeURIComponent(String(title || '').slice(0, 40))}&search_type=media_bangumi`
      const raw = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }).then(r => r.text()).catch(() => '')
      if (raw.trimStart().startsWith('<!DOCTYPE')) return { ok: false, error: 'B站搜索被风控拦截（稍后再试）' }
      const json = JSON.parse(raw)
      const results = (json.data?.result || []).filter(r => r?.season_id)
      if (!results.length) return { ok: false, error: `B站没搜到「${title}」` }
      // 取第一个非中配/配音版的（标题中不包含"中配""配音"）
      const pick = results.find(r => !/中配|配音/.test(String(r.title || ''))) || results[0]
      return { ok: true, sourceId: String(pick.season_id), title: String(pick.title || '').replace(/<[^>]+>/g, '') }
    } catch (error) { return { ok: false, error: error?.message || String(error) } }
  },

  lifeThreadSync: async ({ sourceId, title, lastEpisode }) => {
    try {
      const { ensureBilibiliBuvidCookie } = await import('../dist/backend/modules/media/infrastructure/bilibiliMessage.js')
      const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      let cookie = ''
      try { cookie = String(await ensureBilibiliBuvidCookie(fetch) || '') } catch {}
      const headers = { 'user-agent': UA, Referer: 'https://www.bilibili.com', accept: 'application/json', ...(cookie ? { cookie } : {}) }
      const seasonUrl = `https://api.bilibili.com/pgc/view/web/season?season_id=${encodeURIComponent(sourceId)}`
      const raw = await fetch(seasonUrl, { headers, signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null)
      const result = raw?.result || {}
      const eps = result.episodes || []
      if (!eps.length) return { newNotes: [] }
      const lastEp = eps[eps.length - 1]
      const epNum = parseInt(String(lastEp?.title || '0'), 10) || 0
      const newNotes = []
      // 有新集 → 记官方简介 + 观众热评（分块标注）
      if (epNum > (lastEpisode || 0)) {
        const ts = lastEp?.pub_time || 0
        const dt = ts > 0 ? new Date(ts * 1000 + 8 * 3600_000).toISOString().slice(0, 10) : '近期'
        const longTitle = String(lastEp?.long_title || '').trim()
        const official = `〔官方〕第${epNum}集「${longTitle}」（${dt} 更新）`
        newNotes.push(official)
        // 拉这一集的评论热评（aid）
        const aid = lastEp?.aid
        if (aid) {
          try {
            const replyRaw = await fetch(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=1&ps=5`, { headers, signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => null)
            const replies = (replyRaw?.data?.replies || []).slice(0, 3)
            for (const rp of replies) {
              const msg = String(rp?.content?.message || '').replace(/\n/g, ' ').slice(0, 60)
              const likes = rp?.like || 0
              if (msg && likes >= 10) newNotes.push(`〔观众·${likes}赞〕${msg}`)
            }
          } catch { /* 评论拉不到不影响 */ }
        }
      }
      return { newNotes, ...(epNum > 0 ? { episode: epNum } : {}) }
    } catch (error) { return { newNotes: [], ...(error?.message ? { error: String(error.message).slice(0, 80) } : {}) } }
  },

  // 人物核心档案提取：侧路小模型 + 保守口径提示词（跨群身份级事实：称呼/长期爱好/雷点）
  personProfileExtract: async (messages) => {
    const cfg = readPluginSettings().memoryAiConfig || {}
    if (!cfg.memoryAiUrl || !cfg.memoryAiApikey || !cfg.memoryAiModel) throw new Error('memoryAiConfig 未配置')
    const { buildPersonProfileExtractPrompt } = await import('../dist/backend/modules/simulation/domain/personProfile.js')
    const { system, user } = buildPersonProfileExtractPrompt(messages)
    const result = await sideLLMCall({ url: cfg.memoryAiUrl, apikey: cfg.memoryAiApikey, model: cfg.memoryAiModel, temperature: 0.1, maxTokens: 2000, timeoutMs: 60000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    if (!result.ok) throw new Error(result.error)
    return result.content
  },

  // QQ空间互动：QQApi 走 NapCat get_credentials 拿 qzone 域凭据（与发说说同链路）。
  // visit 返回紧凑说说列表（tid/时间/文本/赞数），like/comment 直通。
  qzoneInteract: async ({ action, userId, tid, text }) => {
    try {
      const { QQApi } = await import('./QQApi.js')
      const api = new QQApi({})
      if (action === 'visit') {
        const raw = await api.getQzoneFeed(String(userId || ''), 10, 0)
        const msglist = (raw && typeof raw === 'object' ? raw.msglist : null) || []
        const feeds = (Array.isArray(msglist) ? msglist : []).slice(0, 8).map(item => {
          const row = item && typeof item === 'object' ? item : {}
          const tid = String(row.tid || '')
          const ts = Number(row.created_time || 0)
          const time = ts > 0 ? new Date(ts * 1000 + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 16) : '未知时间'
          const content = row.content || (Array.isArray(row.pic) ? '[图片说说]' : '')
          return { tid, time, text: String(content).slice(0, 200), likes: Number((row.fwd || {}).cntlike || 0) }
        }).filter(f => f.tid)
        return { ok: true, feeds }
      }
      if (action === 'like') {
        const raw = await api.likeQzoneFeed(String(userId || ''), String(tid || ''))
        const code = Number(raw && typeof raw === 'object' ? (raw.ret || raw.code) : -1)
        return Number(code) === 0 ? { ok: true } : { ok: false, error: `点赞返回 ${JSON.stringify(raw).slice(0, 120)}` }
      }
      if (action === 'comment') {
        const raw = await api.commentQzoneFeed(String(userId || ''), String(tid || ''), String(text || ''))
        const body = String(raw || '')
        // 该接口返回 fs 格式（回调包裹）——成功时含 "code":0 或 ret=0
        return /(?:\"code\":0|"code":0|ret=0|code=0)/.test(body) ? { ok: true } : { ok: false, error: `评论返回异常 ${body.slice(0, 120)}` }
      }
      return { ok: false, error: `未知 action ${action}` }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  },

  // 唤醒预判闸：便宜模型（缺省 memoryAi 的 flash 档）+ 紧凑上下文判断低信号唤醒值不值得进完整回合。
  // 返回 null = 预判不可用 → runtime fail-open 放行。
  wakeGateJudge: async ({ reason, messages }) => {
    try {
      const settings = readPluginSettings()
      const mem = settings.memoryAiConfig || {}
      const gate = (settings.simulation || {}).wakeGate || {}
      const model = String(gate.model || mem.memoryAiModel || '').trim()
      if (!mem.memoryAiUrl || !mem.memoryAiApikey || !model) return null
      const result = await sideLLMCall({
        url: mem.memoryAiUrl,
        apikey: mem.memoryAiApikey,
        model,
        temperature: 0.1,
        maxTokens: 64,
        timeoutMs: 8000,
        messages: [
          {
            role: 'system',
            content: [
              '你是群聊机器人的唤醒预判器。主模型进入完整回合开销大，你用极小上下文判断这次唤醒值不值得。',
              '判定值得（engage=true）：有人@机器人/引用它、明确向它提问、话题明显需要它参与（跑团剧情推进到它的角色、有人找它帮忙）。',
              '判定不值得（engage=false）：群友互相闲聊与机器人无关、只是蹭到关键词、旁观型随机唤醒。',
              '拿不准时一律 engage=true（宁放过不错杀）。只输出严格 JSON：{"engage": true 或 false, "reason": "不超过15字"}',
            ].join('\n'),
          },
          { role: 'user', content: JSON.stringify({ 唤醒原因: reason, 未读消息: messages }) },
        ],
      })
      if (!result.ok) return null
      const match = String(result.content || '').match(/\{[\s\S]*\}/)
      if (!match) return null
      const parsed = JSON.parse(match[0])
      return { engage: parsed.engage !== false, reason: String(parsed.reason || '').slice(0, 20) }
    } catch {
      return null
    }
  },
  // 群成员列表（TRSS pickGroup.getMemberMap）
  getGroupMembers: async (groupId, selfId) => {
    const group = scopedBot(selfId)?.pickGroup?.(Number(groupId))
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
  getForwardContent: async (forwardId, selfId) => {
    try {
      const Bot = scopedBot(selfId)
      const { renderForwardTree } = await import('../dist/backend/modules/simulation/domain/forwardView.js')
      // 递归展开整棵转发（≤3 层）：内嵌 id 自动跟随，适配器拉不到的层在结果里明确标注
      const rendered = await renderForwardTree(async id => {
        const raw = await (Bot?.getForwardMsg?.(id) ?? Bot?.pickFriend?.(0)?.getForwardMsg?.(id))
        const nodes = Array.isArray(raw) ? raw : Array.isArray(raw?.message) ? raw.message : []
        if (!nodes.length) throw new Error('转发内容为空或解析失败')
        return nodes
      }, String(forwardId || ''))
      return {
        lines: rendered.lines,
        total: rendered.total,
        ...(rendered.truncated ? { truncated: true } : {}),
        ...(rendered.nestedForwardIds.length ? { nestedForwardIds: rendered.nestedForwardIds } : {}),
        ...(rendered.imageUrls.length ? { imageUrls: rendered.imageUrls } : {}),
        ...(rendered.failedNested ? { failedNested: rendered.failedNested } : {}),
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
      maxTokens: 2000,
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
  '.仿真 模式 仅@ / 自主 / 活跃 —— 回复模式：仅@=只被@才回（仍看全部消息）；自主=观察全部消息自行决定何时插话；活跃=长期活跃档（持续有动静时按节奏兜底跟进+AI 同步自调触发器）',
  '.仿真 状态 —— 查看唤醒配置/水位/预算',
  '.仿真 记忆 —— 查看 AI 的长期记忆（待跟进/记事/印象）',
  '.仿真 重置 —— 清空本群仿真会话（历史/水位/预算；记忆与好感度保留）',
  '.好感度 —— 查看群友好感排行（自己的会标在末尾）',
].join('\n')

export function parseSimulationCommand(text) {
  const match = String(text || '').trim().match(/^\.仿真\s*(开|关|状态|重置|记忆|帮助|模式)?(?:\s+(\S+))?/)
  if (!match) return null
  return { action: match[1] || '帮助', arg: match[2] }
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
