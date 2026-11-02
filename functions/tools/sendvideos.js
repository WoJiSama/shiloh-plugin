import fs from 'node:fs/promises'
import {bilibiliParser} from './bilibilivideoanalysis.js'
import {createSendVideos} from '../../dist/backend/modules/media/infrastructure/sendvideos.js'
import {inlineForwardVideoSegment} from '../../dist/backend/modules/messaging/infrastructure/deliveryGateway.js'

// NapCat 跑在独立容器里，宿主机的 /tmp 路径它读不到（实测 ENOENT 后被静默跳过、视频从未送达）。
// 出站前把本地文件段过一遍投递网关的同款暂存：配置了共享目录就拷进去改写为容器可见路径，
// 没配置则回退 base64 内联。共享目录副本延迟清理（NapCat 返回回执后还会继续异步上传）。
async function readSharedMedia() {
  try {
    const { getConfig } = await import('../../model/config.js')
    const raw = getConfig('message')?.pluginSettings || {}
    const hostDir = String(raw.mediaSharedHostDir || '').trim()
    const containerDir = String(raw.mediaSharedContainerDir || '').trim()
    return hostDir && containerDir ? { hostDir, containerDir } : null
  } catch { return null }
}
async function stageVideoSegment(segment) {
  const sharedMedia = await readSharedMedia()
  const staged = await inlineForwardVideoSegment(segment, { sharedMedia })
  const file = String(staged?.data?.file || staged?.file || '')
  if (sharedMedia && file.startsWith('file://')) {
    const hostFile = file.replace(/^file:\/\//, '').replace(sharedMedia.containerDir, sharedMedia.hostDir)
    setTimeout(() => { fs.unlink(hostFile).catch(() => {}) }, 10 * 60_000).unref?.()
  }
  return staged
}

export const sendvideos=createSendVideos({
  parse:bilibiliParser,
  video:file=>globalThis.segment.video(file),
  stageSegment:stageVideoSegment,
  log:message=>globalThis.logger?.info?.(message)
})
