import puppeteer from "../../../../../lib/puppeteer/puppeteer.js"
import UmaRaceReport from "./model/UmaRaceReport.js"

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function normalizeAffixQuality(quality = "") {
  const q = String(quality || "common").trim().toLowerCase()
  if (["broken", "flawed", "bad", "破损"].includes(q)) return "broken"
  if (["cursed", "curse", "诅咒"].includes(q)) return "cursed"
  if (["good", "excellent", "优秀"].includes(q)) return "good"
  if (["rare", "稀有"].includes(q)) return "rare"
  if (["epic", "史诗"].includes(q)) return "epic"
  if (["shiny", "epic", "legendary", "闪耀", "传说"].includes(q)) return "shiny"
  return "common"
}

function buildRunnerName(row = {}) {
  const affix = row.affix && row.affix.label ? row.affix : null
  const affixHtml = affix
    ? `<span class="runner-affix affix-${normalizeAffixQuality(affix.quality)}">[${escapeHtml(affix.label)}]</span>`
    : ""
  const npcHtml = row.isNpc ? `<span class="npc-mark">NPC</span>` : ""
  const gapHtml = row.gapText ? `<span class="runner-gap">${escapeHtml(row.gapText)}</span>` : ""
  return `${affixHtml}<span class="runner-name">${escapeHtml(row.name || "-")}</span>${npcHtml}${gapHtml}`
}

function buildRankRows(rows = []) {
  return rows.map(row => `
    <tr>
      <td class="rank">#${escapeHtml(row.rank)}</td>
      <td>
        <div class="runner">${buildRunnerName(row)}</div>
        <div class="meta">${escapeHtml(row.meta || "")}</div>
      </td>
      <td><span class="tag">${escapeHtml(row.strategy || "-")}</span></td>
      <td class="state">${escapeHtml(row.state || "")}</td>
    </tr>
  `).join("")
}

function buildHighlightRows(lines = []) {
  return lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")
}

function buildAwardRows(lines = []) {
  return lines.map(line => `<span class="award">${escapeHtml(line)}</span>`).join("")
}

function buildProficiencyRows(entries = []) {
  return entries.map(entry => {
    const gains = Array.isArray(entry.gains) ? entry.gains : []
    const gainHtml = gains.map(item => {
      const progress = item.progress || {}
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0))
      const target = progress.target || 1000
      const needText = progress.need > 0
        ? `距${escapeHtml(progress.nextLevel || "下一级")}还差 ${escapeHtml(progress.need)}`
        : "已到最高档"
      return `
        <div class="prof-item">
          <div class="prof-main">
            <span class="prof-action">${escapeHtml(item.label || item.actionKey || "-")}</span>
            <span class="prof-gain">+${escapeHtml(item.gain || 0)}</span>
            <span class="prof-level">Lv.${escapeHtml(progress.levelIndex || 1)} ${escapeHtml(progress.level || "生疏")}</span>
          </div>
          <div class="prof-progress">
            <div class="prof-bar"><span style="width:${percent}%"></span></div>
            <div class="prof-num">${escapeHtml(item.after || 0)}/${escapeHtml(target)} · ${needText}</div>
          </div>
        </div>
      `
    }).join("")
    return `
      <div class="prof-runner">
        <div class="prof-name">${escapeHtml(entry.umaName || entry.nickname || "-")}</div>
        <div class="prof-list">${gainHtml}</div>
      </div>
    `
  }).join("")
}

export function buildUmaRaceReportView(report = {}) {
  const proficiencyGains = Array.isArray(report.proficiencyGains) ? report.proficiencyGains : []
  return {
    typeClass: escapeHtml(report.type || "stage"),
    title: escapeHtml(report.title || "赛马娘比赛"),
    subtitle: escapeHtml(report.subtitle || ""),
    scene: escapeHtml(report.scene || ""),
    generatedAt: escapeHtml(report.generatedAt || ""),
    prompt: escapeHtml(report.prompt || ""),
    rankRowsHtml: buildRankRows(report.ranking || []),
    highlightsHtml: buildHighlightRows(report.highlights || []),
    awardsHtml: buildAwardRows(report.awards || []),
    proficiencyHtml: buildProficiencyRows(proficiencyGains),
    hasAwardsClass: report.awards?.length ? "has-awards" : "no-awards",
    hasProficiencyClass: proficiencyGains.length ? "has-proficiency" : "no-proficiency"
  }
}

export async function renderUmaRaceReport(e, report) {
  const view = buildUmaRaceReportView(report)
  const data = await new UmaRaceReport(e).getData(view, 1)
  return puppeteer.screenshot("umaRaceReport", data, 2)
}
