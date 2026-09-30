// 语义记忆管理命令:状态/查询调试/全量重建/在线评估(recall@k 消融)。
// 重建与评估会产生 embedding/LLM 调用,限主人或群主(与聊天记录查询权限口径一致)。
import { getSemanticMemoryRuntime } from '../domains/semanticMemory/runtime.js'
import { runRetrievalEval } from '../domains/semanticMemory/retrievalEval.js'
import { buildVisibleFailureDetail } from '../utils/visibleFailure.js'

function requireRuntime(e) {
  const runtime = getSemanticMemoryRuntime()
  if (!runtime) {
    e.reply('语义记忆未启用:需要 semanticMemory.enabled=true 且 embeddingAiConfig 已配置')
    return null
  }
  return runtime
}

function canManage(e) {
  return Boolean(e?.isMaster || e?.sender?.role === 'owner')
}

export class SemanticMemoryPlugin extends plugin {
  constructor() {
    super({
      name: '语义记忆',
      dsc: '群聊长期记忆(RAG)管理',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^[.。]语义记忆(\\s|$)', fnc: 'handleCommand' },
        { reg: '^[#]?语义记忆(\\s|$)', fnc: 'handleCommand' }
      ]
    })
  }

  async handleCommand(e) {
    const text = String(e.msg || '').trim()
    const action = text.split(/\s+/)[1] || '状态'
    if (!canManage(e)) {
      await e.reply('语义记忆管理命令仅主人或群主可用')
      return true
    }
    const runtime = requireRuntime(e)
    if (!runtime) return true

    try {
      if (/^(状态|status)$/i.test(action)) return await this.showStatus(e, runtime)
      if (/^(查询|search)$/i.test(action)) return await this.debugSearch(e, runtime, text)
      if (/^(重建|回填|rebuild)$/i.test(action)) return await this.rebuild(e, runtime, text)
      if (/^(评估|eval)$/i.test(action)) return await this.evaluate(e, runtime, text)
      await e.reply([
        '用法:',
        '  .语义记忆                状态',
        '  .语义记忆 查询 <问题>    调试检索(看分数)',
        '  .语义记忆 重建 [群=xxx]  全量回填索引',
        '  .语义记忆 评估 [N=20]    在线评估 recall@k'
      ].join('\n'))
      return true
    } catch (error) {
      logger.error(`[SemanticMemory] 命令失败: ${error.stack || error.message}`)
      await e.reply(`语义记忆命令失败：${buildVisibleFailureDetail(error)}`)
      return true
    }
  }

  async showStatus(e, runtime) {
    const stats = runtime.store.stats()
    const gateway = runtime.gateway
    const lines = [
      `语义记忆:${runtime.config.enabled ? '已启用' : '未启用'} | 模型 ${gateway.model} dim=${stats.dimension}`,
      `索引:${stats.groups} 个群 / ${stats.chunks} 个分块 | 保留 ${stats.retentionDays} 天`,
      `参数:窗口 ${runtime.config.windowSize}/步长 ${runtime.config.stride} | topK=${runtime.config.topK} 阈值=${runtime.config.minScore}`,
      `embedding:请求 ${gateway.stats.batchRequests} 次 / 缓存命中 ${gateway.stats.cacheHits} / 失败 ${gateway.stats.failures}`,
      `检索:查询 ${runtime.retriever.stats.queries} 次 / 命中 ${runtime.retriever.stats.hits} / 超时 ${runtime.retriever.stats.timeouts}`
    ]
    const busyGroups = runtime.indexer.dirtyGroups.size
    if (busyGroups) lines.push(`待增量索引:${busyGroups} 个群(防抖中)`)
    await e.reply(lines.join('\n'))
    return true
  }

  async debugSearch(e, runtime, text) {
    const match = text.match(/^(?:[.。#]?\s*语义记忆\s+查询)\s+([\s\S]+)$/)
    const query = match?.[1]?.trim()
    if (!query) {
      await e.reply('用法:.语义记忆 查询 <问题>')
      return true
    }
    const groupId = e.group_id ? String(e.group_id) : ''
    const result = await runtime.retriever.search(groupId, query, { timeoutMs: 5000 })
    if (!result.items.length) {
      await e.reply(`没有检索到相关记忆(${result.elapsedMs}ms ${result.reason || ''})`.trim())
      return true
    }
    const lines = [
      `检索耗时 ${result.elapsedMs}ms(向量 ${result.vectorMs ?? '-'}ms / BM25 ${result.bm25Ms ?? '-'}ms) 候选 ${result.candidates}`,
      ...result.items.map((item, index) =>
        `#${index + 1} 余弦${item.vectorScore.toFixed(3)} 向量#${item.vectorRank || '-'} BM25#${item.bm25Rank || '-'}\n${runtime.retriever.renderContext({ items: [item] })}`)
    ]
    await e.reply(lines.join('\n\n'))
    return true
  }

  async rebuild(e, runtime, text) {
    const groupMatch = text.match(/群[=:：]\s*(\d+)/)
    await e.reply(groupMatch ? `开始重建群 ${groupMatch[1]} 的语义索引…` : '开始全量重建语义索引(逐群进行,消息多的群需要几分钟)…')
    const report = groupMatch
      ? [await runtime.indexer.backfillGroup(groupMatch[1])]
      : await runtime.indexer.backfillAll()
    const ok = report.filter(item => !item.error)
    const failed = report.filter(item => item.error)
    const lines = [
      `重建完成:${ok.length} 个群,共索引 ${ok.reduce((sum, item) => sum + (item.indexed || 0), 0)} 个分块`,
      ...ok.slice(0, 8).map(item => `群 ${item.group}:消息 ${item.messages ?? '-'} → 分块 ${item.chunks ?? '-'}(新增 ${item.indexed})`)
    ]
    if (failed.length) lines.push(`失败 ${failed.length} 个:${failed.map(item => `${item.group}(${item.error})`).join('、')}`)
    await e.reply(lines.join('\n'))
    return true
  }

  async evaluate(e, runtime, text) {
    const countMatch = text.match(/N[=:：]?\s*(\d+)/)
    const sampleCount = Math.min(50, Math.max(3, Number(countMatch?.[1]) || 20))
    await e.reply(`开始在线评估:抽样 ${sampleCount} 个分块生成问答对,衡量 recall@k(纯向量 vs 混合召回)…`)
    const report = await runRetrievalEval(runtime, { sampleCount })
    if (!report) {
      await e.reply('评估失败:没有可用的索引分块,先执行 .语义记忆 重建')
      return true
    }
    const lines = [
      `评估样本:${report.samples} | recall@5 向量 ${pct(report.recallAt5Vector)} / 混合 ${pct(report.recallAt5Hybrid)} | recall@10 混合 ${pct(report.recallAt10Hybrid)}`,
      `检索延迟 P50 ${report.latencyP50Ms}ms / P95 ${report.latencyP95Ms}ms | 问题生成失败 ${report.questionFailures}`
    ]
    await e.reply(lines.join('\n'))
    logger.info(`[SemanticMemory] 评估报告 ${JSON.stringify(report)}`)
    return true
  }
}

function pct(value) {
  return `${Math.round(value * 100)}%`
}
