// 委托记忆 redis 存储:每群一条 JSON 数组键(get/set 整体读写,与 simSessionStore memories 同型)。
import type {DelegatedMemoryEntry,DelegatedMemoryPorts} from '../../../contracts/delegatedMemory.js'
import {normalizeDelegatedEntries} from '../domain/delegatedMemory.js'

const KEY_PREFIX='bl-chat:delegated:'

export function createDelegatedMemoryStore(ports:DelegatedMemoryPorts) {
  const key=(groupId:string)=>`${KEY_PREFIX}${groupId}`

  async function load(groupId:string):Promise<DelegatedMemoryEntry[]>{
    const raw=await ports.redis.get(key(String(groupId)))
    if(!raw)return []
    try{
      const parsed:unknown=JSON.parse(raw)
      return normalizeDelegatedEntries(Array.isArray(parsed)?parsed:[],ports.now?ports.now():Date.now())
    }catch{
      ports.logger.warn(`[委托记忆] 群 ${groupId} 数据损坏，按空处理`)
      return []
    }
  }

  async function save(groupId:string,entries:DelegatedMemoryEntry[]):Promise<void>{
    await ports.redis.set(key(String(groupId)),JSON.stringify(entries))
  }

  return {load,save}
}
