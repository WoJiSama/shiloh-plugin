import {smartConversationKey} from '../domain/conversationIdentity.js'
export interface MutedEvent {group_id?:string|number;self_id?:string|number;bot?:{uin?:string|number};group?:{isAllShutup?:boolean;mute_left?:number;info?:{shutup_time_whole?:number;shutup_time_me?:number;group_all_shut?:number;shut_up_timestamp_whole?:number};shutup_time_whole?:number;shutup_time_me?:number;group_all_shut?:number;shut_up_timestamp_whole?:number;pickMember?(id:string|number|undefined):{getInfo?():Promise<{shutup_time?:number;shut_up_timestamp?:number}>}}}
export const MUTED_CACHE_TTL_MS=30000
export function createMutedGroupPolicy(bot:()=>{uin?:string|number}) {
const mutedStatusCache=new Map<string|number,{isMuted:boolean;at:number}>()
async function isMutedInGroup(e:MutedEvent) {
    if (!e?.group_id) return false
    const cached = mutedStatusCache.get(smartConversationKey(e.group_id,e))
    if (cached && Date.now() - cached.at < MUTED_CACHE_TTL_MS) return cached.isMuted

    const nowSec = Math.floor(Date.now() / 1000)
    let isMuted = false
    try {
      const grp = e.group
      if (grp) {
        // ICQQ 风格：剩余秒数 / GroupInfo 字段
        if (Number(grp.mute_left) > 0) isMuted = true
        else {
          const gi = grp.info || grp
          if (Number(gi?.shutup_time_whole) > 0) isMuted = true
          else if (Number(gi?.shutup_time_me) > 0) isMuted = true
          // OneBot v11 / Napcat 风格全员禁言字段（不同实现可能用不同名）
          else if (Number(gi?.group_all_shut) > 0) isMuted = true
          else if (Number(gi?.shut_up_timestamp_whole) > nowSec) isMuted = true
        }
      }
      // 个人禁言：拉自己的 member 信息（昂贵的 RPC，仅在群信息没显示已禁言时调）
      if (!isMuted) {
        const selfId = e.self_id || e.bot?.uin || bot().uin
        const me = await e.group?.pickMember?.(selfId)?.getInfo?.()
        if (me) {
          if (Number(me.shutup_time) > 0) isMuted = true
          else if (Number(me.shut_up_timestamp) > nowSec) isMuted = true
        }
      }
    } catch {}

    mutedStatusCache.set(smartConversationKey(e.group_id,e), { isMuted, at: Date.now() })
    return isMuted
  }
return {isMutedInGroup,mutedStatusCache}
}
