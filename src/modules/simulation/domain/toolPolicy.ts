// 仿真工具能力策略(纯函数):P1-3 白名单翻转——默认放通全量内置安全工具,按需做减法。
// 方向依据:能力面白名单制让 agent 拿着全量 registry 却不敢用(RULES.md 红线 2 同步改写)。
// 敏感工具(花钱/管人/改身份/出机隐私/与承诺账本重叠)默认禁,要开必须显式 allowTools 并写明原因。
import type {SimToolPolicyConfig} from '../../../contracts/simulation.js'

/** 默认禁的敏感工具:花钱 / 管人权限 / 改身份 / 出机隐私 / 与承诺账本功能重叠 */
export const RESTRICTED_SIM_TOOLS:readonly string[]=[
  'jinyanTool',        // 禁言:管人权限,误伤真实成员
  'recallTool',        // 撤回他人消息:管人权限
  'sendGiftTool',      // 送礼物:花钱
  'grabRedBagTool',    // 抢红包:钱相关
  'qqZoneTool',        // QQ空间:隐私出机,另有 qzone.enabled 独立闸
  'changeCardTool',    // 改群名片:动身份展示
  'mentionAdminsTool', // @全体管理员:批量打扰
  'reminderTool',      // 一次性提醒:承诺账本 once 已覆盖,防双轨
]

function normalizeNames(raw:unknown):string[] {
  const list=Array.isArray(raw)?raw:[]
  return [...new Set(list.map(n=>String(n||'').trim()).filter(Boolean))]
}

function normalizeGroupDeny(raw:unknown):Record<string,string[]> {
  const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{}
  const out:Record<string,string[]>={}
  for(const[key,value]of Object.entries(source)){
    if(!/^\d{5,12}$/.test(key))continue
    const names=normalizeNames(value)
    if(names.length)out[key]=names
  }
  return out
}

export function normalizeSimToolPolicy(raw:unknown):SimToolPolicyConfig {
  const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{}
  return {
    mode:source.mode==='legacy'?'legacy':'open',
    allowTools:normalizeNames(source.allowTools),
    denyTools:normalizeNames(source.denyTools),
    groups:normalizeGroupDeny(source.groups),
  }
}

/**
 * 解析某群实际放通的既有工具名清单(不含 sim* 工具,那些永远全量)。
 * - legacy:维持 P0 及之前的 extraTools 白名单行为,可一键回退;
 * - open:内置注册表工具默认全量 − RESTRICTED 默认禁 − 全局/按群减法 + 显式放行;
 *   extraTools 在两种模式下都保持追加(自定义工具与六件套不受模式切换影响)。
 * 未知名(注册表里没有的)交给上层按实例解析时自然丢弃,这里不猜。
 */
export function resolveSimToolSurface(input:{
  policy:SimToolPolicyConfig
  builtInNames:string[]
  extraTools:string[]
  groupId:string
}):string[] {
  const {policy,groupId}=input
  const extra=normalizeNames(input.extraTools)
  if(policy.mode==='legacy')return extra
  const deny=new Set([...policy.denyTools,...(policy.groups[String(groupId)]||[])])
  const allow=new Set(policy.allowTools)
  const surface=input.builtInNames.filter(name=>!deny.has(name)&&(allow.has(name)||!RESTRICTED_SIM_TOOLS.includes(name)))
  for(const name of [...allow,...extra])if(!deny.has(name)&&!surface.includes(name))surface.push(name)
  return surface
}
