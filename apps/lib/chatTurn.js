// 主聊天回合:触发上下文 → 提示词分层组装 → 历史选择 → 模型调用 → 回答分发。
// 从 apps/test.js 原样迁出(行为不变,P 重构),this 依赖以 host 注入;
// 这是全部链路中最大的单块,迁出后 test.js 只保留入口与委托。
import { extractChatKeywords, isImageGenerationRequest, shouldInjectGroupContext, shouldUseCompactHistory } from "../../core/intent/messageIntent.js"
import { globalStyleLearnerManager } from "../../domains/memory/GlobalStyleLearnerManager.js"
import { personProfileInjector } from "../../domains/memory/PersonProfileInjector.js"
import { personaFeedbackManager } from "../../domains/memory/PersonaFeedbackManager.js"
import { formatGroupKnowledgeTeachingPrompt } from "../../domains/memory/engine/groupKnowledge.js"
import { formatGroupWorkflowTeachingPrompt } from "../../domains/memory/engine/groupWorkflow.js"
import { getMidtermMemoryManager } from "../../domains/midtermMemory/MidtermSummaryManager.js"
import { getSemanticMemoryRuntime } from "../../domains/semanticMemory/runtime.js"
import { mcpManager } from "../../utils/MCPClient.js"
import { recordActionOutcomes } from "../../utils/actionOutcomes.js"
import { buildAddresseePrompt, computeAddresseeSignal } from "../../utils/addresseeSignals.js"
import { resolveHistorySelectionBudget, selectRelevantGroupHistory } from "../../utils/agentIntelligence.js"
import { isAiConversationEnabled } from "../../utils/aiConversationGate.js"
import { evaluatePrivateChatGate } from "./privateChat.js"
import { buildDrawFailureNoteMessage, recordDrawTextFallback, takeDrawFailureNote } from "../../utils/drawFailureNote.js"
import { prepareImageEditAssets, resolveAvatarEditBase } from "../../utils/editReferencePipeline.js"
import { classifyEmojiToolExposure } from "../../utils/emojiToolPolicy.js"
import { buildEpisodicPrompt, buildUserCallbackPrompt, hasTemporalDeixis, recallEpisodes, recallUserEpisodes } from "../../utils/episodicMemory.js"
import { buildExcelToolParams, hasExcelWorkbookContext, shouldUseExcelWorkbookTool } from "../../utils/excelRequestPolicy.js"
import { TakeImages } from "../../utils/fileUtils.js"
import { formatGroupContextImagePrompt, resolveGroupContextAssets } from "../../utils/groupContextResolver.js"
import { getGroupSocialPrompt, getGroupTopicPrompt } from "../../utils/groupContextState.js"
import { buildImageFailureReply } from "../../utils/imageFailurePolicy.js"
import { buildMissingImageAnalysisReply, shouldAskForMissingImageForVisualRequest } from "../../utils/imageRequestGuard.js"
import { shouldRequireImageEditBase } from "../../utils/imageTaskPolicy.js"
import { shouldSkipIntentModel } from "../../utils/intentFastPath.js"
import { containsInternalStatusLeak } from "../../utils/internalStatusLeak.js"
import { noteInjectedChunks } from "../../utils/memorySelfCorrection.js"
import { resolveSingularOwnerMention } from "../../utils/mentionRoleRouting.js"
import { collectMentionTargetIds } from "../../utils/mentionTargets.js"
import { ROLE_MAP as roleMap, extractMemberLookupTerms, formatMemberLookupPrompt, hasBotTextAnchor, joinIntentParts, matchGroupMembersByTerms, messageQuotesUser, uniqText } from "../../utils/messageContext.js"
import { createOutboundArbiter } from "../../utils/messagePipeline/outboundArbiter.js"
import { buildChatRequestData } from "../../utils/modelGateway.js"
import { rollPersonaMood } from "../../utils/personaMoods.js"
import { buildPersonaStyleOverride, renderPersonaTemplate, resolvePersonaName } from "../../utils/personaSource.js"
import { hasRecentPixivSearch } from "../../utils/pixivSearch.js"
import { resolvePromptLayerProfile } from "../../utils/promptLayers.js"
import { resolveRecentBotImage, resolveRecentUserImage } from "../../utils/recentImageContinuation.js"
import { resolveToolRoute } from "../../utils/routeDecision.js"
import { buildMainSystemPrompt } from "../../utils/systemPromptTemplate.js"
import { buildToolIntentDisclosure, resolveDeterministicToolIntent, selectToolIntentCandidates, extractEmbeddedToolCalls } from "../../utils/toolIntentManifests.js"
import { summarizeForLog, formatMemberDisplayName } from "../../utils/messageContext.js"
import { buildCommittedActionReply } from "../../utils/actionOutcomes.js"
import { buildTurnContinuityPrompt, loadTurnContinuity } from "../../utils/turnContinuity.js"
import { recordTurnDiagnostics } from "../../utils/turnDiagnostics.js"
import { createTurnPlan, deriveTurnPlanRequest, formatTurnPlanLog } from "../../utils/turnPlan.js"
import { isEducationalExplanationRequest, resolveCardPresentation } from "../../utils/turnPresentation.js"
import { composeTurnPromptLayers } from "../../utils/turnPromptComposer.js"
import { createTurnTrace, resolveTurnTraceArchiveDir } from "../../utils/turnTrace.js"
import { resolveAvatarDrawReference, resolveAvatarInspectionTargets } from "./avatarReference.js"
import { buildImageEditPrompt, buildImageGenerationPrompt, resolveContextualDrawGeneration } from "./promptContext.js"
import { buildToolCallFromDecision, classifySemanticToolIntent } from "./semanticToolIntent.js"
import { formatIdentityBindingsPrompt } from "./teachingFacts.js"
import { cardAcknowledgement } from "./textPolicy.js"
import { randomUUID } from "crypto"
import { delay, getOrCreateGroupLimiter, filterToolsForMessageIntent } from "./conversationUtils.js"

const logger = globalThis.logger

export async function handleToolInner(host, e) {
    if (!isAiConversationEnabled(host.config)) return false
    // 私聊:经私聊门禁(开关/白名单=留空仅主人/节流)后与群聊共用主回合
    const isPrivateChat = e.message_type === "private" && !e.group_id
    if (!host.config.enabled) return false
    if (!e.group_id && !isPrivateChat) {
      await host.sendObservedReply(e, "该命令只能在群聊中使用。")
      return false
    }
    if (isPrivateChat) {
      const gate = evaluatePrivateChatGate({ config: host.config, e, isMaster: e?.isMaster })
      if (!gate.allowed) {
        if (gate.reason === "disabled") await host.sendObservedReply(e, "私聊功能未开启。")
        return false
      }
    }

    if (host.isUserBlacklisted(e)) {
      logger.info(`[用户黑名单] tool group=${e.group_id} user=${e.user_id} msg="${summarizeForLog(e.msg || "")}"`)
      return false
    }

    const scheduledToolRequest = host.scheduleMergedToolRequest(e, async mergedEvent => {
      await host.handleTool(mergedEvent)
    })
    if (scheduledToolRequest === false) return false

    if (host.localToolsReadyPromise) await host.localToolsReadyPromise
    await host.refreshLocalToolRegistry({ silent: true })
    await host.waitForMCPReady()

    const taskContext = await host.beginConversationTask(e)
    const handleToolStartAt = Date.now()

    const { group_id: groupId, user_id: userId, msg } = e
    const sessionId = randomUUID()
    e.sessionId = sessionId
    const session = host.getOrCreateSession(sessionId, isPrivateChat ? [] : host.tools)
    session.taskContext = taskContext
    // 一个回合一条 trace + 一个出站仲裁：回合内所有出站消息过同一个有序队列
    const turnTrace = createTurnTrace({ groupId, userId, sessionId, logger, archive: { enabled: host.config?.turnTrace?.archiveEnabled !== false, dir: String(host.config?.turnTrace?.archiveDir || "") || resolveTurnTraceArchiveDir(), retentionDays: Number(host.config?.turnTrace?.retentionDays) || 7 } })
    e._turnId = turnTrace.id
    if (e?._triggerContext) turnTrace.setTrigger(e._triggerContext.mode, e._triggerContext)
    const outboundArbiter = createOutboundArbiter({ logger, trace: turnTrace })
    // 工具路由结果在 try 内赋值;提升到函数作用域供 finally 的回合诊断留存读取
    let route = null
    session.outboundArbiter = outboundArbiter
    session.turnTrace = turnTrace
    e = outboundArbiter.wrapEvent(e)
    // Tool stages share one optional progress message for the whole turn.
    e._progressReplyState = { sent: false, reserved: false }
    const groupLimiter = getOrCreateGroupLimiter(host._groupLimiters, groupId, host.config.concurrentLimit || 5)
    // 回合瀑布观测:关键阶段耗时一览,随[对话耗时]输出,定位串行浪费
    e._receivedAt ||= Date.now()
    const waterfall = {}
    const wfMark = {}
    const runStage = async (name, fn) => {
      const startedAt = Date.now()
      try {
        return await fn()
      } finally {
        waterfall[name] = Date.now() - startedAt
      }
    }

    let groupUserMessages = session.groupUserMessages

    return await groupLimiter(async () => {
      waterfall.queue = Date.now() - e._receivedAt
      try {
        const args = msg?.replace(/^#tool\s*/, "").trim() || ""
        const atQq = collectMentionTargetIds(e, Bot.uin)
        // 群名缓存(观测页读取):消息事件自带群名,顺手落盘
        try {
          const gName = String(e?.group?.group_name || e?.group_name || e?.sender?.group_name || "").trim()
          if (gName && groupId) {
            globalThis.__bl_group_names ||= {}
            if (globalThis.__bl_group_names[String(groupId)] !== gName) {
              globalThis.__bl_group_names[String(groupId)] = gName
              const fs = await import("node:fs")
              const pathMod = await import("node:path")
              const cachePath = pathMod.join(process.cwd(), "data", "group_names.json")
              fs.writeFileSync(cachePath, JSON.stringify(globalThis.__bl_group_names, null, 2))
            }
          }
        } catch {}
        let repliedMessage = null
        if (e.getReply) {
          try {
            repliedMessage = await e.getReply()
          } catch (error) {
            logger.warn(`[引用解析] getReply 异常 group=${groupId}: ${error?.message || error}`)
          }
          // NapCat 的 get_msg 存在间歇性失败(同一 reply_id 一成一败实测过);
          // 静默吞掉会让"引用图当画风参考"整轮退化成纯文生图,补一次重试
          if (!repliedMessage && e?.reply_id) {
            await new Promise(resolve => setTimeout(resolve, 600))
            try {
              repliedMessage = await e.getReply()
            } catch {}
            if (repliedMessage) {
              logger.info(`[引用解析] 重试成功 group=${groupId} reply_id=${e.reply_id}`)
            } else {
              logger.warn(`[引用解析] 重试仍失败 group=${groupId} reply_id=${e.reply_id}，本轮无引用上下文`)
            }
          }
        }
        const groupContextAssets = await resolveGroupContextAssets({
          e,
          group: e.group,
          reply: repliedMessage,
          maxImages: 12
        })
        session.groupContextAssets = groupContextAssets
        session.groupContextImagePrompt = formatGroupContextImagePrompt(groupContextAssets.images)
        e._groupContextAssets = groupContextAssets
        e._groupContextImagePrompt = session.groupContextImagePrompt

        const legacyImages = await TakeImages(e)
        const contextImages = groupContextAssets.images.map(asset => asset.source)
        let images = groupContextAssets.currentImages.length
          ? uniqText([...contextImages, ...legacyImages])
          : groupContextAssets.quotedImages.length
            ? uniqText([...legacyImages, ...contextImages])
            : contextImages.length
              ? uniqText(contextImages)
              : legacyImages
        if (groupContextAssets.forwardImages.length) {
          logger.info(`[群内素材] group=${groupId} 读取合并转发图片 ${groupContextAssets.forwardImages.length} 张`)
        }
        if (groupContextAssets.quotedImages.length > 1) {
          logger.info(`[群内素材] group=${groupId} 读取引用消息图片 ${groupContextAssets.quotedImages.length} 张`)
        }
        const recentUserImage = !images.length && shouldRequireImageEditBase(args || msg || "")
          ? await resolveRecentUserImage(e, { userId: e?.user_id }).catch(() => null)
          : null
        if (recentUserImage?.image) {
          images = [recentUserImage.image]
          session.recentUserImage = recentUserImage
          logger.info(`[图片来源] group=${groupId} user=${userId} 使用同一用户近期上传图片作为编辑原图`)
        }
        const recentImageContinuation = !images.length
          ? await resolveRecentBotImage(e, { text: args || msg || "", botId: Bot.uin }).catch(() => null)
          : null
        if (recentImageContinuation?.image) {
          images = [recentImageContinuation.image]
          session.recentImageContinuation = recentImageContinuation
          logger.info(`[图片续改] group=${groupId} 使用机器人最近成图作为编辑输入`)
        }
        session.images = images
        session.rawArgs = args

        if (await host.handleActiveDrawStatusQuestion(e, args || msg || "")) {
          host.clearSession(sessionId)
          return true
        }

        let videos = groupContextAssets.videos || []

        let memberMap = null
        try {
          memberMap = e.group ? await e.group.getMemberMap() : null
        } catch {}
        // 成员上下文供下游复用:语义分类器的头像参考候选、工具执行层的 references 校验
        session.memberMap = memberMap
        session.atQq = atQq
        const avatarEditBase = !images.length
          ? resolveAvatarEditBase({
              text: args || msg || "",
              atQq,
              memberMap,
              currentUserId: e?.user_id,
              botId: Bot.uin,
              replyTargetUserId: groupContextAssets.replyTargetUserId,
              replyTargetLabel: groupContextAssets.replyTargetLabel
            })
          : null
        if (avatarEditBase?.images?.length) {
          session.avatarEditBase = avatarEditBase
          images = avatarEditBase.images
          session.images = images
          logger.info(`[图片编辑] group=${groupId} 使用群友头像作为编辑底图 targets=${avatarEditBase.targets.map(item => item.userId).join(",")} imageCount=${images.length}`)
        }
        const avatarInspection = resolveAvatarInspectionTargets({
          e,
          text: args || msg || "",
          atQq,
          memberMap,
          reply: repliedMessage,
          botName: Bot.nickname,
          prefixes: host.config.triggerPrefixes
        })
        if (avatarInspection?.images?.length) {
          session.avatarInspection = avatarInspection
        }

        const editAssets = images.length && !session.avatarEditBase
          ? prepareImageEditAssets({
              baseImages: images,
              text: args || msg || "",
              atQq,
              memberMap,
              currentUserId: e?.user_id,
              botId: Bot.uin,
              replyTargetUserId: groupContextAssets.replyTargetUserId,
              replyTargetLabel: groupContextAssets.replyTargetLabel
            })
          : null
        if (editAssets?.references?.length) {
          session.editAssets = editAssets
          images = editAssets.images
          session.images = images
          logger.info(`[图片编辑] group=${groupId} 已构建编辑素材清单 references=${editAssets.references.map(item => item.id).join(",")} imageCount=${images.length}`)
        }

        const avatarDrawReference = !images.length
          ? resolveAvatarDrawReference({
              e,
              text: args || msg || "",
              atQq,
              memberMap,
              reply: repliedMessage,
              botName: Bot.nickname,
              prefixes: host.config.triggerPrefixes
            })
          : null
        if (avatarDrawReference?.images?.length) {
          session.avatarDrawReference = avatarDrawReference
        }

        if (!images.length && !avatarInspection?.images?.length && shouldAskForMissingImageForVisualRequest(args || msg || "")) {
          await host.sendSegmentedMessage(e, buildMissingImageAnalysisReply(), 0)
          host.clearSession(sessionId)
          return true
        }

        if (!images.length && shouldRequireImageEditBase(args || msg || "")) {
          await host.sendSegmentedMessage(e, "我知道你想改图，但这条消息附近没有找到可以编辑的原图。你回复那张图，或者把图和要求一起发给我。", 0)
          host.clearSession(sessionId)
          return true
        }

        const memberInfo = await (async () => {
          try {
            return await e.bot.pickGroup(groupId).pickMember(e.sender.user_id).info
          } catch { return {} }
        })()
        const senderRole = roleMap[e.sender?.role] || roleMap[memberInfo?.role] || "member"

        // ── 意图判定前置（P4 主判定 + 闲聊快路）：必须在分层画像与 prompt 拼接之前 ──
        const currentIntentText = joinIntentParts(args, msg)
        session.turnDrawRequested = isImageGenerationRequest(currentIntentText)
        const intentToolCandidates = selectToolIntentCandidates(currentIntentText, (session.tools || []).map(tool => tool?.function?.name).filter(Boolean))
        const skipIntentModel = shouldSkipIntentModel({
          text: currentIntentText,
          hasImages: Boolean(images?.length),
          hasVideos: Boolean(videos?.length),
          toolCandidates: intentToolCandidates
        })
        let modelIntentDecision = null
        const availableToolNamesNow = (host.toolInstances ? Object.keys(host.toolInstances) : [])
        const deterministicIntentReady = Boolean(resolveDeterministicToolIntent(currentIntentText, availableToolNamesNow, {
          // 意图快路先于 userContent 构建,这里用意图文本就地探测;
          // 不能引用后面 const hasExcelContext(路由段),否则 TDZ 必崩
          hasExcelContext: hasExcelWorkbookContext({
            text: currentIntentText,
            media: groupContextAssets?.media
          }),
          hasPixivSearchSession: hasRecentPixivSearch({ group_id: groupId, user_id: userId })
        }))
        if (deterministicIntentReady) {
          turnTrace.setIntent("tool", null, "deterministic_skip")
          logger.info(`[意图快路] group=${groupId} 确定性候选已命中，跳过意图模型`)
          skipIntentModel = true
        }
        // 上下文构建(连续性redis+消息体)不依赖意图模型结果:并行发起,
        // 意图模型慢时(最长6s超时)这段时间不再是纯串行等待
        const contextBuildPromise = (async () => {
          const lastTurnContinuity = await loadTurnContinuity({ redis: globalThis.redis, groupId, userId }).catch(() => null)
          const builtUserContent = await host.buildMessageContent(e.sender, args, images, atQq, e.group, e)
          return { lastTurnContinuity, builtUserContent }
        })()
        const intentPromise = skipIntentModel
          ? null
          : runStage("intent", () => host.resolvePrimaryModelIntent(currentIntentText, { hasImages: Boolean(images?.length) }))
        if (skipIntentModel) {
          turnTrace.setIntent("chat", null, "fast_path_skip")
          logger.info(`[意图快路] group=${groupId} 无工具信号的短闲聊，跳过意图模型`)
        } else {
          const intentStartedAt = Date.now()
          modelIntentDecision = await intentPromise
          turnTrace.addModelCall("intent", Date.now() - intentStartedAt)
          if (modelIntentDecision) turnTrace.setIntent(modelIntentDecision.intent, modelIntentDecision.confidence, "model")
        }
        session.modelIntentDecision = modelIntentDecision

        // 对象指认：与 TimingGate 共享同一套「这句话在回谁」信号，主链路据此决定接话姿态
        const smartStateForSignal = host.getSmartState(groupId)
        const mainQuotesBot = messageQuotesUser(e, Bot.uin)
        session.addresseeSignal = computeAddresseeSignal({
          e,
          botId: Bot.uin,
          mentionsBotName: hasBotTextAnchor(String(e?.msg || ""), Bot.nickname || "机器人", host.config.triggerPrefixes),
          quotesBot: mainQuotesBot,
          sameUserAsLastReply: Boolean(smartStateForSignal?.lastBotReplyToUserId && String(userId) === String(smartStateForSignal.lastBotReplyToUserId)),
          prefilterKind: e?._prefilterKind || "regular"
        })
        const addresseePrompt = buildAddresseePrompt(session.addresseeSignal)

        // 分层画像：闲聊只喂保底层，任务/知识/带素材回合注入全部层（依据前置的意图判定）
        session.promptLayerProfile = resolvePromptLayerProfile({
          responseKind: isEducationalExplanationRequest(currentIntentText) ? "knowledge" : "chat",
          modelIntent: modelIntentDecision?.intent || "",
          requiredToolNames: intentToolCandidates,
          hasImages: Boolean(images?.length),
          hasVideos: Boolean(videos?.length)
        })

        // 上一轮任务摘要：同一用户 10 分钟内的工具/回复延续，防止反复认图、反复确认
        const { lastTurnContinuity, builtUserContent } = await runStage("context", () => contextBuildPromise)
        const turnContinuityPrompt = buildTurnContinuityPrompt(lastTurnContinuity)
        if (lastTurnContinuity) logger.info(`[任务延续] group=${groupId} user=${userId} 注入上一轮摘要 intent=${lastTurnContinuity.intent} tools=${(lastTurnContinuity.tools || []).length}`)

        const userContent = builtUserContent
        const knowledgeContext = {
          text: e.msg || args,
          messageSegments: e.message || [],
          memberMap,
          fileAssets: groupContextAssets.files || [],
          creatorQQ: userId,
          creatorDisplay: memberMap?.get?.(Number(userId))?.card || memberMap?.get?.(Number(userId))?.nickname || e.sender?.card || e.sender?.nickname || '',
          botId: Bot.uin,
          sourceMessageId: e.message_id,
          isGroupManager: Boolean(e.isMaster || ['owner', 'admin'].includes(e.sender?.role) || ['owner', 'admin'].includes(memberInfo?.role))
        }
        const groupMemoryCommitPromise = groupId && host.config.memorySystem?.enabled
          ? host.memoryManager.interpretGroupKnowledgeInstruction(knowledgeContext)
            .then(decision => {
              if (decision?.status !== 'accepted') return decision
              return host.memoryManager.commitGroupMemoryDecision(groupId, decision, {
                ...knowledgeContext,
                requesterQQ: userId,
                isGroupManager: knowledgeContext.isGroupManager
              })
            })
            .catch(error => {
              logger.warn(`[群知识] 语义提交失败 group=${groupId}: ${error.message}`)
              return { status: 'unavailable', knowledgeEntries: [], workflowRules: [], aliasMappings: [] }
            })
          : Promise.resolve({ status: 'ignored', knowledgeEntries: [], workflowRules: [], aliasMappings: [] })
        // Shared-memory adjudication is deliberately off the critical reply path. A
        // very short window preserves natural confirmation for fast decisions; after
        // that the main reply continues and must not claim the write succeeded.
        const inlineWaitMs = Math.max(0, Math.min(1000, Number(host.config.memorySystem?.knowledgeDecisionInlineWaitMs) || 180))
        const inlineGroupMemoryCommit = await Promise.race([
          groupMemoryCommitPromise,
          delay(inlineWaitMs).then(() => null)
        ])
        groupMemoryCommitPromise.then(result => {
          if (result?.status !== 'accepted') return
          const savedKnowledge = result.knowledgeEntries || []
          const savedWorkflows = result.workflowRules || []
          if (savedKnowledge.length) logger.info(`[群知识] group=${groupId} committed=${savedKnowledge.length}`)
          if (savedWorkflows.length) logger.info(`[群工作流] group=${groupId} committed=${savedWorkflows.length}`)
        }).catch(() => {})
        const savedKnowledgeEntries = inlineGroupMemoryCommit?.status === 'accepted'
          ? (inlineGroupMemoryCommit.knowledgeEntries || []) : []
        const savedWorkflowRules = inlineGroupMemoryCommit?.status === 'accepted'
          ? (inlineGroupMemoryCommit.workflowRules || []) : []
        if (savedKnowledgeEntries.length) recordActionOutcomes(session, "group_knowledge", savedKnowledgeEntries)
        if (savedWorkflowRules.length) recordActionOutcomes(session, "group_workflow", savedWorkflowRules)
        const workflowTeachingPrompt = formatGroupWorkflowTeachingPrompt(savedWorkflowRules)
        const knowledgeTeachingPrompt = formatGroupKnowledgeTeachingPrompt(savedKnowledgeEntries)
        const selfBotId = String(Bot?.uin || e?.self_id || "")
        const personaName = (typeof host.getPersonaFor === "function" ? host.getPersonaFor(e)?.name : "") || host.config?.persona?.name || ""
        const memberLookupPrompt = formatMemberLookupPrompt(
          matchGroupMembersByTerms(memberMap, extractMemberLookupTerms(e.msg || args), userId, { selfBotId }),
          {
            identityNote: `列表里都是其他群友,不是你。你自己是本群机器人(QQ号 ${selfBotId})${personaName ? `,名字只有一个:「${personaName}」` : ""};被问"XX是谁"时,若XX在列表里,XX是别人。你的群名片就算被跑团等工具改成过角色名,也不代表换了身份。`
          }
        )
        const identityBindingsPrompt = formatIdentityBindingsPrompt(host.config.identityBindings, userId)

        if (groupId && host.config.memorySystem?.enabled && host.config.identityBindings?.length) {
          host._seededGroups ??= new Set()
          if (!host._seededGroups.has(groupId)) {
            host._seededGroups.add(groupId)
            host.memoryManager.seedFromConfig(groupId, host.config.identityBindings)
              .catch(err => logger.error('[MemoryManager] config seed 失败:', err))
          }
        }

        const getHighLevelMembers = async group => {
          if (!group) return ""
          const members = memberMap || await group.getMemberMap()
          return Array.from(members.values())
            .filter(m => ["admin", "owner"].includes(m.role))
            .map(m => `${formatMemberDisplayName(m)}(QQ号: ${m.user_id})[群身份: ${roleMap[m.role]}]`)
            .join("\n")
        }

        const mcpPrompts = mcpManager.getMCPSystemPrompts({
          messageType: e.message_type,
          groupId: e.group_id,
          message: e.msg
        })
        // 提示词分层组装：19 层取数/裁剪/拼装统一交给 turnPromptComposer
        //（层并发读取、单层失败降级为空、产出每层字符数 report）。
        // 依赖回合早期状态的层（身份绑定/教学/成员查询/合并触发）经 precomputed 传入。
        // 构建增强系统提示。群公告/管理员信息体量很大，只在问群规则/成员时注入。
        const includeGroupContext = shouldInjectGroupContext(e.msg || args) || Boolean(memberLookupPrompt)
        const groupContext = includeGroupContext
          ? await host.getCurrentGroupContext(e)
          : host.getBasicGroupContext(e)
        const cardRequestText = [args, msg, userContent].filter(Boolean).join("\n")
        // 调皮情绪时刻:同人格内偶发情绪着色,命中只影响本回合(掷骰+群级冷却)
        const moodHit = rollPersonaMood(host.getPersonaFor(e), isPrivateChat ? `private:${userId}` : groupId)
        if (moodHit) logger.info(`[心情时刻] group=${groupId} 命中「${moodHit.name}」(本回合生效)`)
        const promptLayers = await composeTurnPromptLayers({
          config: host.getChatConfig(e),
          profile: session.promptLayerProfile,
          turn: {
            groupId,
            userId,
            event: e,
            moodHint: moodHit,
            messageText: e.msg || args,
            memoryText: e.msg || "",
            rawMessageText: e.msg || "",
            toneText: [args, msg, userContent, e?._quotedPromptContext?.text].filter(Boolean).join("\n"),
            cardText: cardRequestText,
            cardResponseKind: isEducationalExplanationRequest(cardRequestText) ? "knowledge" : "chat"
          },
          precomputed: {
            identityBindings: identityBindingsPrompt,
            workflowTeaching: workflowTeachingPrompt,
            knowledgeTeaching: knowledgeTeachingPrompt,
            memberLookup: memberLookupPrompt,
            mergedTrigger: host.buildMergedDirectTriggerPrompt(e)
          },
          deps: {
            emotionManager: host.emotionManager,
            memoryManager: host.memoryManager,
            expressionLearner: host.expressionLearner,
            knowledgeSearcher: host.knowledgeSearcher,
            personaFeedbackManager,
            globalStyleLearnerManager,
            personProfileInjector,
            midtermSummaryManager: getMidtermMemoryManager()
          }
        })
        // 语义工具规划器复用群工作流层文本
        const workflowPrompt = promptLayers.layerValues.workflow || ''
        session.promptLayerReport = promptLayers.report
        const groupTopicPrompt = getGroupTopicPrompt(groupId)
        const groupSocialPrompt = getGroupSocialPrompt(groupId)
        // 时间指代（上次/昨天/那天…）触发情节回放，接住跨天指代
        // 语义记忆:此处尽早发起检索,与历史拉取/理解增强并行,历史选择后再收割
        const semanticMemoryRuntime = getSemanticMemoryRuntime()
        const semanticMemoryQueryText = [currentIntentText, args, msg].filter(Boolean).join(" ").trim()
        const semanticMemoryPromise = semanticMemoryRuntime &&
          e.message_type === "group" &&
          semanticMemoryRuntime.indexer.groupAllowed(groupId) &&
          semanticMemoryQueryText
          ? semanticMemoryRuntime.retriever.search(groupId, semanticMemoryQueryText, {
              rerank: Boolean(semanticMemoryRuntime.config.rerankInChat)
            }).catch(() => null)
          : null
        const episodicPrompt = host.config?.episodicMemory?.enabled !== false && hasTemporalDeixis(currentIntentText)
          ? buildEpisodicPrompt(recallEpisodes({
              groupId,
              terms: extractChatKeywords(currentIntentText, 6),
              days: Number(host.config?.episodicMemory?.recallDays) || 7,
              limit: 5
            }))
          : ""
        if (episodicPrompt) logger.info(`[情节回忆] group=${groupId} 命中时间指代，注入近期情节`)
        // 记忆回勾：闲聊档注入这位群友自己的旧情节（跨天），让她能自然想起旧账
        const callbackPrompt = host.config?.episodicMemory?.enabled !== false &&
          host.config?.episodicMemory?.proactiveEnabled !== false &&
          session.promptLayerProfile?.profile === "chat" && e?.user_id
          ? buildUserCallbackPrompt(recallUserEpisodes({
              groupId,
              userId: e.user_id,
              days: Number(host.config?.episodicMemory?.recallDays) || 7,
              limit: 2,
              minAgeMs: 30 * 60 * 1000
            }), { userName: e?.sender?.card || e?.sender?.nickname || "" })
          : ""
        if (callbackPrompt) logger.info(`[记忆回勾] group=${groupId} user=${e?.user_id} 注入旧话题 ${callbackPrompt.length}c`)
        const enhancedPrompts = [promptLayers.prompt, addresseePrompt, turnContinuityPrompt, groupTopicPrompt, groupSocialPrompt, episodicPrompt, callbackPrompt].filter(Boolean).join('\n')
        const runtimeGroupInfo = {
          group_id: groupContext.groupId,
          group_name: groupContext.groupName
        }
        if (includeGroupContext) {
          runtimeGroupInfo.group_notice = groupContext.groupNotice
          runtimeGroupInfo.administrators = await getHighLevelMembers(e.group)
        }
        const runtimeData = {
          group_info: runtimeGroupInfo,
          environmental_factors: { local_time: "北京时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) }
        }

        // 本回合生效人设:群绑定切换后,主提示词/风格覆盖/名字全部随之变化
        const chatPersona = host.getPersonaFor(e)
        const systemContent = buildMainSystemPrompt({
          baseIdentity: renderPersonaTemplate(host.config.systemContent, chatPersona),
          personaOverride: buildPersonaStyleOverride(chatPersona),
          runtimeData,
          enhancedPrompts,
          mcpPrompts,
          personaName: resolvePersonaName(chatPersona)
        })
        // 获取历史记录
        if (host.config.groupHistory) {
          const chatHistory = await host.messageManager.getMessages(e.message_type, e.message_type === "group" ? e.group_id : e.user_id)

          if (chatHistory?.length) {
            const historyMemberMap = isPrivateChat ? null : (memberMap || await e.bot.pickGroup(groupId).getMemberMap())

            // 使用 message_id 过滤当前消息
            const currentMessageId = e.message_id

            groupUserMessages = await Promise.all(chatHistory
              .reverse()
              .filter(msg => {
                // 直接用 message_id 判断，过滤掉当前消息
                if (msg.message_id === currentMessageId) {
                  logger.debug(`[历史去重] 过滤当前消息: message_id=${msg.message_id}`)
                  return false
                }
                if (msg.source === "tool" || String(msg.content || "").includes("此处为调用工具的结果")) {
                  logger.debug(`[历史过滤] 跳过工具结果记录: message_id=${msg.message_id || ""}`)
                  return false
                }
                if (String(msg.sender?.user_id) === String(Bot.uin) && containsInternalStatusLeak(msg.content)) {
                  logger.debug(`[历史过滤] 跳过内部状态泄漏回复: message_id=${msg.message_id || ""}`)
                  return false
                }
                return true
              })
              .map(msg => ({
                role: msg.sender.user_id === Bot.uin ? "assistant" : "user",
                messageId: msg.message_id,
                userId: msg.sender.user_id,
                content: `[${msg.time}] ${formatMemberDisplayName(historyMemberMap.get(Number(msg.sender.user_id)), msg.sender.nickname)}(QQ号:${msg.sender.user_id})[群身份: ${roleMap[msg.sender.role] || "member"}]${msg.message_id ? `[消息ID:${msg.message_id}]` : ''}: ${msg.content}`
              }))
            )
            groupUserMessages = await Promise.all(groupUserMessages.map(async msg => {
              const taskStatus = msg.messageId ? await host.getTaskStatus(groupId, msg.messageId) : null
              const statusText = host.formatTaskStatusForPrompt(taskStatus)
              return statusText ? { ...msg, content: `${msg.content}\n${statusText}` } : msg
            }))
            const intelligence = host.config.agentIntelligence || {}
            const historyBudget = resolveHistorySelectionBudget(intelligence, {
              compact: shouldUseCompactHistory({
                text: joinIntentParts(args, msg),
                images,
                videos,
                quotedText: e?._quotedPromptContext?.text || repliedMessage?.message || ""
              })
            })
            const originalHistoryCount = groupUserMessages.length
            if (intelligence.enabled !== false) {
              groupUserMessages = selectRelevantGroupHistory(groupUserMessages, {
                query: [args, msg, userContent, e?._quotedPromptContext?.text].filter(Boolean).join("\n"),
                replyMessageId: e?._quotedPromptContext?.messageId,
                currentUserId: userId,
                botId: Bot.uin,
                recentCount: historyBudget.recentCount,
                relevantCount: historyBudget.relevantCount,
                maxMessages: historyBudget.maxMessages
              })
            }
            session.historySelectionMode = historyBudget.mode
            session.selectedGroupHistoryCount = groupUserMessages.length
            if (groupUserMessages.length < originalHistoryCount) {
              logger.info(`[上下文选择] group=${groupId} mode=${historyBudget.mode} selected=${groupUserMessages.length}/${originalHistoryCount} recent=${groupUserMessages.filter(item => item.contextSection === "recent").length} relevant=${groupUserMessages.filter(item => item.contextSection === "relevant").length}`)
            }
          }
        }

        // 语义记忆收割:检索已在情节回忆阶段并行发起,超时/未命中都不阻塞回复
        if (semanticMemoryPromise) {
          const memoryResult = await semanticMemoryPromise
          if (memoryResult?.items?.length) {
            const memoryContext = semanticMemoryRuntime.retriever.renderContext(memoryResult)
            if (memoryContext) {
              groupUserMessages = groupUserMessages || []
              groupUserMessages.unshift({
                role: "user",
                userId: "memory",
                content: `【系统提示:群聊长期记忆】以下是早前群聊中与当前话题相关的片段(时间早于近期上下文,供回忆参考,不要主动提及"检索"二字):\n${memoryContext}`
              })
              const maxScore = Math.max(...memoryResult.items.map(item => item.vectorScore)).toFixed(3)
              logger.info(`[语义记忆] group=${groupId} 注入 ${memoryResult.items.length} 段 max余弦=${maxScore} 耗时=${memoryResult.elapsedMs}ms(向量${memoryResult.vectorMs ?? "-"}ms/BM25${memoryResult.bm25Ms ?? "-"}ms)`)
              // 记忆自纠错:记录本轮"引用了哪些记忆说话",群友说"你记错了"时降权这些分块
              noteInjectedChunks(groupId, memoryResult.items)
            }
          } else {
            logger.info(`[语义记忆] group=${groupId} 无命中(${memoryResult?.reason || "低于阈值"}) ${memoryResult?.elapsedMs ?? 0}ms`)
          }
        }

        const understandingPrompt = session.promptLayerProfile?.profile === "chat"
          ? ""
          : await runStage("brief", () => host.resolveUnderstandingPrompt({
          e,
          args,
          msg,
          userContent,
          images,
          videos,
          session,
          currentIntentText: joinIntentParts(args, msg),
          groupUserMessages
        }))

        groupUserMessages = groupUserMessages.filter(m => m.role !== "system")
        groupUserMessages.unshift({ role: "system", content: systemContent })
        if (understandingPrompt) {
          groupUserMessages.splice(1, 0, { role: "system", content: understandingPrompt })
        const drawFailureNoteMessage = buildDrawFailureNoteMessage(takeDrawFailureNote(e.group_id))
        if (drawFailureNoteMessage) {
          groupUserMessages.splice(2, 0, { role: "system", content: drawFailureNoteMessage })
          logger.info(`[画图失败标记] group=${e?.group_id || ""} 已注入上一轮画图失败提示`)
        }
        }
        groupUserMessages.push({ role: "user", content: userContent })
        session.userContent = userContent
        groupUserMessages = host.trimMessageHistory(groupUserMessages)
        groupUserMessages = host.filterChatByQQ(groupUserMessages, e.user_id)
        session.groupUserMessages = host.formatMessages(groupUserMessages, e, userContent)

        // ── 工具路由:16 条规则由 routeDecision 规则表顺序裁决 ──
        // (原 16 个顺序 if 块的逐字等价转写;复制粘贴产生的"识图强制路由"死代码块已删除;
        //  守卫次序、锁语义、session 写入次序均保留,第二刀的顺序调整另行讨论)
        const hasExcelContext = hasExcelWorkbookContext({
          text: userContent,
          media: groupContextAssets?.media
        })
        const hasPixivSearchSession = hasRecentPixivSearch({ group_id: groupId, user_id: userId })
        const excelToolIntent = shouldUseExcelWorkbookTool(currentIntentText, { hasExcelContext })
        const excelToolParams = buildExcelToolParams(currentIntentText, { hasExcelContext })
        const emojiCooldownMs = Number(host.config?.emojiSystem?.emojiCooldownMs ?? 120000)
        route = await resolveToolRoute({
          intentText: currentIntentText,
          rawMsg: msg,
          args,
          modelIntent: modelIntentDecision?.intent,
          images, videos, groupId, userId,
          botName: Bot?.nickname || "",
          config: host.getChatConfig(e),
          memberMap,
          hasExcelContext, excelToolIntent, excelToolParams, hasPixivSearchSession,
          groupWorkflowPrompt: workflowPrompt,
          emojiCooldownMs,
          session,
          promptContext: () => ({ e, args, msg, currentIntentText, userContent, groupUserMessages: session.groupUserMessages }),
          imageGenerationReferenceImages: () => host.getImageGenerationReferenceImages(images, session),
          applyTools: names => { session.tools = host.getToolsByName(names); return session.tools },
          log: text => logger.info(text),
          helpers: {
            resolveSingularOwnerMention,
            resolveForcedReplyTextRate: gid => host.resolveForcedReplyTextRate(gid),
            buildForcedToolCall: (name, params) => host.buildForcedToolCall(name, params),
            buildToolCallFromDecision: (decision, context) => host.buildToolCallFromDecision(decision, context),
            buildImageEditPrompt: context => host.buildImageEditPrompt(context),
            buildImageGenerationPrompt: context => host.buildImageGenerationPrompt(context),
            resolveContextualDrawGeneration: context => host.resolveContextualDrawGeneration(context),
            classifySemanticToolIntent: context => host.classifySemanticToolIntent(context),
            semanticSessionTools: () => images?.length
              ? session.tools
              : (session.tools || []).filter(tool => !["googleImageEditTool", "googleImageAnalysisTool"].includes(tool?.function?.name))
          }
        })
        if (route.warn) logger.warn(route.warn)
        if (route.aborted === "no-banana-channel") {
          await host.sendSegmentedMessage(e, buildImageFailureReply("图片生成失败: 当前没有可用的图片生成渠道"), 0)
          recordDrawTextFallback(groupId, currentIntentText)
          host.clearSession(sessionId)
          return true
        }
        let toolChoice = route.toolChoice
        let forcedToolCall = route.forcedToolCall
        let toolScopeLocked = route.toolScopeLocked

        // 强制抢红包模式
        if (e.forceGrabRedBag) {
          session.tools = host.getToolsByName(["grabRedBagTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "grabRedBagTool" } }
        }

        if (!toolScopeLocked && toolChoice === "auto") {
          const beforeToolCount = session.tools?.length || 0
          session.tools = filterToolsForMessageIntent(session.tools, e, args, { allowSearch: modelIntentDecision?.intent === "search", emojiCooldownMs: Number(host.config?.emojiSystem?.emojiCooldownMs ?? 120000) })
          if (!session.tools.length) {
            toolChoice = "none"
          } else if (session.tools.length === 1 && session.tools[0]?.function?.name === "sendLocalEmojiTool") {
            logger.info(`[工具选择] group=${groupId} 轻松闲聊仅启用 sendLocalEmojiTool`)
          } else if (session.tools.length !== beforeToolCount) {
            logger.info(`[工具选择] group=${groupId} 按需启用 ${session.tools.length}/${beforeToolCount} 个工具`)
          }
        }

        const availableToolNames = (session.tools || []).map(tool => tool?.function?.name).filter(Boolean)
        const requestedActionCapabilities = selectToolIntentCandidates(currentIntentText, availableToolNames)
        const turnPlan = createTurnPlan({
          responseKind: isEducationalExplanationRequest(currentIntentText) ? "knowledge" : "chat",
          intentText: currentIntentText,
          availableCapabilities: availableToolNames,
          requiredCapabilities: requestedActionCapabilities,
          toolChoice,
          toolScopeLocked,
          forcedToolCall,
          explicitEmojiRequest: classifyEmojiToolExposure(currentIntentText) === "explicit",
          historyMode: session.historySelectionMode,
          selectedHistoryCount: session.selectedGroupHistoryCount
        })
        session.turnPlan = turnPlan
        session.cardPresentation = resolveCardPresentation(currentIntentText, turnPlan.presentation.kind)
        session.initialExecutionRoute = {
          mode: turnPlan.execution.mode,
          reason: turnPlan.observability.routeReason
        }
        const turnPlanRequest = deriveTurnPlanRequest(turnPlan, host.config)
        if (turnPlan.execution.mode === "tool") {
          const initialToolNames = turnPlan.capabilities.required.length
            ? turnPlan.capabilities.required
            : turnPlan.capabilities.optional
          session.tools = host.getToolsByName(initialToolNames)
          logger.info(`[执行计划] group=${groupId} ${formatTurnPlanLog(turnPlan)} tools=${initialToolNames.join(",")}`)
        } else if (session.tools?.length) {
          logger.info(`[执行计划] group=${groupId} ${formatTurnPlanLog(turnPlan)} optional=${turnPlan.capabilities.optional.join(",")}`)
          session.tools = []
        }
        toolChoice = turnPlanRequest.toolChoice

        const botMemberMap = await e.bot.pickGroup(groupId).getMemberMap()
        const botRole = roleMap[botMemberMap.get(Bot.uin)?.role] || "member"
        session.toolContent = await host.buildMessageContent({ nickname: Bot.nickname, user_id: Bot.uin, role: botRole }, "", [], [], e.group)

        if (forcedToolCall) {
          await host.processToolCalls({ role: "assistant", tool_calls: [forcedToolCall] }, e, session, session.groupUserMessages, atQq, senderRole, { syntheticToolCall: true })
          host.clearSession(sessionId)
          return true
        }

        const acknowledgement = cardAcknowledgement(session.cardPresentation)
        if (acknowledgement) {
          outboundArbiter.beginToolOutcomes()
          outboundArbiter.enqueue("commitment", () => host.sendSegmentedMessage(e, acknowledgement, 0))
          session.cardAcknowledged = true
          logger.info(`[卡面呈现] 承诺类确认已入队（工具结果决出后放行） kind=${session.cardPresentation}`)
        }

	        // 语义规划器没强制调用时,主模型是唯一决策者——但它平时看不到任何工具
	        // 抽取规则,不同群的上下文会让它摇摆(反问澄清/换错工具)。把候选工具的
	        // 披露说明注入本轮请求,让主模型和规划器看到同一套规则。
	        const toolNamesForRequest = (session.tools || []).map(tool => tool?.function?.name).filter(Boolean)
	        const disclosureForMainModel = buildToolIntentDisclosure(toolNamesForRequest)
	        const requestMessages = disclosureForMainModel
	          ? [...session.groupUserMessages, { role: "system", content: disclosureForMainModel }]
	          : session.groupUserMessages
	        const requestData = buildChatRequestData(host.config, requestMessages, session.tools, toolChoice)
            const initialModelStartedAt = Date.now()
	        let response = await host.retryRequest(requestData, session.toolContent, 1, undefined, turnPlanRequest.requestOptions)
	        session?.turnTrace?.addModelCall("main", Date.now() - initialModelStartedAt)
	        logger.info(`[模型耗时] group=${groupId} stage=initial ${formatTurnPlanLog(session.turnPlan)} toolChoice=${typeof toolChoice === "string" ? toolChoice : toolChoice?.function?.name || "auto"} history=${session.selectedGroupHistoryCount || 0} mode=${session.historySelectionMode || "full"} elapsed=${Date.now() - initialModelStartedAt}ms`)

	        if (!response?.choices?.[0]) {
		          if (response?.error) {
			            const errorText = typeof response.error === "string"
			              ? response.error
			              : response.error?.message || JSON.stringify(response.error)
			            logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_api toolChoice=${typeof toolChoice === "string" ? toolChoice : toolChoice?.function?.name || "auto"} merged=${e?._mergedMessageCount || 0} error=${errorText}`)
			            const failedToolName = session.toolName || session.tools?.[0]?.function?.name || ""
			            await host.sendSegmentedMessage(e, host.getFriendlyFailureMessage(failedToolName, {
			              e,
			              session,
			              stage: "initial_api",
			              error: errorText,
			              toolChoice
			            }), 0)
			          }
		          else {
		            logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_api_empty toolChoice=${typeof toolChoice === "string" ? toolChoice : toolChoice?.function?.name || "auto"} merged=${e?._mergedMessageCount || 0} reason=no_choices`)
		            await host.sendSegmentedMessage(e, host.getFriendlyFailureMessage("", {
		              e,
		              session,
		              stage: "initial_api_empty",
		              error: "回答服务没有返回有效内容",
		              toolChoice
		            }), 0)
		          }
	          host.clearSession(sessionId)
	          return true
	        }

        const message = response.choices[0].message || {}
        // 分发模型回答(tool_calls / 文本);空消息时若走了紧凑快后端,先换主模型重试一次
        // ——思考型模型的 thinking 计入 max_tokens,快后端小额度可能被思考耗光导致正文为空
        const dispatchAssistantMessage = async target => {
          if (target.tool_calls?.length) {
            await host.processToolCalls(target, e, session, session.groupUserMessages, atQq, senderRole)
          } else if (target.content) {
            // 降级链路兜底:聊天模型把工具调用写成 ```json 文本块时,转成真正的
            // 工具调用执行(否则这段中间产物会被渲染成卡面,用户只看到黑块)
            const embedded = extractEmbeddedToolCalls(target.content)
            if (embedded.calls.length) {
              const availableTools = new Set((session.tools || []).map(tool => tool?.function?.name).filter(Boolean))
              const runnable = embedded.calls.find(call => availableTools.has(call.name))
              if (runnable) {
                logger.warn(`[降级兜底] 模型以文本形式输出工具调用，转正执行 tool=${runnable.name}`)
                await host.processToolCalls({ role: "assistant", tool_calls: [host.buildForcedToolCall(runnable.name, runnable.params)] }, e, session, session.groupUserMessages, atQq, senderRole, { syntheticToolCall: true })
                return true
              }
              if (!embedded.remainder.trim()) {
                logger.warn(`[降级兜底] 回复只含不可执行的工具调用文本，跳过发送 names=${embedded.calls.map(call => call.name).join(",")}`)
                return true
              }
              target = { ...target, content: embedded.remainder }
            }
            const missingToolCall = host.buildMissingToolCommitmentCall(target.content, {
              e,
              args,
              msg,
              images,
              currentIntentText,
              userContent,
              groupUserMessages: session.groupUserMessages
            })
            if (missingToolCall) {
              session.tools = missingToolCall.tools
              logger.warn(`[工具漏调守卫] 模型承诺执行但未调用工具，强制使用 ${missingToolCall.toolName} reason=${missingToolCall.reason}`)
              await host.processToolCalls({ role: "assistant", tool_calls: [missingToolCall.toolCall] }, e, session, session.groupUserMessages, atQq, senderRole, { syntheticToolCall: true })
            } else {
              await host.handleTextResponse(target.content, e, session, session.groupUserMessages)
            }
            return true
          }
          return false
        }

        if (message.tool_calls?.length || message.content) {
          await dispatchAssistantMessage(message)
        } else if (turnPlanRequest.requestOptions?.taskBackend) {
          logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_message_empty backend=${turnPlanRequest.requestOptions.taskBackend} reason=no_content_or_tool_calls 换主模型重试`)
          const retryStartedAt = Date.now()
          const retryResponse = await host.retryRequest(requestData, session.toolContent, 1, undefined, {
            forceChatBackend: true,
            routeLabel: "空消息重试主模型"
          })
          session?.turnTrace?.addModelCall("main_retry", Date.now() - retryStartedAt)
          const retryMessage = retryResponse?.choices?.[0]?.message || {}
          if (retryMessage.tool_calls?.length || retryMessage.content) {
            await dispatchAssistantMessage(retryMessage)
          } else {
            logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_message_empty_retry reason=no_content_or_tool_calls`)
            await host.sendSegmentedMessage(e, host.getFriendlyFailureMessage("", {
              e,
              session,
              stage: "initial_message_empty",
              error: "回答服务返回了空消息",
              toolChoice
            }), 0)
          }
        } else {
          logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_message_empty reason=no_content_or_tool_calls`)
          await host.sendSegmentedMessage(e, host.getFriendlyFailureMessage("", {
            e,
            session,
            stage: "initial_message_empty",
            error: "回答服务返回了空消息",
            toolChoice
          }), 0)
        }

        host.clearSession(sessionId)
        return true

      } catch (error) {
        console.error(`[工具插件] 会话 ${sessionId} 执行异常：`, error)
        const committedReply = buildCommittedActionReply(session)
        if (committedReply && !session.responseAttempted) {
          await host.sendSegmentedMessage(e, committedReply, 0).catch(() => {})
        }
        host.clearSession(sessionId)
        return true
	      } finally {
	        outboundArbiter.settle(session.turnPlan?.outcomes || [])
	        const traceRecord = turnTrace.finish()
	        await host.finishConversationTask(taskContext, session)
	        const totalElapsed = Date.now() - handleToolStartAt
	        logger.info(`[对话耗时] group=${e?.group_id || ""} user=${e?.user_id || ""} ${formatTurnPlanLog(session.turnPlan)} total=${totalElapsed}ms merged=${e?._mergedMessageCount || 0} 瀑布=${Object.entries(waterfall).filter(([key]) => key !== "queued").map(([key, ms]) => `${key}=${ms}ms`).join(" ")}${waterfall.queued > 500 ? ` 队列等待=${waterfall.queued}ms` : ""}`, { turnId: e?._turnId })
	        if (e.group_id && !e._longRunningToolTask) host.recordReplyLatency(e.group_id, totalElapsed)
	        // 回合诊断留存:供 #希洛调试 命令回显(纯观测,不影响主链路)
	        recordTurnDiagnostics({
	          groupId: e?.group_id,
	          userId: e?.user_id,
	          turnId: e?._turnId,
	          promptLayerReport: session.promptLayerReport,
	          routeApplied: route?.applied || [],
	          routeToolChoice: route?.toolChoice,
	          turnPlan: formatTurnPlanLog(session.turnPlan),
	          modelCalls: traceRecord?.modelCalls || [],
	          tools: traceRecord?.tools || []
	        })
	      }
    })
  }
