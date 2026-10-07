// strict 会话编排:直发触发入口、会话追踪、批量"是否在对 bot 说话"判断、复读参与。
// 从 apps/test.js 原样迁出(行为不变),this 依赖以 host 注入;会话追踪/批量判断状态随迁。
import { extractChatKeywords } from "../../core/intent/messageIntent.js"
import { diceManager } from "../../domains/dice/DiceManager.js"
import { globalStyleLearnerManager } from "../../domains/memory/GlobalStyleLearnerManager.js"
import { isAiConversationEnabled } from "../../utils/aiConversationGate.js"
import { anchorEventConversation } from "../../utils/forbiddenWordGuard.js"
import { ROLE_MAP as roleMap, summarizeForLog } from "../../utils/messageContext.js"
import { getRedBagType, isExclusiveForUser } from "../../utils/redBagUtils.js"
import { toolConfigHasName } from "./conversationUtils.js"

const logger = globalThis.logger

const RED_BAG_CONFIG = {
  enabled: true, // 是否启用自动抢红包
  minProbability: 0.3, // 最小触发概率
  maxProbability: 0.8, // 最大触发概率
  cooldownTime: 60000 // 冷却时间（毫秒），同一个群60秒内不重复触发
}
const redBagCooldowns = new Map() // 红包冷却记录: key: groupId, value: lastGrabTime

const activeConversations = new Map() // 会话追踪: key: `${groupId}_${userId}`, value: { lastActiveTime, chatHistory: [], timer: null }
const trackingThrottle = new Map() // 节流: key: `${groupId}_${userId}`, value: lastCallTime
let batchTimer = null // 批量处理定时器
const pendingJudgments = [] // 批量判断队列

export function setTrackingWithTimer(host, conversationKey, newData = {}) {
    const timeout = (host.config.conversationTrackingTimeout || 2) * 60000
    const activeConv = activeConversations.get(conversationKey)

    // 清除旧定时器
    if (activeConv?.timer) {
      clearTimeout(activeConv.timer)
    }

    // 创建新定时器
    const timer = setTimeout(() => {
      const conv = activeConversations.get(conversationKey)
      // 确保清除的是同一个定时器（防止竞态）
      if (conv?.timer === timer) {
        activeConversations.delete(conversationKey)
        trackingThrottle.delete(conversationKey)
        logger.info(`[会话追踪] ${conversationKey} 超时，已清除`)
      }
    }, timeout)

    // 原子操作：创建定时器后立即存储
    activeConversations.set(conversationKey, {
      lastActiveTime: Date.now(),
      chatHistory: activeConv?.chatHistory || [],
      ...newData,
      timer
    })
}

export async function joinRepeat(host, e, state, text) {
    if (!isAiConversationEnabled(host.config)) return false
    const smartCfg = host.config.smartTrigger || {}
    const groupId = e.group_id
    // 复用速率检查（避免和正常回复一起把 bot 刷成复读机）
    const cutoff = Date.now() - 600000
    state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > cutoff)
    const maxPer10Min = Number(smartCfg.maxRepliesPer10Min) || 8
    if (state.recentReplyTimestamps.length >= maxPer10Min) {
      logger.info(`[Repeat] group=${groupId} rate limit 已满 (${state.recentReplyTimestamps.length}/${maxPer10Min}) 放弃复读`)
      return false
    }
    logger.info(`[Repeat] group=${groupId} 参与复读 text="${text.slice(0, 30)}"`)
    // 先发再写 state：避免 e.reply 抛错时 cooldown / rate limit / lastBotReplyAt 等被脏写
    try {
      await host.sendObservedReply(e, text, false, "repeat")
    } catch (err) {
      logger.error('[Repeat] 发送失败:', err)
      return false
    }
    // 发送成功才提交状态变更
    state.recentReplyTimestamps.push(Date.now())
    state.lastRepeatJoinAt = Date.now()
    state.lastBotReplyAt = Date.now()
    state.lastBotReplyKeywords = extractChatKeywords(text, Number(smartCfg.continuationKeywordMaxCount) || 5)
    state.pendingCount = 0
    // 清瞬态标志：复读路径跳过了 continue/wait/no_action 分支，需要显式清掉以免污染下一条消息
    state.forceContinue = false
    state.forceGateCheck = false
    state.lastGateNoActionAt = 0
    return true
}

export function detectGroupRepeat(host, e, state) {
    const smartCfg = host.config.smartTrigger || {}
    if (smartCfg.repeatJoinEnabled === false) return null

    const text = String(e?.msg || '').trim()
    if (!text) return null
    const maxLen = Number(smartCfg.repeatMaxTextLength) || 30
    if (text.length > maxLen) return null

    const botId = e?.bot?.uin || (typeof Bot !== 'undefined' && Bot.uin)
    const currentUserId = String(e?.user_id || '')
    const window = Math.max(2, Number(smartCfg.repeatDetectionWindow) || 5)
    const recent = (state.recentMessages || []).slice(-window)
    // 统计窗口内（不含当前消息）发过相同文本的不同用户数
    const distinctUsers = new Set()
    for (const m of recent) {
      if (m.text === text && String(m.userId) !== currentUserId) {
        distinctUsers.add(String(m.userId))
      }
    }
    // 当前用户也算一个独立"复读源"
    if (currentUserId) distinctUsers.add(currentUserId)
    // 排除 bot 自己（理论上不该在 recentMessages 里）
    if (botId) distinctUsers.delete(String(botId))

    const minCount = Math.max(2, Number(smartCfg.repeatMinCount) || 3)
    if (distinctUsers.size < minCount) return null

    // 已确认是复读潮（≥minCount 个不同用户在重复），下面任何失败都打日志方便排查
    const groupId = e?.group_id
    const textPreview = text.length > 20 ? text.slice(0, 20) + '...' : text

    // 冷却：避免同一波内反复跟
    const cooldownMs = Number(smartCfg.repeatJoinCooldownMs) || 180000
    const sinceLast = Date.now() - (state.lastRepeatJoinAt || 0)
    if (sinceLast < cooldownMs) {
      const remainSec = Math.ceil((cooldownMs - sinceLast) / 1000)
      logger.info(`[Repeat] group=${groupId} 检测到复读 text="${textPreview}" users=${distinctUsers.size} 但冷却中(剩余${remainSec}s)`)
      return null
    }

    // 通过概率筛选
    const prob = Number(smartCfg.repeatJoinProbability)
    const finalProb = Number.isFinite(prob) ? Math.max(0, Math.min(1, prob)) : 0.6
    if (Math.random() > finalProb) {
      logger.info(`[Repeat] group=${groupId} 检测到复读 text="${textPreview}" users=${distinctUsers.size} 但概率未命中(prob=${finalProb})`)
      return null
    }

    logger.info(`[Repeat] group=${groupId} 检测到复读 text="${textPreview}" users=${distinctUsers.size} 准备参与`)
    return text
}

export async function isUserTalkingToBot(host, userMessage, chatHistory = []) {
    try {
      const botName = Bot.nickname || '机器人'

      // 构建对话历史文本
      const historyText = chatHistory.length > 0
        ? chatHistory.map(h => `[${h.role === 'bot' ? '机器人' : '用户'}] ${h.content}`).join('\n')
        : '(无历史记录)'

      const response = await fetch(host.resolveChatCompletionUrl(host.config.trackAiConfig.trackAiUrl), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${host.config.trackAiConfig.trackAiApikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: host.config.trackAiConfig.trackAiModel,
          messages: [
            {
              role: "system",
              content: `你是QQ群聊对话判断助手。机器人名字叫"${botName}"，QQ号${Bot.uin}。

根据对话历史，判断用户新消息是否在继续跟机器人对话。

【判断为 true】
- 内容是对机器人上一条回复的回应或追问
- 话题自然延续（机器人说"中午好"→用户问"吃什么"）
- 针对机器人之前说的内容提问

【判断为 false】
- @了其他群成员
- 明确叫其他人名字
- 话题与之前对话完全无关
- 明显是群里的日常闲聊/水群

你只回复 true 或 false，不要输出其他内容。
`
            },
            {
              role: "user",
              content: `【近期对话记录】\n${historyText}\n\n【用户新消息】\n${userMessage}\n\n这条新消息是在跟机器人说话吗？`
            }
          ]
        })
      })

      if (!response.ok) return false // 请求失败时默认不触发

      const data = await response.json()
      const answer = data?.choices?.[0]?.message?.content?.toLowerCase()?.trim()
      // logger.error(answer, historyText, userMessage, 8888)
      return answer === 'true' || answer?.includes('true')
    } catch (error) {
      logger.error('[会话追踪] AI判断失败:', error)
      return false // 出错时默认不触发
    }
}

export function addToBatchJudgment(host, conversationKey, userMessage, chatHistory, e) {
    return new Promise(resolve => {
      pendingJudgments.push({ conversationKey, userMessage, chatHistory, e, resolve })

      if (!batchTimer) {
        const batchDelay = (host.config.batchJudgmentDelay || 3) * 1000
        batchTimer = setTimeout(() => host.processBatchJudgments(), batchDelay)
      }
    })
}

export async function processBatchJudgments(host) {
    batchTimer = null
    if (pendingJudgments.length === 0) return

    const batch = pendingJudgments.splice(0)

    if (batch.length === 1) {
      const result = await host.isUserTalkingToBot(batch[0].userMessage, batch[0].chatHistory)
      batch[0].resolve(result)
      return
    }

    try {
      const results = await host.batchIsUserTalkingToBot(batch)
      batch.forEach((item, i) => item.resolve(results[i] || false))
    } catch (error) {
      logger.error('[批量判断] 失败:', error)
      batch.forEach(item => item.resolve(false))
    }
}

export async function batchIsUserTalkingToBot(host, batch) {
    try {
      const botName = Bot.nickname || '机器人'

      // 为每条消息生成唯一标识
      const batchWithIds = batch.map((item, i) => ({
        ...item,
        id: `MSG_${i + 1}_${item.e?.user_id || 'unknown'}`
      }))

      const messagesText = batchWithIds.map(item => {
        const recentHistory = (item.chatHistory || []).slice(-3).map(h => `[${h.role === 'bot' ? '机器人' : '用户'}] ${h.content}`).join('\n')
        const userName = item.e?.sender?.card || item.e?.sender?.nickname || '未知用户'
        return `【${item.id}】用户: ${userName}(QQ:${item.e?.user_id})
对话历史:
${recentHistory || '(无)'}
新消息: ${item.userMessage}
---`
      }).join('\n\n')

      const response = await fetch(host.resolveChatCompletionUrl(host.config.trackAiConfig.trackAiUrl), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${host.config.trackAiConfig.trackAiApikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: host.config.trackAiConfig.trackAiModel,
          messages: [
            {
              role: "system",
              content: `你是QQ群聊对话判断助手。机器人名字叫"${botName}"。

每条消息来自不同用户，有独立的对话历史，请分别独立判断。

【判断为 true】
- 内容是对机器人上一条回复的回应或追问
- 话题自然延续
- 针对机器人之前说的内容提问

【判断为 false】
- @了其他群成员
- 明确叫其他人名字
- 话题与之前对话完全无关
- 明显是群里的日常闲聊/水群
- 无对话历史且消息内容与机器人无关

返回JSON对象，key为消息ID，value为判断结果。
示例: {"MSG_1_12345": true, "MSG_2_67890": false}
只返回JSON对象，不要其他内容。`
            },
            {
              role: "user",
              content: `分别判断以下${batchWithIds.length}条来自不同用户的消息:\n\n${messagesText}\n\n返回JSON对象:`
            }
          ]
        })
      })

      if (!response.ok) {
        logger.error('[批量判断] API请求失败')
        return host.fallbackToSingleJudgment(batch)
      }

      const data = await response.json()
      let content = data?.choices?.[0]?.message?.content?.trim() || '{}'

      // 提取JSON对象
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        content = jsonMatch[0]
      }

      const resultsMap = JSON.parse(content)
      logger.info(`[批量判断] ${batch.length}条消息，结果: ${JSON.stringify(resultsMap)}`)

      // 按ID映射回结果数组
      const results = batchWithIds.map(item => {
        const result = resultsMap[item.id]
        if (result === undefined) {
          logger.warn(`[批量判断] 缺少ID ${item.id} 的结果，回退单独判断`)
          return null // 标记需要单独判断
        }
        return result === true || result === 'true'
      })

      // 检查是否有需要单独判断的
      const needsFallback = results.some(r => r === null)
      if (needsFallback) {
        return host.fallbackToSingleJudgment(batch, results)
      }

      return results
    } catch (error) {
      logger.error('[批量判断] 解析失败:', error)
      return host.fallbackToSingleJudgment(batch)
    }
}

export async function fallbackToSingleJudgment(host, batch, partialResults = null) {
    logger.info(`[批量判断] 回退到单独判断，共${batch.length}条`)
    const results = []
    for (let i = 0; i < batch.length; i++) {
      if (partialResults && partialResults[i] !== null) {
        results.push(partialResults[i])
      } else {
        const result = await host.isUserTalkingToBot(batch[i].userMessage, batch[i].chatHistory)
        results.push(result)
      }
    }
    return results
}

export async function handleRandomReply(host, e) {
    // 私聊分流:默认关闭,开启后白名单(留空=仅主人)用户可私聊,走同一主回合
    if (e.message_type === "private") return await host.handlePrivateChat(e)
    if (!host.config.enabled || !host.checkGroupPermission(e) || host.isCommand(e) || !e.group_id) {
      return false
    }

    if (host.isUserBlacklisted(e)) {
      logger.info(`[用户黑名单] group=${e.group_id} user=${e.user_id} msg="${summarizeForLog(e.msg || "")}"`)
      return false
    }

    // 违禁词黑名单:命中即中断本群当前对话(含进行中回合),本条不进入任何下游
    if (host.handleForbiddenWordHit(e)) return false
    host.handleMemorySelfCorrection(e)
    anchorEventConversation(e)

    if (diceManager.isLogActive(e.group_id, host.config.diceSystem)) {
      logger.info(`[骰娘log] group=${e.group_id} log开启中，跳过AI对话`)
      return false
    }

    const messageTypes = e.message?.map(m => m.type) || []
    if (host.config.excludeMessageTypes.some(t => messageTypes.includes(t))) return false

    if (host.config.globalStyleLearning?.enabled !== false) {
      try {
        globalStyleLearnerManager.observeMessage(e, host.config.globalStyleLearning, host.config.embeddingAiConfig)
        globalStyleLearnerManager.maybeAutoSummarize(
          host.config.globalStyleLearning,
          host.config.memoryAiConfig
        ).catch(error => {
          logger.warn(`[全局表达学习] 自动总结调度失败: ${error.message}`)
        })
      } catch (error) {
        logger.warn(`[全局表达学习] 记录失败: ${error.message}`)
      }
    }

    // 必须和全局风格观察一样放在本处理函数的第一个 await 之前。
    // 否则高并发群消息会因异步检查返回顺序不同而重排，把 A-B-A 误学成 A 的连续两句。
    if (host.config.expressionLearning?.enabled &&
      String(e.user_id || '') !== String(e.bot?.uin || Bot.uin || '') &&
      (e.msg || e.raw_message || Array.isArray(e.message))) {
      host.expressionLearner.updateGroupExpressions(e.group_id, e.msg || e.raw_message || '', {
        userId: e.user_id,
        messageId: e.message_id,
        at: Number(e.time) > 0 ? Number(e.time) * 1000 : Date.now(),
        message: e.message
      }).catch(() => {})
    }

    // 禁言检测：bot 在该群被禁言（个人/全员）时不触发任何回复，避免发送失败 + 表情/red 包等也无意义
    if (await host.isMutedInGroup(e)) return false

    // 磁链与视频卡片一样是独立媒体交付事件：不必点名，也不能交给闲聊 TimingGate 决定。
    if (host.isAutomaticTorrentDownloadEvent(e)) {
      logger.info(`[自动磁链下载] group=${e.group_id} user=${e.user_id} 已识别有效 BTIH 磁链`)
      e._triggerContext = { mode: "auto_media" }
      return await host.handleTool(e)
    }

    // 检测红包消息并随机触发抢红包（两种模式都生效）
    const walletSeg = e.message?.find(m => m.type == 'wallet')
    if (walletSeg && RED_BAG_CONFIG.enabled && toolConfigHasName(host.config.oneapi_tools, 'grabRedBagTool')) {
      const wallet = walletSeg.data || walletSeg
      const redBagType = getRedBagType(wallet)
      const botId = e.bot?.uin || Bot.uin

      // 专属红包：判断是否给机器人
      if (redBagType.type === 'exclusive') {
        if (!isExclusiveForUser(wallet, botId)) {
          logger.info(`[自动抢红包] 专属红包不是给机器人的，跳过`)
          return false
        }
        // 专属红包给机器人，直接触发
        logger.info(`[自动抢红包] 检测到给机器人的专属红包，直接触发抢红包`)
        e.forceGrabRedBag = true
        e._triggerContext = { mode: "red_bag" }
        return await host.handleTool(e)
      }

      const now = Date.now()
      const lastGrabTime = redBagCooldowns.get(e.group_id) || 0

      // 检查冷却时间
      if (now - lastGrabTime >= RED_BAG_CONFIG.cooldownTime) {
        // 随机概率
        const probability = RED_BAG_CONFIG.minProbability +
          Math.random() * (RED_BAG_CONFIG.maxProbability - RED_BAG_CONFIG.minProbability)

        if (Math.random() < probability) {
          redBagCooldowns.set(e.group_id, now)
          logger.info(`[自动抢红包] 检测到${redBagType.name}，触发概率 ${(probability * 100).toFixed(1)}%，执行抢红包`)
          e.forceGrabRedBag = true // 标记强制抢红包
          e._triggerContext = { mode: "red_bag" }
          return await host.handleTool(e)
        } else {
          logger.info(`[自动抢红包] 检测到${redBagType.name}，未命中概率 ${(probability * 100).toFixed(1)}%，跳过`)
        }
      }
    }

    // smart 模式分发
    const triggerMode = String(host.config.chatTriggerMode || 'strict').toLowerCase()
    if (triggerMode === 'smart') {
      return await host.handleRandomReplySmart(e)
    }

    const hasTrigger = await host.checkTriggers(e)

    // 会话追踪逻辑
    const conversationKey = `${e.group_id}_${e.user_id}`
    const activeConv = activeConversations.get(conversationKey)

    // 如果明确触发（@或前缀），直接触发并更新追踪
    if (hasTrigger) {
      e._triggerContext = { mode: "strict_trigger" }
      if (host.config.conversationTrackingEnabled) {
        host.setTrackingWithTimer(conversationKey)
      }
      const scheduled = host.scheduleMergedDirectTrigger(e, async mergedEvent => {
        await host.handleTool(mergedEvent)
      }, 'strict_trigger')
      if (scheduled === false) return false
      return await host.handleTool(e)
    }

    // 在追踪期内，判断是否在继续对话
    if (host.config.conversationTrackingEnabled && activeConv) {
      // 节流检查
      const throttleKey = conversationKey
      const lastCallTime = trackingThrottle.get(throttleKey) || 0
      const throttleInterval = (host.config.conversationTrackingThrottle || 3) * 1000

      if (Date.now() - lastCallTime < throttleInterval) {
        // 节流期内，直接返回不触发
        return false
      }

      // 更新节流时间
      trackingThrottle.set(throttleKey, Date.now())

      // 构建完整格式的用户消息
      const senderRole = roleMap[e.sender?.role] || "member"
      const senderName = e.sender?.card || e.sender?.nickname || "未知用户"
      const userMessageFormatted = `${host.formatTime()} ${senderName}(qq号: ${e.user_id})[群身份: ${senderRole}]: 在群里说: ${e.msg || ''}`

      // 使用批量判断队列
      const isTalking = await host.addToBatchJudgment(conversationKey, userMessageFormatted, activeConv.chatHistory || [], e)

      if (isTalking) {
        // 重置定时器
        host.setTrackingWithTimer(conversationKey)
        e._triggerContext = { mode: "conversation_tracking" }
        return await host.handleTool(e)
      }
      // 判断不是在跟机器人对话，直接返回不触发
      return false
    }

    // 未在追踪期内，不触发
    return false
}
