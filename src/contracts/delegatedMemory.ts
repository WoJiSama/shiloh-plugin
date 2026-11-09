// 委托记忆——群友托付机器人"帮我记住"的事。owner 维度、原文锚定(存原话不存模型重构,
// 防止"你上周明明说过X"式煤气灯)、可查可删(被托付人的数据归被托付人)。
export interface DelegatedMemoryEntry {
  id:string
  owner:string
  ownerName:string
  content:string            // 用户原话或忠实转述(含时间语境),不润色
  dueAt:number              // 可选时间锚(0=无):到期随仿真唤醒自然提起
  status:'active'|'done'
  createdAt:number
  updatedAt:number
}
export interface DelegatedMemoryConfigSection { maxPerGroup?:number; maxPerOwner?:number }
export interface DelegatedMemoryRedisLike {
  get(key:string):Promise<string|null>
  set(key:string,value:string):Promise<unknown>
}
export interface DelegatedMemoryPorts {
  redis:DelegatedMemoryRedisLike
  logger:{info(message:string):void;warn(message:string):void;error(message:string,error?:unknown):void}
  loadConfig():DelegatedMemoryConfigSection
  now?():number
}
