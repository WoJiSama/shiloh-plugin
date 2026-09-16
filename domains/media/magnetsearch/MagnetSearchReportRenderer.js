import puppeteer from "../../../../../lib/puppeteer/puppeteer.js"
import MagnetSearchReport from "./model/MagnetSearchReport.js"

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function buildRows(rows) {
  return rows.map(row => `
    <tr>
      <td class="rank">#${escapeHtml(row.rank)}</td>
      <td class="name">${escapeHtml(row.name)}</td>
      <td class="number">${escapeHtml(row.size || "-")}</td>
      <td class="number">
        <div>做种 ${escapeHtml(row.seeders || "0")}</div>
        <div class="muted">下载 ${escapeHtml(row.leechers || "0")}</div>
      </td>
      <td><div class="magnet">${escapeHtml(row.magnet || "-")}</div></td>
    </tr>
  `).join("")
}

export function buildMagnetSearchReportView(report) {
  const columnsHtml = (report.columns || [])
    .map(column => `<th>${escapeHtml(column)}</th>`)
    .join("")
  const rows = report.rows || []
  const columnCount = Math.max((report.columns || []).length, 1)
  const rowsHtml = rows.length
    ? buildRows(rows)
    : `<tr><td class="empty" colspan="${columnCount}">${escapeHtml(report.emptyText || "暂无数据")}</td></tr>`

  return {
    kindClass: "magnet-search",
    title: escapeHtml(report.title || "磁力搜索"),
    subtitle: escapeHtml(report.subtitle || ""),
    generatedAt: escapeHtml(report.generatedAt || ""),
    columnsHtml,
    rowsHtml
  }
}

export async function renderMagnetSearchReport(e, report) {
  const view = buildMagnetSearchReportView(report)
  const data = await new MagnetSearchReport(e).getData(view, 1)
  return puppeteer.screenshot("magnetSearchReport", data, 2)
}
