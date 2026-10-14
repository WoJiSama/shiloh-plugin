export interface ContextRecord { [key:string]:unknown }
export interface MediaAsset {source:string;fileName:string;name:string;fileId:string;type:string;origin:string;senderName:string;senderUserId:string;forwardId:string;label:string;position?:number}
export interface ForwardNode {user_id:string;nickname:string;time:number|undefined;message:ContextRecord[];nested_forwards:{id:string;nodes:ForwardNode[]}[]}
export interface ForwardGroup {getForwardMsg?(id:string):Promise<unknown>}
export interface ContextEvent {group?:ForwardGroup;message?:unknown;sender?:{card?:string;nickname?:string};user_id?:string|number}
interface MediaMeta {origin?:string;senderName?:string;senderUserId?:unknown;forwardId?:string;label?:string}
function record(value:unknown):ContextRecord {return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ContextRecord : {}}
import { getMentionTargetId } from "../domain/mentionTargets.js"
import { safeTruncateUnicode } from "../../models/domain/unicodeText.js"

function compactText(text = "", maxLength = 6000) {
  return safeTruncateUnicode(String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim(), maxLength)
}

const FORWARD_SNAPSHOT_MAX_SEGMENTS = 100
const FORWARD_SNAPSHOT_MAX_STRING_LENGTH = 100000

function copyForwardSnapshotValue(value:unknown, depth = 0, seen = new WeakSet<object>()):unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return value.slice(0, FORWARD_SNAPSHOT_MAX_STRING_LENGTH)
  if (["number", "boolean"].includes(typeof value)) return value
  if (typeof value === "bigint") return String(value)
  if (typeof value !== "object" || depth >= 8 || Buffer.isBuffer(value) || seen.has(value)) return undefined
  seen.add(value)
  if (Array.isArray(value)) {
    return value.slice(0, FORWARD_SNAPSHOT_MAX_SEGMENTS)
      .map(item => copyForwardSnapshotValue(item, depth + 1, seen))
      .filter(item => item !== undefined)
  }
  const copied:ContextRecord = {}
  for (const [key, item] of Object.entries(value)) {
    const next = copyForwardSnapshotValue(item, depth + 1, seen)
    if (next !== undefined) copied[key] = next
  }
  return copied
}

function snapshotForwardSegments(segments:unknown = []):ContextRecord[] {
  return normalizeMessageSegments(segments).slice(0, FORWARD_SNAPSHOT_MAX_SEGMENTS).map(segment => {
    const copied = record(copyForwardSnapshotValue(segment))
    if (!copied || typeof copied !== "object") return null
    if (copied.type === "forward") {
      const id = extractForwardIdFromSegment(copied)
      return id ? { type: "forward", id: String(id) } : { type: "forward" }
    }
    return copied
  }).filter((item):item is ContextRecord => item !== null)
}

function parseForwardJsonPayload(value:unknown):ContextRecord|null {
  if (!value) return null
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value))
    } catch {
      return null
    }
  }
  return typeof value === "object" ? record(value) : null
}

export function getSegmentData(segment:ContextRecord = {}):ContextRecord {
  const data = segment?.data
  return record(data)
}

export function normalizeMessageSegments(message:unknown):ContextRecord[] {
 const input=record(message)
 const list=Array.isArray(message)?message:Array.isArray(input.message)?input.message:Array.isArray(input.content)?input.content:[]
 return list.map(record)
}
export function normalizeForwardMessageList(payload:unknown):ContextRecord[] {
 const input=record(payload);const data=input.data || payload;const nested=record(data)
 const list=Array.isArray(data)?data:Array.isArray(nested.messages)?nested.messages:Array.isArray(nested.nodes)?nested.nodes:[]
 return list.map(record)
}
export function extractForwardIdFromSegment(segment:ContextRecord = {}) {
  const data = getSegmentData(segment)
  if (segment?.type === "forward") {
    return segment.id || data.id || segment.resid || data.resid || segment.file || data.file || ""
  }
  if (segment?.type === "json") {
    const jsonData = parseForwardJsonPayload(data.data ?? segment.data)
    if (jsonData?.app === "com.tencent.multimsg") {
      return record(record(jsonData.meta).detail).resid || record(record(jsonData.meta).detail).uniseq || ""
    }
  }
  return ""
}

export function extractForwardIdsFromSegments(segments:unknown = []) {
  const ids:string[] = []
  for (const segment of normalizeMessageSegments(segments)) {
    const id = String(extractForwardIdFromSegment(segment) || "").trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export function getForwardSenderName(input:unknown = {}):string {
 const message=record(input),sender=record(message.sender)
 return String(sender.card || sender.nickname || message.nickname || message.user_name || message.name || '未知')
}
export function getReplyTargetUserId(input:unknown = {}):unknown {
 const reply=record(input),sender=record(reply.sender),nested=record(record(reply.data).sender)
 return sender.user_id || sender.qq || reply.sender_id || reply.user_id || reply.qq || nested.user_id || nested.qq || ''
}
export function extractReadableTextFromSegments(segments:unknown = [], fallback = "") {
  const parts = []
  for (const segment of normalizeMessageSegments(segments)) {
    const data = getSegmentData(segment)
    if (segment?.type === "text") {
      const text = segment.text ?? data.text
      if (text) parts.push(String(text))
      continue
    }
    if (segment?.type === "at") {
      const qq = getMentionTargetId({qq:segment.qq,user_id:segment.user_id,id:segment.id,uin:segment.uin,uid:segment.uid,data:getSegmentData(segment)})
      if (qq && String(qq) !== "all") parts.push(`@${qq}`)
      continue
    }
    if (segment?.type === "image") parts.push("[图片]")
    if (segment?.type === "video") parts.push("[视频]")
    if (segment?.type === "record" || segment?.type === "voice") parts.push("[语音]")
    if (segment?.type === "file") {
      const fileName = segment.name || data.name || segment.file || data.file
      parts.push(`[文件${fileName ? `:${fileName}` : ""}]`)
    }
  }
  return compactText(parts.join("")) || compactText(fallback)
}

function normalizeMediaSource(value:unknown = "", type = "image") {
  const source = String(value || "").replace(/&amp;/g, "&").trim()
  if (!source) return ""
  if (/^(?:https?:\/\/|base64:\/\/|file:\/\/)/i.test(source)) return source
  if (type === "image" && /^data:image\//i.test(source)) return source
  return ""
}

function extractFileIdFromSource(source = "") {
  if (!/^https?:\/\//i.test(source)) return ""
  try {
    const url = new URL(source)
    for (const key of ["fileid", "file_id", "fid"]) {
      const value = String(url.searchParams.get(key) || "").trim()
      if (value) return value
    }
  } catch {}
  return ""
}

function extractStableFileId(segment:ContextRecord = {}, data:ContextRecord = {}, source = "") {
  const explicit = segment.file_id || segment.fid || segment.id || data.file_id || data.fid || data.id
  if (String(explicit || "").trim()) return String(explicit).trim()
  const sourceFileId = extractFileIdFromSource(source)
  if (sourceFileId) return sourceFileId
  const rawFile = segment.file || data.file
  const value = String(rawFile || "").trim()
  return value && !/^(?:https?:\/\/|base64:\/\/|file:\/\/|data:)/i.test(value) ? value : ""
}

function canonicalizeMediaSource(source = "") {
  const value = String(source || "").trim()
  if (!/^https?:\/\//i.test(value)) return value
  try {
    const url = new URL(value)
    for (const key of ["rkey", "spec", "download", "quality", "thumb", "term", "flags"]) {
      url.searchParams.delete(key)
    }
    url.hash = ""
    return url.toString()
  } catch {
    return value
  }
}

function mediaLabel(type = "image") {
  const labels:Record<string,string> = { image: "图片", video: "视频", record: "语音", voice: "语音", file: "文件" }; return labels[type] || "媒体"
}

function mediaUnit(type = "image") {
  const units:Record<string,string> = { image: "张", video: "段", record: "段", file: "个" }; return units[type] || "个"
}

export function extractMediaAssetsFromSegments(segments:unknown = [], meta:MediaMeta = {}):MediaAsset[] {
  const assets = []
  const typeCounts = new Map()
  for (const segment of normalizeMessageSegments(segments)) {
    const type = segment?.type === "voice" ? "record" : String(segment?.type || "")
    if (!["image", "video", "record", "file"].includes(type)) continue
    const data = getSegmentData(segment)
    const fileName = type === "file"
      ? String(segment.name || data.name || segment.file_name || data.file_name || segment.file || data.file || "").trim()
      : ""
    const source = normalizeMediaSource(
      segment.url || segment.file_url || data.url || data.file_url || segment.file || data.file,
      type
    )
    const fileId = extractStableFileId(segment, data, source)
    if (!source && !(type === "file" && fileId)) continue
    const index = (typeCounts.get(type) || 0) + 1
    typeCounts.set(type, index)
    assets.push({
      source,
      fileName,
      name: fileName,
      fileId,
      type,
      origin: meta.origin || "message",
      senderName: meta.senderName || "",
      senderUserId: meta.senderUserId ? String(meta.senderUserId) : "",
      forwardId: meta.forwardId || "",
      label: meta.label || `${meta.origin === "reply" ? "引用消息" : "当前消息"}第${index}${mediaUnit(type)}${mediaLabel(type)}${fileName ? `:${fileName}` : ""}`
    })
  }
  return assets
}

export function extractImageAssetsFromSegments(segments:unknown = [], meta:MediaMeta = {}) {
  return extractMediaAssetsFromSegments(segments, meta).filter(asset => asset.type === "image")
}

function dedupeAssets(assets:MediaAsset[] = [], maxItems = 12) {
  const result = []
  const seen = new Set()
  for (const asset of assets) {
    const source = String(asset?.source || "").trim()
    const fileId = String(asset?.fileId || "").trim()
    const key = `${asset?.type || "image"}:${fileId || canonicalizeMediaSource(source)}`
    if ((!source && !fileId) || seen.has(key)) continue
    seen.add(key)
    result.push({ ...asset, source, position: result.length + 1 })
    if (result.length >= maxItems) break
  }
  return result
}

export async function collectForwardContext(group:ForwardGroup|null, segments:unknown = [], options:{maxDepth?:number;maxLines?:number;maxImages?:number;maxText?:number} = {}) {
  const maxDepth = Math.max(1, Number(options.maxDepth) || 3)
  const maxLines = Math.max(1, Number(options.maxLines) || 80)
  const maxImages = Math.max(1, Number(options.maxImages) || 12)
  const lines:string[] = []
  const images:MediaAsset[] = []
  const media:MediaAsset[] = []
  const visited = new Set()
  const active = new Set()
  const snapshots = new Map<string,ForwardNode[]>()
  let nodeCount = 0

  const snapshotForward = async (forwardId:string, depth = 0):Promise<ForwardNode[]> => {
    const id = String(forwardId || "").trim()
    if (!id || depth >= maxDepth || nodeCount >= maxLines || !group?.getForwardMsg) return []
    const snapshot=snapshots.get(id)
    if (snapshot) return snapshot
    if (active.has(id)) return []
    active.add(id)
    let messages = []
    try {
      messages = normalizeForwardMessageList(await group.getForwardMsg(id))
    } catch {
      active.delete(id)
      return []
    }
    const nodes:ForwardNode[] = []
    for (const message of messages) {
      if (nodeCount >= maxLines) break
      const messageSegments = normalizeMessageSegments(message)
      const nested = []
      for (const nestedId of extractForwardIdsFromSegments(messageSegments)) {
        nested.push({ id: nestedId, nodes: await snapshotForward(nestedId, depth + 1) })
      }
      nodes.push({
        user_id: String(getReplyTargetUserId(message) || ""),
        nickname: getForwardSenderName(message),
        time: Number(message?.time || record(message?.sender).time || 0) || undefined,
        message: snapshotForwardSegments(messageSegments),
        nested_forwards: nested.filter(item => item.id)
      })
      nodeCount++
    }
    active.delete(id)
    snapshots.set(id, nodes)
    return nodes
  }

  const visit = async (forwardId:string, depth = 0):Promise<void> => {
    const id = String(forwardId || "").trim()
    if (!id || depth >= maxDepth || lines.length >= maxLines || visited.has(id) || !group?.getForwardMsg) return
    visited.add(id)

    let messages = []
    try {
      messages = normalizeForwardMessageList(await group.getForwardMsg(id))
    } catch {
      return
    }

    const indent = "  ".repeat(depth)
    for (const message of messages) {
      if (lines.length >= maxLines) break
      const messageSegments = normalizeMessageSegments(message)
      const senderName = getForwardSenderName(message)
      const senderUserId = getReplyTargetUserId(message)
      const text = extractReadableTextFromSegments(
        messageSegments,
        String(message.raw_message || message.message_text || message.content_text || "")
      )
      if (text) lines.push(`${indent}${senderName}: ${text}`)

      if (media.length < maxImages * 2) {
        const messageMedia = extractMediaAssetsFromSegments(messageSegments, {
          origin: "forward",
          senderName,
          senderUserId,
          forwardId: id
        })
        for (const asset of messageMedia) {
          const sameTypeIndex = media.filter(item => item.type === asset.type && item.senderName === senderName).length + 1
          const labeled = {
            ...asset,
            label: `合并转发中 ${senderName} 的第${sameTypeIndex}${mediaUnit(asset.type)}${mediaLabel(asset.type)}`
          }
          media.push(labeled)
          if (asset.type === "image") images.push(labeled)
          if (images.length >= maxImages && media.length >= maxImages * 2) break
        }
      }

      for (const nestedId of extractForwardIdsFromSegments(messageSegments)) {
        if (lines.length < maxLines) lines.push(`${indent}${senderName}: [嵌套转发记录]`)
        await visit(nestedId, depth + 1)
      }
    }
  }

  for (const forwardId of extractForwardIdsFromSegments(segments)) {
    await visit(forwardId, 0)
  }

  const forwardNodes = []
  for (const forwardId of extractForwardIdsFromSegments(segments)) {
    forwardNodes.push({ id: forwardId, nodes: await snapshotForward(forwardId, 0) })
  }

  return {
    text: compactText(lines.join("\n"), Number(options.maxText) || 6000),
    lines,
    images: dedupeAssets(images, maxImages),
    media: dedupeAssets(media, maxImages * 2),
    forwardIds: [...visited],
    forwardNodes
  }
}

export async function resolveGroupContextAssets({ e = {}, group = null, reply = null, maxImages = 12 }:{e?:ContextEvent;group?:ForwardGroup|null;reply?:unknown;maxImages?:number} = {}) {
  const activeGroup = group || e?.group || null
  const currentSegments = normalizeMessageSegments(e?.message)
  const replySegments = normalizeMessageSegments(reply)
  const currentMedia = extractMediaAssetsFromSegments(currentSegments, {
    origin: "current",
    senderName: e?.sender?.card || e?.sender?.nickname || "当前发言者",
    senderUserId: e?.user_id
  })
  const quotedMedia = extractMediaAssetsFromSegments(replySegments, {
    origin: "reply",
    senderName: String(record(record(reply).sender).card || record(record(reply).sender).nickname || "") || "被引用用户",
    senderUserId: getReplyTargetUserId(reply)
  })
  const currentImages = currentMedia.filter(asset => asset.type === "image")
  const quotedImages = quotedMedia.filter(asset => asset.type === "image")

  const [currentForward, quotedForward] = await Promise.all([
    collectForwardContext(activeGroup, currentSegments, { maxImages, maxText: 5000 }),
    collectForwardContext(activeGroup, replySegments, { maxImages, maxText: 5000 })
  ])
  const images = dedupeAssets([
    ...currentImages,
    ...quotedImages,
    ...currentForward.images,
    ...quotedForward.images
  ], maxImages)
  const media = dedupeAssets([
    ...currentMedia,
    ...quotedMedia,
    ...currentForward.media,
    ...quotedForward.media
  ], maxImages * 2)

  return {
    reply,
    replyTargetUserId: String(getReplyTargetUserId(reply) || ""),
    replyTargetLabel: String(record(record(reply).sender).card || record(record(reply).sender).nickname || "") || "",
    currentImages: dedupeAssets(currentImages, maxImages),
    quotedImages: dedupeAssets(quotedImages, maxImages),
    forwardImages: dedupeAssets([...currentForward.images, ...quotedForward.images], maxImages),
    images,
    media,
    videos: media.filter(asset => asset.type === "video"),
    records: media.filter(asset => asset.type === "record"),
    files: media.filter(asset => asset.type === "file"),
    currentForwardText: currentForward.text,
    quotedForwardText: quotedForward.text,
    forwardNodes: currentForward.forwardNodes,
    quotedForwardNodes: quotedForward.forwardNodes,
    forwardText: compactText([currentForward.text, quotedForward.text].filter(Boolean).join("\n"), 8000)
  }
}

export function formatGroupContextImagePrompt(assets:MediaAsset[] = []) {
  if (!Array.isArray(assets) || !assets.length) return ""
  return [
    "群内图片素材来源（顺序必须保留）：",
    ...assets.map(asset => `第${asset.position}张：${asset.label || asset.origin || "群内图片"}`),
    "用户说“这张/他的/转发里的第几张”时，必须按上述来源和顺序消解指代；不要把群友头像或转发图片认成当前发言者本人。"
  ].join("\n")
}
