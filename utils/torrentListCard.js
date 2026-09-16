import fs from "fs"
import path from "path"
import { getSharedBrowser, scheduleSharedBrowserClose } from "./sharedBrowser.js"
import { formatBytes } from "./torrentDownload.js"

const MAX_CARD_ROWS = 24

/**
 * 磁链清单卡面：把 formatTorrentSelectionListing 的长文本清单整理成
 * 可渲染的行数据。纯函数,便于单测。
 */
export function buildTorrentListCardData(metadata = {}, {
  selectableIndexes = [],
  unavailableReasons = new Map(),
  maxTotalBytes = 50 * 1000 * 1000,
  maxRows = MAX_CARD_ROWS
} = {}) {
  const selectable = new Set((Array.isArray(selectableIndexes) ? selectableIndexes : [])
    .map(value => Number(value))
    .filter(value => Number.isSafeInteger(value) && value >= 1))
  const files = Array.isArray(metadata.files) ? metadata.files : []
  const rows = files.map((file, offset) => {
    const index = Number(file.index) || offset + 1
    const isSelectable = selectable.has(index)
    const reason = unavailableReasons instanceof Map
      ? unavailableReasons.get(index)
      : unavailableReasons?.[index]
    return {
      index,
      name: String(file.relativePath?.slice(1).join("/") || metadata.name || ""),
      size: formatBytes(file.size),
      selectable: isSelectable,
      reason: isSelectable ? "" : String(reason || "超过当前下载限制")
    }
  })
  const available = rows.filter(row => row.selectable).map(row => row.index)
  const shown = rows.slice(0, Math.max(1, Number(maxRows) || MAX_CARD_ROWS))
  return {
    name: String(metadata.name || ""),
    total: formatBytes(metadata.totalBytes),
    limit: formatBytes(maxTotalBytes),
    fileCount: rows.length,
    selectableCount: available.length,
    rows: shown,
    hiddenCount: Math.max(0, rows.length - shown.length),
    availablePreview: available.slice(0, 6).join("、") + (available.length > 6 ? " 等" : "")
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function buildTorrentListHtml(data) {
  const rows = data.rows.map(row => `
    <tr class="${row.selectable ? "ok" : "blocked"}">
      <td class="num">${row.index}</td>
      <td class="name"><span class="fname" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span></td>
      <td class="size">${escapeHtml(row.size)}</td>
      <td class="state">${row.selectable ? '<i class="badge ok">可下载</i>' : '<i class="badge no">不可下载</i>'}</td>
    </tr>${row.selectable ? "" : `<tr class="why"><td></td><td colspan="3" class="reason">${escapeHtml(row.reason)}</td></tr>`}`
  ).join("")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 760px; font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; background: #f3f5f9; color: #1f2430; padding: 22px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 6px 24px rgba(15, 23, 42, .08); overflow: hidden; }
  .head { padding: 18px 22px 14px; border-bottom: 1px solid #e8ecf3; }
  .head h1 { font-size: 20px; line-height: 1.35; word-break: break-all; }
  .meta { margin-top: 8px; font-size: 13px; color: #6b7280; display: flex; gap: 14px; flex-wrap: wrap; }
  .meta b { color: #111827; font-weight: 600; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .pill.total { background: #eef2ff; color: #4338ca; }
  .pill.limit { background: #fef3c7; color: #92400e; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 7px 10px; vertical-align: middle; }
  thead td { font-size: 12px; color: #8a93a5; background: #fafbfd; border-bottom: 1px solid #e8ecf3; }
  td.num { width: 34px; text-align: center; color: #8a93a5; font-variant-numeric: tabular-nums; }
  td.name { word-break: break-all; }
  td.size { width: 84px; text-align: right; color: #4b5563; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.state { width: 88px; text-align: center; }
  tr.blocked td { background: #fbfbfc; }
  tr.blocked .fname { color: #9ca3af; }
  tr.why td.reason { padding-top: 0; padding-bottom: 8px; font-size: 12px; color: #b45454; }
  .badge { font-style: normal; font-size: 12px; padding: 2px 8px; border-radius: 999px; }
  .badge.ok { background: #e7f6ec; color: #147d3d; }
  .badge.no { background: #f3f4f6; color: #9ca3af; }
  .foot { padding: 12px 22px 16px; border-top: 1px solid #e8ecf3; font-size: 13px; color: #4b5563; line-height: 1.7; }
  .foot b { color: #111827; }
  .hint { margin-top: 4px; color: #8a93a5; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <h1>${escapeHtml(data.name || "磁链文件清单")}</h1>
      <div class="meta">
        <span class="pill total">总大小 <b>${escapeHtml(data.total)}</b></span>
        <span class="pill limit">单包上限 ${escapeHtml(data.limit)}</span>
        <span>共 <b>${data.fileCount}</b> 个文件 · 可下载 <b>${data.selectableCount}</b> 个</span>
      </div>
    </div>
    <table>
      <thead><tr><td class="num">#</td><td>文件</td><td class="size">大小</td><td class="state">状态</td></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="foot">
      ${data.hiddenCount ? `<div class="hint">清单过长，已显示前 ${data.rows.length} 个文件，其余 ${data.hiddenCount} 个略。</div>` : ""}
      <div>可下载编号：<b>${escapeHtml(data.availablePreview || "无")}</b></div>
      <div class="hint">回复「下载 编号」即可，例如 下载 1,2；只能选择标为可下载的编号。</div>
    </div>
  </div>
</body>
</html>`
}

/** 渲染清单卡面,返回图片路径;调用方负责发送后删除临时文件 */
export async function renderTorrentListCard(data) {
  const outputDir = path.join(process.cwd(), "resources", "shiloh-plugin", "torrent_cards")
  await fs.promises.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `torrent-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)

  const browser = await getSharedBrowser()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 760, height: 900, deviceScaleFactor: 2 })
    await page.setContent(buildTorrentListHtml(data), { waitUntil: "domcontentloaded", timeout: 30000 })
    const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height))
    await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: 760, height: Math.max(1, height) }, type: "png" })
    return outputPath
  } finally {
    await page.close().catch(() => {})
    scheduleSharedBrowserClose()
  }
}

export async function deleteTorrentCard(path_) {
  if (!path_) return
  try { await fs.promises.unlink(path_) } catch {}
}
