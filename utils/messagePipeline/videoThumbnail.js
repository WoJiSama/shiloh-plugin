import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const run = promisify(execFile)

export async function createVideoThumbnail(file, { runner = run } = {}) {
  const source = String(file || "").replace(/^file:\/\//, "")
  if (!source || /^(https?:|base64:)/i.test(source)) throw new Error("video_thumbnail_missing: 视频没有可用的本地文件")
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shiloh-video-thumb-"))
  const target = path.join(directory, "cover.jpg")
  try {
    await runner("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", source, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", "-y", target], { timeout: 30000, maxBuffer: 128 * 1024 })
    if (!(await fs.stat(target)).size) throw new Error("empty thumbnail")
    return { file: target, async cleanup() { await fs.rm(directory, { recursive: true, force: true }) } }
  } catch {
    await fs.rm(directory, { recursive: true, force: true })
    throw new Error("video_thumbnail_missing: 视频封面生成失败")
  }
}

export function isForwardResourceFailure(error) {
  return /上传转发消息资源失败|video_thumbnail_missing|(?:ENOENT|no such file).*?(?:Thumb|thumb|cover)/is.test(String(error?.message || error || ""))
}
