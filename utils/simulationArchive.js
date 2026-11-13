import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The bot and standalone console can start from different working directories.
const simulationPluginRoot = process.env.CONSOLE_PLUGIN_ROOT || fileURLToPath(new URL('../', import.meta.url))

export async function readSimulationArchive(groupId, days) {
  try {
    const base = path.join(simulationPluginRoot, 'data/message_archive/group', String(groupId))
    const out = []
    for (let i = 0; i < Math.min(14, Math.max(1, days)); i += 1) {
      const d = new Date(Date.now() - i * 86400000 + 8 * 3600000)
      const file = path.join(base, d.toISOString().slice(0, 10) + '.ndjson')
      if (!fs.existsSync(file)) continue
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-500)
      for (const line of lines) {
        try {
          const r = JSON.parse(line)
          if (r.recalled) continue
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
}
