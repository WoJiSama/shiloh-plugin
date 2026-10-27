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

const logger = globalThis.logger
const config = (await import('../model/config.js')).default
const pluginRoot = path.resolve('./plugins/shiloh-plugin')

const expressionLearner = new ExpressionLearner()
let styleDigestCache = { key: '', at: 0, text: '' }

function readPluginSettings() {
  const raw = config.getConfig('message')
  return raw && typeof raw === 'object' ? raw.pluginSettings || {} : {}
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

export const simulationRuntime = createSimulationRuntime({
  logger,
  redis: globalThis.redis,
  getSection: () => readPluginSettings().simulation || {},
  getExecutionConfig: () => {
    try {
      return decodeHostConfig(readPluginSettings())
    } catch (error) {
      logger?.warn?.(`[仿真] 宿主配置解码失败，使用原始配置：${error?.message || error}`)
      return readPluginSettings()
    }
  },
  getSelf: (selfIdHint) => {
    const hint = String(selfIdHint ?? '')
    if (hint) {
      const entry = botById(hint)
      return { id: hint, name: String(entry?.nickname || currentBot().name || readPluginSettings().persona?.name || '') }
    }
    const bot = currentBot()
    return { id: bot.id, name: bot.name || String(readPluginSettings().persona?.name || '') }
  },
  YTapi: (requestData, execConfig) => YTapi(requestData, execConfig),
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
  // 合并转发内容（OneBot get_forward_msg → 逐条文本行）
  getForwardContent: async forwardId => {
    try {
      const Bot = globalThis.Bot
      const raw = await (Bot?.getForwardMsg?.(forwardId) ?? Bot?.pickFriend?.(0)?.getForwardMsg?.(forwardId))
      const nodes = Array.isArray(raw) ? raw : Array.isArray(raw?.message) ? raw.message : []
      const lines = []
      for (const node of nodes.slice(0, 40)) {
        const name = String(node?.sender?.card || node?.sender?.nickname || '群友')
        const segs = Array.isArray(node?.message) ? node.message : []
        const text = segs.filter(seg => seg?.type === 'text').map(seg => String(seg.data?.text || '')).join('').trim()
        if (text) lines.push(`${name}：${text.slice(0, 120)}`)
      }
      return lines.length ? { lines } : { lines: [], error: '转发内容为空或解析失败' }
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
  '.仿真 状态 —— 查看唤醒配置/水位/预算',
  '.仿真 记忆 —— 查看 AI 的长期记忆（待跟进/记事/印象）',
  '.仿真 重置 —— 清空本群仿真会话（历史/水位/预算；记忆与好感度保留）',
  '.好感度 —— 查看群友好感排行（自己的会标在末尾）',
].join('\n')

export function parseSimulationCommand(text) {
  const match = String(text || '').trim().match(/^\.仿真\s*(开|关|状态|重置|记忆|帮助)?/)
  if (!match) return null
  return { action: match[1] || '帮助' }
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
