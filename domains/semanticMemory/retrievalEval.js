// 检索质量评估:从索引抽样分块 → LLM 生成可回答该块的问题 → 检索 → 目标块是否进 top-k。
// 产出 recall@k(纯向量 vs 混合召回消融)与延迟分位数;命令 app 与独立脚本共用。
import { fetchWithTimeout } from "../../utils/modelGateway.js"

export async function runRetrievalEval(runtime, { sampleCount = 20, sampleMinChars = 40 } = {}) {
  const { store, retriever } = runtime
  // 全量载入各群索引(store.groups 为懒加载 LRU,新进程需先触发)
  store.stats()
  const samples = []
  for (const state of store.groups.values()) {
    for (const chunk of state.chunks.values()) {
      if (chunk.text && chunk.text.length >= sampleMinChars) samples.push({ groupId: state.groupId, chunk })
    }
  }
  if (!samples.length) return null
  const picked = []
  const step = Math.max(1, Math.floor(samples.length / sampleCount))
  for (let i = 0; i < samples.length && picked.length < sampleCount; i += step) picked.push(samples[i])

  const cases = []
  for (const sample of picked) {
    const question = await generateQuestion(runtime, sample.chunk)
    if (question) cases.push({ ...sample, question })
  }
  const report = {
    samples: cases.length,
    recallAt5Vector: 0, recallAt5Hybrid: 0, recallAt10Hybrid: 0,
    latencyP50Ms: 0, latencyP95Ms: 0,
    questionFailures: picked.length - cases.length
  }
  if (!cases.length) return report

  const hit = (result, target, k) => result.items.slice(0, k).some(item =>
    item.chunk.id === target.id || messageIdJaccard(item.chunk.message_ids, target.message_ids) >= 0.5)

  let vectorHits5 = 0
  let hybridHits5 = 0
  let hybridHits10 = 0
  const latencies = []
  for (const testCase of cases) {
    const startedAt = Date.now()
    const result = await retriever.search(testCase.groupId, testCase.question, {
      topK: 10,
      minScore: 0,
      timeoutMs: 5000
    })
    latencies.push(Date.now() - startedAt)
    // 纯向量消融:同一批候选内只按向量排名
    const vectorOnly = { items: [...result.items].sort((a, b) => (a.vectorRank || 999) - (b.vectorRank || 999)) }
    if (hit(vectorOnly, testCase.chunk, 5)) vectorHits5++
    if (hit(result, testCase.chunk, 5)) hybridHits5++
    if (hit(result, testCase.chunk, 10)) hybridHits10++
  }
  latencies.sort((a, b) => a - b)
  report.recallAt5Vector = vectorHits5 / cases.length
  report.recallAt5Hybrid = hybridHits5 / cases.length
  report.recallAt10Hybrid = hybridHits10 / cases.length
  report.latencyP50Ms = latencies[Math.floor(latencies.length * 0.5)] || 0
  report.latencyP95Ms = latencies[Math.floor(latencies.length * 0.95)] || 0
  return report
}

function messageIdJaccard(a = [], b = []) {
  if (!a.length || !b.length) return 0
  const setA = new Set(a.map(String))
  const setB = new Set(b.map(String))
  let shared = 0
  for (const id of setA) if (setB.has(id)) shared++
  return shared / (setA.size + setB.size - shared)
}

async function generateQuestion(runtime, chunk) {
  const model = runtime.questionModel
  if (!model?.url) return null
  try {
    const response = await fetchWithTimeout(model.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${model.key}` },
      body: JSON.stringify({
        model: model.model,
        messages: [
          { role: "system", content: "你是出题器。根据给出的群聊片段,生成一个只能通过该片段内容回答的中文问题。只输出问题本身,不要任何前缀、解释或引号。" },
          { role: "user", content: chunk.text.slice(0, 800) }
        ],
        temperature: 0.7,
        // 出题模型自带思考链,max_tokens 过小会被推理耗尽导致 content 为空
        max_tokens: 600
      })
    }, model.timeoutMs || 20000)
    if (!response?.ok) return null
    const payload = await response.json()
    const question = String(payload?.choices?.[0]?.message?.content || "").trim().replace(/^["'“”]+|["'“”]+$/g, "")
    return question.length >= 6 ? question : null
  } catch {
    return null
  }
}
