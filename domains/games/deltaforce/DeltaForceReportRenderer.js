import puppeteer from "../../../../../lib/puppeteer/puppeteer.js"
import DeltaForceReport from "./model/DeltaForceReport.js"

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function materialHtml(text) {
  if (!text) return '<span class="muted">-</span>'
  return `<span class="materials">${escapeHtml(text)}</span>`
}

function buildPlaceRows(rows) {
  return rows.map(row => `
    <tr>
      <td><span class="tag">${escapeHtml(row.placeName)}</span></td>
      <td class="center">Lv${escapeHtml(row.level)}</td>
      <td class="name">${escapeHtml(row.name)}</td>
      <td class="number">${escapeHtml(row.hourProfit)}</td>
      <td class="number strong">${escapeHtml(row.totalProfit)}</td>
      <td>${materialHtml(row.materials)}</td>
    </tr>
  `).join("")
}

function buildRankRows(rows) {
  return rows.map(row => `
    <tr>
      <td class="rank">#${escapeHtml(row.rank)}</td>
      <td class="name">${escapeHtml(row.name)}</td>
      <td><span class="tag">${escapeHtml(row.placeName)}</span></td>
      <td class="center">Lv${escapeHtml(row.level)}</td>
      <td class="number">${escapeHtml(row.hourProfit)}</td>
      <td class="number strong">${escapeHtml(row.totalProfit)}</td>
      <td>${materialHtml(row.materials)}</td>
    </tr>
  `).join("")
}

function buildSolutionRows(rows) {
  return rows.map(row => {
    const price = row.price ? `<div>价格 ${escapeHtml(row.price)}</div>` : ""
    const costPrice = row.costPrice ? `<div>成本 ${escapeHtml(row.costPrice)}</div>` : ""
    const applyNum = row.applyNum ? `<div>使用 ${escapeHtml(row.applyNum)}</div>` : ""
    const likeNum = row.likeNum ? `<div>点赞 ${escapeHtml(row.likeNum)}</div>` : ""
    const comment = row.comment ? `<div class="solution-comment">${escapeHtml(row.comment)}</div>` : ""
    const tag = row.tag ? `<span class="tag">${escapeHtml(row.tag)}</span>` : '<span class="muted">-</span>'
    const code = row.solutionCode ? escapeHtml(row.solutionCode) : '<span class="muted">-</span>'

    return `
      <tr>
        <td class="rank">#${escapeHtml(row.rank)}</td>
        <td>
          <div class="name">${escapeHtml(row.weapon)}</div>
          <div class="solution-name">${escapeHtml(row.name)}</div>
        </td>
        <td>${tag}</td>
        <td class="number">${price}${costPrice || '<div class="muted">-</div>'}</td>
        <td class="number">${applyNum}${likeNum || '<div class="muted">-</div>'}</td>
        <td>
          <div class="solution-code">${code}</div>
          ${comment}
        </td>
      </tr>
    `
  }).join("")
}

function buildObjectValueRows(rows) {
  return rows.map(row => {
    const priceRange = row.minPrice || row.maxPrice
      ? `${row.minPrice || "-"} / ${row.maxPrice || "-"}`
      : '<span class="muted">-</span>'
    const trend = row.change ? `<div>${escapeHtml(row.change)}</div>` : ""
    const count = row.count ? `<div class="muted">样本 ${escapeHtml(row.count)}</div>` : ""

    return `
      <tr>
        <td class="rank">#${escapeHtml(row.rank)}</td>
        <td class="name">${escapeHtml(row.name)}</td>
        <td><span class="tag">${escapeHtml(row.condition || "-")}</span></td>
        <td class="number strong">${escapeHtml(row.latestPrice || "-")}</td>
        <td class="number">${escapeHtml(row.avgPrice || "-")}</td>
        <td class="number">${priceRange}</td>
        <td class="number">${trend}${count || '<div class="muted">-</div>'}</td>
        <td class="time">${escapeHtml(row.updateTime || "-")}</td>
      </tr>
    `
  }).join("")
}

function buildPriceHistoryRows(rows) {
  return rows.map(row => `
    <tr>
      <td>
        <div class="history-card">
          <div class="history-head">
            <div>
              <div class="history-name">${escapeHtml(row.name)}</div>
              <div class="history-meta">${escapeHtml(row.objectID)}${row.condition ? `｜${escapeHtml(row.condition)}` : ""}</div>
            </div>
            <div class="history-stats">
              <div class="history-price">${escapeHtml(row.latestPrice || "-")}</div>
              <div class="history-change">${escapeHtml(row.days)}天涨跌 ${escapeHtml(row.change || "0")}</div>
              <div class="history-samples">${escapeHtml(row.pointCount || 0)} 天 / ${escapeHtml(row.sampleCount || 0)} 样本</div>
            </div>
          </div>
          ${row.chartSvg || ""}
        </div>
      </td>
    </tr>
  `).join("")
}

export function buildDeltaForceReportView(report) {
  const columnsHtml = (report.columns || [])
    .map(column => `<th>${escapeHtml(column)}</th>`)
    .join("")
  const rows = report.rows || []
  const columnCount = Math.max((report.columns || []).length, 1)
  let rowsHtml = buildPlaceRows(rows)
  if (report.kind === "profit-rank") rowsHtml = buildRankRows(rows)
  if (report.kind === "solution-list") rowsHtml = buildSolutionRows(rows)
  if (report.kind === "object-value") rowsHtml = buildObjectValueRows(rows)
  if (report.kind === "price-history") rowsHtml = buildPriceHistoryRows(rows)
  if (!rows.length) {
    rowsHtml = `<tr><td class="empty" colspan="${columnCount}">${escapeHtml(report.emptyText || "暂无数据")}</td></tr>`
  }

  return {
    kindClass: escapeHtml(report.kind || "place-profit"),
    title: escapeHtml(report.title || "三角洲行动"),
    subtitle: escapeHtml(report.subtitle || ""),
    generatedAt: escapeHtml(report.generatedAt || ""),
    columnsHtml,
    rowsHtml,
    emptyText: escapeHtml(report.emptyText || "暂无数据")
  }
}

export async function renderDeltaForceReport(e, report) {
  const view = buildDeltaForceReportView(report)
  const data = await new DeltaForceReport(e).getData(view, 1)
  return puppeteer.screenshot("deltaForceReport", data, 2)
}
