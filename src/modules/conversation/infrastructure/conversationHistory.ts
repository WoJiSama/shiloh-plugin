import fs from 'node:fs'
import path from 'node:path'
import {normalizeForwardMessageList,normalizeMessageSegments,extractReadableTextFromSegments,getForwardSenderName,extractForwardIdsFromSegments} from '../domain/messageSegments.js'
import {compactDrawPromptText} from '../domain/textPolicy.js'
export interface HistoryMessage {role?:string;content?:unknown}
export interface Group {getForwardMsg?(id:string):Promise<unknown>}
export interface ForwardState {lines?:string[];visited?:Set<string>;depth?:number;maxDepth?:number;maxLines?:number}
export interface HistoryHost {messageHistoriesRedisKey:string;messageHistoriesDir:string;MAX_HISTORY:number;clearGroupUserMessages(groupId:string|number,userId:string|number):Promise<void>;saveGroupUserMessages(groupId:string|number,userId:string|number,messages:HistoryMessage[]):Promise<void>;collectForwardPromptLines(group:Group|undefined,forwardId:unknown,state?:ForwardState):Promise<string[]>}
function parseHistory(value:unknown):HistoryMessage[] {return Array.isArray(value)?value.filter((v):v is HistoryMessage=>Boolean(v&&typeof v==='object'&&typeof v.role==='string'&&'content' in v)):[]}
export function createConversationHistory(ports:{loadData(key:string,fallback:null):Promise<unknown>;saveData(key:string,file:string,value:HistoryMessage[]):Promise<unknown>;deleteKey(key:string):Promise<unknown>;debug(message:string):void;error(message:string,error:unknown):void}) {
const {loadData,saveData}=ports
const FORWARD_CONTEXT_MAX_DEPTH=4,FORWARD_CONTEXT_MAX_LINES=120,FORWARD_CONTEXT_MAX_TEXT=9000
async function getGroupUserMessages(host:HistoryHost,groupId:string|number, userId:string|number) {
    const redisKey = `${host.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(host.messageHistoriesDir, `${groupId}_${userId}.json`)

    try {
      const redisData = await loadData(redisKey, null)
      if (Array.isArray(redisData) && redisData.length) return parseHistory(redisData)

      const fileData = await fs.promises.readFile(filePath, "utf-8").catch(() => null)
      if (fileData) {
        const parsed = parseHistory(JSON.parse(fileData))
        await saveData(redisKey, filePath, parsed)
        return parsed
      }
      return []
    } catch (error) {
      ports.error(`获取消息历史失败:`, error)
      return []
    }
  }
async function saveGroupUserMessages(host:HistoryHost,groupId:string|number, userId:string|number, messages:HistoryMessage[]) {
    const redisKey = `${host.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(host.messageHistoriesDir, `${groupId}_${userId}.json`)
    await fs.promises.mkdir(host.messageHistoriesDir,{recursive:true})
    await Promise.all([
      saveData(redisKey, filePath, messages),
      fs.promises.writeFile(filePath, JSON.stringify(messages, null, 2), "utf-8")
    ]).catch(err => ports.error(`保存消息历史失败:`, err))
  }
async function clearGroupUserMessages(host:HistoryHost,groupId:string|number, userId:string|number) {
    const redisKey = `${host.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(host.messageHistoriesDir, `${groupId}_${userId}.json`)
    await Promise.all([
      ports.deleteKey(redisKey),
      fs.promises.unlink(filePath).catch(() => { })
    ])
  }
async function resetGroupUserMessages(host:HistoryHost,groupId:string|number, userId:string|number) {
    await host.clearGroupUserMessages(groupId, userId)
    await host.saveGroupUserMessages(groupId, userId, [])
  }
async function collectForwardPromptLines(host:HistoryHost,group:Group|undefined, forwardId:unknown, state:ForwardState = {}) {
    const id = String(forwardId || "").trim()
    if (!group?.getForwardMsg || !id) return state.lines || []

    const lines = state.lines || []
    const visited = state.visited || new Set()
    const depth = Number(state.depth) || 0
    const maxDepth = Number(state.maxDepth) || FORWARD_CONTEXT_MAX_DEPTH
    const maxLines = Number(state.maxLines) || FORWARD_CONTEXT_MAX_LINES
    if (depth >= maxDepth || lines.length >= maxLines) return lines
    if (visited.has(id)) {
      lines.push(`${"  ".repeat(depth)}[嵌套转发记录重复，已跳过]`)
      return lines
    }

    visited.add(id)
    let forwardMsgs = []
    try {
      forwardMsgs = normalizeForwardMessageList(await group.getForwardMsg(id))
    } catch (err) {
      ports.debug(`[获取转发记录失败] id=${id} ${err}`)
      return lines
    }

    const indent = "  ".repeat(depth)
    for (const raw of forwardMsgs) {
      const fMsg=raw && typeof raw === "object" ? raw as Record<string,unknown> : {}
      if (lines.length >= maxLines) break
      const segments = normalizeMessageSegments(fMsg)
      const text = extractReadableTextFromSegments(segments, String(fMsg.raw_message || fMsg.message_text || fMsg.content_text || ""))
      const name = getForwardSenderName(fMsg)
      if (text) lines.push(`${indent}${name}: ${text}`)

      const nestedForwardIds = extractForwardIdsFromSegments(segments)
      for (const nestedId of nestedForwardIds) {
        if (lines.length >= maxLines) break
        lines.push(`${indent}${name}: [嵌套转发记录]`)
        await host.collectForwardPromptLines(group, nestedId, {
          lines,
          visited,
          depth: depth + 1,
          maxDepth,
          maxLines
        })
      }
    }

    return lines
  }
async function resolveForwardPromptFromSegments(host:HistoryHost,segments:unknown[] = [], group?:Group) {
    const forwardIds = extractForwardIdsFromSegments(segments)
    if (!forwardIds.length || !group?.getForwardMsg) return ""

    const lines:string[] = []
    const visited = new Set<string>()
    for (const forwardId of forwardIds) {
      if (lines.length >= FORWARD_CONTEXT_MAX_LINES) break
      await host.collectForwardPromptLines(group, forwardId, {
        lines,
        visited,
        depth: 0,
        maxDepth: FORWARD_CONTEXT_MAX_DEPTH,
        maxLines: FORWARD_CONTEXT_MAX_LINES
      })
    }

    return compactDrawPromptText(lines.join("\n"), FORWARD_CONTEXT_MAX_TEXT)
  }
function filterChatByQQ<T extends HistoryMessage>(host:HistoryHost,chatArray:T[], qqNumber:unknown):T[] {
    const pattern = /\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/
    const lastIndex = chatArray.reduce((last, curr, i) =>
      typeof curr.content === "string" && curr.content.includes(`(qq号: ${qqNumber})`) && pattern.test(String(curr.content)) ? i : last, -1)
    return lastIndex === -1 ? chatArray : chatArray.slice(0, lastIndex + 1)
  }
function trimMessageHistory<T extends HistoryMessage>(host:HistoryHost,messages:T[]):T[] {
    const nonSystem = messages.filter(m => m.role !== "system")
    if (nonSystem.length <= host.MAX_HISTORY) return messages

    const system = messages.filter(m => m.role === "system")
    return [...system, ...nonSystem.slice(-host.MAX_HISTORY)]
  }
return {getGroupUserMessages,saveGroupUserMessages,clearGroupUserMessages,resetGroupUserMessages,collectForwardPromptLines,resolveForwardPromptFromSegments,filterChatByQQ,trimMessageHistory}
}
