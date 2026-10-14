import {extractDeliveryMessageId} from '../../messaging/domain/deliveryObservability.js'
import {safeTruncateUnicode,splitUnicodeText} from '../../models/domain/unicodeText.js'
interface Fact {text:string;tags?:string[];confidence?:number;authority?:string;eventAt?:unknown}
interface MemoryReplyHost<Event> {memoryAuthoritySource(authority?:string):string;formatMemoryFactLines(facts:Fact[]):string[];sendObservedReply(event:Event,payload:unknown):Promise<unknown>}
export function createMemoryReplies<Event>(ports:{factShortId(text:string):string;makeForwardMsg(event:Event,messages:string[],title:string):Promise<unknown>;warn(...args:unknown[]):void}) {

function formatMemoryFactLines(host:Pick<MemoryReplyHost<Event>,"memoryAuthoritySource">,facts:Fact[] = []) {
    return (Array.isArray(facts) ? facts : []).map(fact => {
      const shortId = ports.factShortId(fact.text)
      const category = (Array.isArray(fact.tags) && fact.tags[0]) || "未分类"
      const confidence = Number(fact.confidence ?? 0).toFixed(2)
      const source = host.memoryAuthoritySource(fact.authority)
      const pending = fact.eventAt ? " (待回扣)" : ""
      return `ID:${shortId} [${category}] ${fact.text}（来源:${source}，置信度:${confidence}）${pending}`
    })
  }

function formatMemoryFacts(host:Pick<MemoryReplyHost<Event>,"formatMemoryFactLines">,title:string,facts:Fact[] = []) {
    if (!facts.length) return `${title}\n暂无记忆`
    const lines = host.formatMemoryFactLines(facts)
    return `${title}\n${lines.join("\n")}\n\n删除单条记忆可发送：#删除记忆 my:<id>（删自己事实）或 #删除记忆 alias:<别名> / #删除记忆 fact:<群事实前缀>`.slice(0, 4500)
  }

async function replyMemoryForward(host:MemoryReplyHost<Event>,e:Event,title:string,sections:{title:string;facts?:Fact[]}[] = []) {
    const msgs = []
    for (const section of sections) {
      const facts = section.facts || []
      if (!facts.length) {
        msgs.push(`${section.title}\n暂无记忆`)
        continue
      }

      const lines = host.formatMemoryFactLines(facts)
      for (let i = 0; i < lines.length; i += 12) {
        const page = Math.floor(i / 12) + 1
        const total = Math.ceil(lines.length / 12)
        const header = total > 1 ? `${section.title} (${page}/${total})` : section.title
        msgs.push(`${header}\n${lines.slice(i, i + 12).join("\n")}`)
      }
    }

    msgs.push("删除单条记忆可发送：#删除记忆 my:<id>（删自己事实）或 #删除记忆 alias:<别名> / #删除记忆 fact:<群事实前缀>")

    let deliveryAttempted = false
    try {
      for(let offset=0;offset<msgs.length;offset+=100){
        const forwardMsg=await ports.makeForwardMsg(e,msgs.slice(offset,offset+100),title)
        deliveryAttempted=true
        const receipt=await host.sendObservedReply(e,forwardMsg)
        if(extractDeliveryMessageId(receipt) === null) {ports.warn('[消息发送] 转发无确认回执，停止后续批次');return}
      }
    } catch (error) {
      if(deliveryAttempted) { ports.warn("[消息发送] 转发投递结果未知，停止重发",error); return }
      ports.warn("[记忆管理] 转发消息发送失败，回退为普通文本:", error)
      await host.sendObservedReply(e, safeTruncateUnicode(msgs.join("\n\n"), 4500))
    }
  }

async function replyLongForward(host:Pick<MemoryReplyHost<Event>,"sendObservedReply">,e:Event,title:string,text:string,pageSize = 3000) {
    const content = String(text || "")
    const msgs = splitUnicodeText(content, pageSize)
    if (!msgs.length) msgs.push("暂无内容")

    let deliveryAttempted = false
    try {
      for(let offset=0;offset<msgs.length;offset+=100){
        const forwardMsg=await ports.makeForwardMsg(e,msgs.slice(offset,offset+100),title)
        deliveryAttempted=true
        const receipt=await host.sendObservedReply(e,forwardMsg)
        if(extractDeliveryMessageId(receipt) === null) {ports.warn('[消息发送] 转发无确认回执，停止后续批次');return}
      }
    } catch (error) {
      if(deliveryAttempted) { ports.warn("[消息发送] 转发投递结果未知，停止重发",error); return }
      ports.warn("[消息发送] 转发消息发送失败，回退为普通文本:", error)
      await host.sendObservedReply(e, safeTruncateUnicode(content, 4500) || "暂无内容")
    }
  }
return {formatMemoryFactLines,formatMemoryFacts,replyMemoryForward,replyLongForward}
}
