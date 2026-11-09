// 承诺账本——群友托付给机器人的定时/循环事务("每天中午12点发三角洲今日密码")。
// 与 reminderTool 的分工:reminder 是一次性静态提醒;承诺存自然语言意图,到期唤醒
// agent 用工具面自主兑现(仿真群)或直发固定文案(任意群),daily 自动顺延。
export interface CommitmentScheduleOnce { kind:'once'; time:number }
export interface CommitmentScheduleDaily { kind:'daily'; time:string }
export type CommitmentSchedule = CommitmentScheduleOnce | CommitmentScheduleDaily
export type CommitmentStatus = 'active'|'completed'|'failed'|'expired'
export interface CommitmentData {
  id:string
  group_id:string
  creator_id:string
  creator_name:string
  intent:string                    // 用户原话(含时间语境),不预编译参数——30天后 API 变了 agent 仍能重新规划
  schedule:CommitmentSchedule
  deliver:'agent'|'static'         // agent=到点唤醒仿真 agent 用工具完成;static=直发固定文案
  static_message:string|null
  expiry_at:number                 // 到期不再执行(默认30天,防遗忘永动机)
  renewal_asked_at?:number         // 到期前问询续约的时间(0/缺省=未问过;只问一次,不追问)
  next_run_at:number
  status:CommitmentStatus
  last_run_at:number
  last_result:string
  retry_count:number
  created_at:number
  bot_id:string
}
export interface CommitmentConfigSection { maxActivePerGroup?:number; maxPerCreator?:number; defaultExpiryDays?:number }
export interface CommitmentRedisLike {
  get(key:string):Promise<string|null>
  set(key:string,value:string,options?:{EX?:number;PX?:number;NX?:boolean}):Promise<unknown>
  del(key:string):Promise<unknown>
  eval(script:string,options:{keys:string[];arguments:string[]}):Promise<unknown>
}
export interface CommitmentBotLike { uin?:string|number; sendApi?:(action:string,params:Record<string,unknown>)=>Promise<unknown> }
export interface CommitmentEvent {
  group_id?:string|number|undefined
  user_id?:string|number|undefined
  isMaster?:boolean|undefined
  sender?:{nickname?:string|undefined;card?:string|undefined}|undefined
}
export interface CommitmentPorts {
  redis:CommitmentRedisLike
  logger:{info(message:string):void;warn(message:string):void;error(message:string,error?:unknown):void}
  getBot(id?:string):CommitmentBotLike|null
  isSimulationGroup(groupId:string):Promise<boolean>|boolean
  wakeSim(groupId:string,card:string):Promise<void>|void
  loadConfig():CommitmentConfigSection
  now?():number
}
