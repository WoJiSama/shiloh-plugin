import fs from "fs"
import path from "path"
import { getSemanticMemoryRuntime } from "../domains/semanticMemory/runtime.js"

// 语义记忆后台页:索引总览(量化数据)、检索游乐场、分块浏览器、评估历史。
// 挂在 /bl-chat/semantic-memory,与命令/观测页共用同一份令牌(只读页,主/观测令牌皆可)。

const MOUNT_PATH = "/bl-chat/semantic-memory"
let registered = false

function readEvalHistory(baseDir) {
  const file = path.join(String(baseDir || ""), "eval-history.ndjson")
  if (!baseDir || !fs.existsSync(file)) return []
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/)
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
      .slice(-30)
      .reverse()
  } catch {
    return []
  }
}

function pct(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(value * 100)}%` : "-"
}

function checkToken(req, token) {
  const provided = String(req?.query?.token || req?.headers?.["x-commands-token"] || "")
  return Boolean(provided) && (provided === token?.token || provided === token?.observeToken || provided === token)
}

function buildStats(runtime) {
  if (!runtime) return { enabled: false }
  const storeStats = runtime.store.stats()
  return {
    enabled: true,
    config: {
      retentionDays: runtime.config.retentionDays,
      windowSize: runtime.config.windowSize,
      stride: runtime.config.stride,
      topK: runtime.config.topK,
      minScore: runtime.config.minScore,
      rerankEnabled: runtime.config.rerankEnabled,
      rerankInChat: runtime.config.rerankInChat,
      rerankModel: runtime.config.rerankModel
    },
    store: {
      groups: storeStats.groups,
      chunks: storeStats.chunks,
      dimension: storeStats.dimension,
      diskMb: (() => {
        try {
          const dir = runtime.store.groupDir()
          return fs.existsSync(dir)
            ? Math.round(fs.readdirSync(dir).reduce((sum, name) => {
                try { return sum + fs.statSync(path.join(dir, name)).size } catch { return sum }
              }, 0) / 1024 / 1024 * 10) / 10
            : 0
        } catch { return 0 }
      })()
    },
    embedding: {
      model: runtime.gateway.model,
      ...runtime.gateway.stats,
      cacheSize: runtime.gateway.cache.size
    },
    reranker: runtime.reranker
      ? { model: runtime.reranker.model, ...runtime.reranker.stats, circuitBroken: Date.now() < runtime.reranker.failureUntil }
      : null,
    retriever: { ...runtime.retriever.stats },
    indexer: { ...runtime.indexer.stats, pendingGroups: runtime.indexer.dirtyGroups.size },
    evalLatest: readEvalHistory(runtime.baseDir)[0] || null
  }
}

function buildPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>语义记忆 · shiloh-plugin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f1117; color: #d7dce5; padding: 20px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #7a8394; font-size: 12px; margin-bottom: 18px; }
  h2 { font-size: 15px; margin: 22px 0 10px; color: #9fb3d1; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .card { background: #171b25; border: 1px solid #232a38; border-radius: 10px; padding: 12px 14px; }
  .card .num { font-size: 22px; font-weight: 600; color: #7ee2a8; }
  .card .label { font-size: 12px; color: #7a8394; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1d2430; }
  th { color: #8fa1bd; font-weight: 500; }
  .good { color: #7ee2a8; } .warn { color: #e8c46a; } .dim { color: #7a8394; }
  .row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  input, select, button { background: #171b25; color: #d7dce5; border: 1px solid #2a3345; border-radius: 8px; padding: 7px 10px; font-size: 13px; }
  input { flex: 1; min-width: 160px; } button { cursor: pointer; }
  button.primary { background: #1f3a5f; border-color: #2c5590; }
  pre { background: #12151d; border: 1px solid #1d2430; border-radius: 8px; padding: 10px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; }
  .item { background: #12151d; border: 1px solid #1d2430; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .scores { color: #8fa1bd; font-size: 12px; margin-bottom: 4px; }
  .text { font-size: 13px; line-height: 1.55; }
  .off { color: #e07a7a; }
</style>
</head>
<body>
<h1>语义记忆(RAG)</h1>
<div class="sub">分块 → 向量+BM25 混合召回 → RRF 融合 → 重排 · 只读页</div>
<div id="app">加载中…</div>
<script>
(function () {
  var TOKEN = window.__BL_AUTO_TOKEN__ || new URLSearchParams(location.search).get("token") || "";
  function api(name, params) {
    var url = "/bl-chat/semantic-memory/api/" + name + "?token=" + encodeURIComponent(TOKEN);
    if (params) url += "&" + new URLSearchParams(params).toString();
    return fetch(url).then(function (r) { return r.json(); });
  }
  function esc(s) { var d = document.createElement("div"); d.textContent = String(s == null ? "" : s); return d.innerHTML; }
  function refresh() {
    api("stats").then(function (s) {
      var el = document.getElementById("app");
      if (!s.enabled) { el.innerHTML = '<div class="item off">语义记忆未启用(semanticMemory.enabled=false 或 embedding 未配置)</div>'; return; }
      var ev = s.evalLatest || {};
      el.innerHTML =
        '<h2>索引总览</h2>' +
        '<div class="cards">' +
        card(s.store.chunks, "分块总数") + card(s.store.groups, "覆盖群数") +
        card(s.store.diskMb + " MB", "索引磁盘") + card(s.config.retentionDays + " 天", "保留期") +
        card(s.retriever.hits + "/" + s.retriever.queries, "检索命中/查询") +
        card(s.indexer.chunksIndexed, "累计索引分块") +
        '</div>' +
        '<h2>量化指标(最近一次评估)</h2>' +
        '<div class="cards">' +
        card(pct(ev.recallAt5Vector), "recall@5 纯向量") +
        card(pct(ev.recallAt5Hybrid), "recall@5 混合召回", true) +
        card(ev.recallAt5Rerank !== undefined ? pct(ev.recallAt5Rerank) : "未启用", "recall@5 混合+重排", true) +
        card(ev.latencyP50Ms ? ev.latencyP50Ms + " ms" : "-", "检索延迟 P50") +
        card(ev.latencyP95Ms ? ev.latencyP95Ms + " ms" : "-", "检索延迟 P95") +
        card(ev.samples || 0, "评估样本数") +
        '</div>' +
        '<div class="sub">评估时间:' + esc(ev.generatedAt || "尚未评估") + ' · embedding:' + esc(s.embedding.model) + ' · 缓存命中 ' + s.embedding.cacheHits + ' · 重排:' + (s.reranker ? esc(s.reranker.model) + " 请求 " + s.reranker.requests + (s.reranker.circuitBroken ? '<span class="off">(熔断中)</span>' : '') : "未启用") + (s.config.rerankInChat ? " · <span class=\\"good\\">聊天热路径已开重排</span>" : "") + '</div>' +
        '<h2>检索游乐场</h2>' +
        '<div class="row"><input id="pg-group" placeholder="群号(必填)"><input id="pg-query" placeholder="问题,如:我们之前聊的星露谷是什么"><label style="align-self:center;font-size:13px"><input type="checkbox" id="pg-rerank" style="flex:none;min-width:0" checked> 重排</label><button class="primary" id="pg-run">检索</button></div>' +
        '<div id="pg-out"></div>' +
        '<h2>分块浏览器</h2>' +
        '<div class="row"><input id="cb-group" placeholder="群号"><button id="cb-load">加载</button><button id="cb-more">更多</button></div>' +
        '<div id="cb-out"></div>' +
        '<h2>评估历史</h2><div id="eh-out">-</div>' +
        '<div class="row" style="margin-top:16px"><button onclick="refresh()">刷新总览</button></div>';
      document.getElementById("pg-run").onclick = runPlayground;
      document.getElementById("cb-load").onclick = function () { cbOffset = 0; loadChunks(); };
      document.getElementById("cb-more").onclick = function () { cbOffset += 20; loadChunks(); };
      loadEvalHistory();
    });
  }
  function card(num, label, good) { return '<div class="card"><div class="num' + (good ? ' good' : '') + '">' + esc(num) + '</div><div class="label">' + esc(label) + '</div></div>'; }
  function pct(v) { return (typeof v === "number" && isFinite(v)) ? Math.round(v * 100) + "%" : "-"; }
  var cbOffset = 0;
  function runPlayground() {
    var group = document.getElementById("pg-group").value.trim();
    var q = document.getElementById("pg-query").value.trim();
    var rerank = document.getElementById("pg-rerank").checked ? "1" : "";
    var out = document.getElementById("pg-out");
    out.innerHTML = '<div class="dim">检索中…</div>';
    api("playground", { group: group, q: q, rerank: rerank }).then(function (r) {
      if (r.error) { out.innerHTML = '<div class="item off">' + esc(r.error) + '</div>'; return; }
      var html = '<div class="sub">耗时 ' + r.elapsedMs + 'ms(向量 ' + (r.vectorMs || 0) + ' / BM25 ' + (r.bm25Ms || 0) + ' / 重排 ' + (r.rerankMs || 0) + ') · 候选 ' + r.candidates + ' · 命中 ' + r.items.length + (r.reranked ? " · 已重排" : "") + '</div>';
      r.items.forEach(function (it, i) {
        html += '<div class="item"><div class="scores">#' + (i + 1) + ' 余弦 ' + (it.vectorScore || 0).toFixed(3) + ' · 向量#' + (it.vectorRank || "-") + ' · BM25#' + (it.bm25Rank || "-") + (it.rerankScore != null ? ' · 重排 ' + it.rerankScore.toFixed(3) : '') + ' · ' + esc(it.timeRange) + '</div><div class="text">' + esc(it.text) + '</div></div>';
      });
      out.innerHTML = html || '<div class="dim">无命中</div>';
    });
  }
  function loadChunks() {
    var group = document.getElementById("cb-group").value.trim();
    var out = document.getElementById("cb-out");
    api("chunks", { group: group, offset: cbOffset, limit: 20 }).then(function (r) {
      if (r.error) { out.innerHTML = '<div class="item off">' + esc(r.error) + '</div>'; return; }
      var html = r.chunks.map(function (c) {
        return '<div class="item"><div class="scores">' + esc(c.id) + ' · ' + esc(c.timeRange) + ' · ' + esc(c.speakers) + ' · ' + c.messages + ' 条消息</div><div class="text">' + esc(c.preview) + '</div></div>';
      }).join("");
      out.innerHTML = html || '<div class="dim">该群暂无索引</div>';
    });
  }
  function loadEvalHistory() {
    api("eval-history").then(function (r) {
      var rows = (r.history || []).map(function (h) {
        return "<tr><td>" + esc(String(h.generatedAt || "").slice(5, 16)) + "</td><td>" + h.samples + "</td><td>" + pct(h.recallAt5Vector) + "</td><td class='good'>" + pct(h.recallAt5Hybrid) + "</td><td>" + (h.recallAt5Rerank !== undefined ? pct(h.recallAt5Rerank) : "-") + "</td><td>" + pct(h.recallAt10Hybrid) + "</td><td>" + (h.latencyP50Ms || "-") + "</td></tr>";
      }).join("");
      document.getElementById("eh-out").innerHTML = rows
        ? '<table><tr><th>时间</th><th>样本</th><th>@5 向量</th><th>@5 混合</th><th>@5 重排</th><th>@10 混合</th><th>P50ms</th></tr>' + rows + '</table>'
        : '<div class="dim">暂无历史(运行 .语义记忆 评估 或 eval 脚本生成)</div>';
    });
  }
  window.refresh = refresh;
  refresh();
})();
</script>
</body>
</html>`
}

export function registerSemanticMemoryWebApp(expressApp, pluginRoot, tokens = {}, logger = globalThis.logger) {
  if (!expressApp?.use || registered) return
  registered = true
  const token = typeof tokens === "string" ? { token: tokens } : tokens

  expressApp.use(MOUNT_PATH, async (req, res, next) => {
    if (req.path === "/" || req.path === "" || req.path === "/index.html") {
      res.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
      let initial = "{}"
      try {
        initial = JSON.stringify(buildStats(getSemanticMemoryRuntime()))
      } catch {}
      const html = buildPageHtml().replace(
        '<div id="app">加载中…</div>',
        '<div id="app">加载中…</div><script>window.__SM_SSR__=' + initial + '</script>'
      ).replace(
        "</head>",
        `<script>window.__BL_AUTO_TOKEN__=${JSON.stringify(String(token?.token || ""))};</script>\n</head>`
      )
      res.type("html").send(html)
      return
    }
    if (req.path.startsWith("/api/")) {
      if (!checkToken(req, token)) {
        res.status(401).json({ error: "访问令牌无效" })
        return
      }
      const runtime = getSemanticMemoryRuntime()
      try {
        if (req.path === "/api/stats") {
          res.json(buildStats(runtime))
          return
        }
        if (req.path === "/api/eval-history") {
          res.json({ history: runtime ? readEvalHistory(runtime.baseDir) : [] })
          return
        }
        if (!runtime) {
          res.status(503).json({ error: "语义记忆未启用" })
          return
        }
        if (req.path === "/api/playground") {
          const group = String(req.query.group || "").trim()
          const query = String(req.query.q || "").trim()
          if (!group || !query) {
            res.status(400).json({ error: "缺少 group 或 q 参数" })
            return
          }
          const rerank = req.query.rerank === "1" && runtime.config.rerankEnabled
          const result = await runtime.retriever.search(group, query, { timeoutMs: 5000, rerank })
          const fmt = ts => {
            const d = new Date(Number(ts) || 0)
            const pad = n => String(n).padStart(2, "0")
            return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
          }
          res.json({
            elapsedMs: result.elapsedMs, vectorMs: result.vectorMs, bm25Ms: result.bm25Ms,
            rerankMs: result.rerankMs || 0, reranked: Boolean(result.reranked),
            candidates: result.candidates || 0,
            items: result.items.map(item => ({
              id: item.chunk.id,
              timeRange: `${fmt(item.chunk.start_ts)} ~ ${fmt(item.chunk.end_ts)}`,
              speakers: (item.chunk.speakers || []).join("、"),
              messages: (item.chunk.message_ids || []).length,
              text: item.chunk.text,
              vectorScore: item.vectorScore, vectorRank: item.vectorRank,
              bm25Rank: item.bm25Rank, rerankScore: item.rerankScore
            }))
          })
          return
        }
        if (req.path === "/api/chunks") {
          const group = String(req.query.group || "").trim()
          const offset = Math.max(0, Number(req.query.offset) || 0)
          const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
          if (!group) {
            res.status(400).json({ error: "缺少 group 参数" })
            return
          }
          const state = runtime.store.loadGroup(group)
          const fmt = ts => {
            const d = new Date(Number(ts) || 0)
            const pad = n => String(n).padStart(2, "0")
            return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
          }
          const chunks = [...state.chunks.values()]
            .sort((a, b) => Number(b.end_ts || 0) - Number(a.end_ts || 0))
            .slice(offset, offset + limit)
            .map(chunk => ({
              id: chunk.id,
              timeRange: `${fmt(chunk.start_ts)} ~ ${fmt(chunk.end_ts)}`,
              speakers: (chunk.speakers || []).join("、"),
              messages: (chunk.message_ids || []).length,
              preview: String(chunk.text || "").slice(0, 400)
            }))
          res.json({ chunks, total: state.chunks.size })
          return
        }
        res.status(404).json({ error: "unknown api" })
      } catch (error) {
        logger?.warn?.(`[语义记忆页] API 失败: ${error.message}`)
        res.status(500).json({ error: error.message })
      }
      return
    }
    next()
  })
  logger?.info?.(`[语义记忆页] 已挂载 ${MOUNT_PATH}`)
}
