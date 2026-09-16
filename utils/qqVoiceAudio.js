import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const VOICE_TMP_DIR = path.join(os.tmpdir(), "shiloh-plugin-voice")

export function sanitizeVoiceText(text = "", maxLength = 80) {
  const limit = Math.max(8, Math.min(300, Number(maxLength) || 80))
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "图片")
    .replace(/\[[^\]]*]\([^)]+\)/g, "")
    .replace(/[()（）【】[\]{}<>《》]/g, " ")
    .replace(/[#*_~|>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

export function selectVoiceStyle(text = "", styles = {}) {
  const content = String(text || "")
  if (/(害羞|不好意思|别这样|你别|唔|呜|脸红|小声|撒娇)/.test(content)) return styles.shy ? "shy" : "normal"
  if (/(你少来|别闹|才没有|烦|吐槽|绷不住|草|笑死)/.test(content)) return styles.tease ? "tease" : "normal"
  if (/(解释|认真|结论|原因|原理|首先|因为|所以|总结)/.test(content)) return styles.serious ? "serious" : "normal"
  if (/(困|睡|晚安|懒|趴|不想动)/.test(content)) return styles.sleepy ? "sleepy" : "normal"
  return "normal"
}

export function getVoiceStyleConfig(voiceSystem = {}, styleName = "normal") {
  const styles = voiceSystem.styles || {}
  const base = styles.normal || {}
  const selected = styles[styleName] || {}
  return { ...base, ...selected, name: styleName }
}

export async function writeTempVoiceFile(buffer, format = "mp3") {
  const ext = String(format || "mp3").replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp3"
  await fs.mkdir(VOICE_TMP_DIR, { recursive: true })
  const filePath = path.join(VOICE_TMP_DIR, `${Date.now()}-${randomUUID()}.${ext}`)
  await fs.writeFile(filePath, buffer)
  return filePath
}

export function scheduleVoiceFileCleanup(filePath, delayMs = 5 * 60 * 1000) {
  if (!filePath) return
  setTimeout(() => {
    fs.unlink(filePath).catch(() => {})
  }, Math.max(1000, Number(delayMs) || 5 * 60 * 1000)).unref?.()
}
