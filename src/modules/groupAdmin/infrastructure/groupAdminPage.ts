import fs from "fs"
import path from "path"
import type {Browser} from "puppeteer"
import {adminRecord,adminError} from "../../../contracts/groupAdmin.js"
import type {AdminEvent,GroupAdminLogger} from "../../../contracts/groupAdmin.js"
import {resolveGroupAdminSettings,groupAdminOverrides,groupAdminRowId} from "../domain/groupAdminPolicy.js"
import {normalizeGroupModerationConfig} from "../domain/groupModerationRules.js"
import {normalizeGroupGuardConfig} from "./GroupGuardManager.js"
import {normalizeGroupNoticeConfig} from "./GroupNoticeManager.js"
import type {GroupModerationManager} from "./GroupModerationManager.js"

type Data = Record<string, unknown>
const enabledInGroups = (source:unknown, id:string) => {
  const groups = adminRecord(source).enabledGroups
  return Array.isArray(groups) && groups.map(String).includes(id)
}

// ---------- 命令表：功能开关与规则设置 ----------

interface ToggleFeature {names:string[];module:string;path:string;label:string}
interface SetRule {names:string[];module:string;path:string;label:string;kind:"number"|"boolean"|"text";min?:number;max?:number;decimal?:boolean;textMax?:number}

const TOGGLE_FEATURES:ToggleFeature[] = [
  {names:["广告检测","广告扫描","广告与刷屏检测","风控检测"],module:"groupModeration",path:"adScan.enabled",label:"广告与刷屏检测"},
  {names:["刷屏检测","刷屏"],module:"groupModeration",path:"floodEnabled",label:"刷屏检测"},
  {names:["超长折叠","超长消息折叠","长消息折叠"],module:"groupModeration",path:"overlongMessage.enabled",label:"超长消息折叠"},
  {names:["连发折叠","连发消息折叠","刷屏折叠"],module:"groupModeration",path:"burstMessage.enabled",label:"连发消息折叠"},
  {names:["自动撤回","允许撤回"],module:"groupModeration",path:"actions.recallEnabled",label:"广告自动撤回"},
  {names:["自动禁言","允许禁言"],module:"groupModeration",path:"actions.muteEnabled",label:"广告自动禁言"},
  {names:["自动踢出","允许踢出"],module:"groupModeration",path:"actions.kickEnabled",label:"广告自动踢出"},
  {names:["低活跃检测","只测低活跃"],module:"groupModeration",path:"inspectLowLevelOnly",label:"只检测低活跃成员"},
  {names:["入群验证","入群审核","进群验证"],module:"groupGuard",path:"enabled",label:"入群验证"},
  {names:["超时踢出"],module:"groupGuard",path:"kickOnTimeout",label:"验证超时踢出"},
  {names:["答错踢出"],module:"groupGuard",path:"kickOnWrongAnswer",label:"验证答错踢出"},
  {names:["群通知","欢迎退群","退群通知"],module:"groupNotice",path:"enabled",label:"群通知"},
  {names:["欢迎通知","入群欢迎"],module:"groupNotice",path:"welcomeEnabled",label:"入群欢迎"},
  {names:["退群提示"],module:"groupNotice",path:"leaveEnabled",label:"退群提示"},
  {names:["广告与刷屏","群管模块"],module:"groupModeration",path:"enabled",label:"广告与刷屏模块"}
]

const SET_RULES:SetRule[] = [
  {names:["超长字数","超长判定字数"],module:"groupModeration",path:"overlongMessage.maxLength",label:"超长判定字数",kind:"number",min:100,max:20000},
  {names:["连发条数","连发条数上限"],module:"groupModeration",path:"burstMessage.maxMessages",label:"连发条数上限",kind:"number",min:3,max:100},
  {names:["连发窗口","连发时间窗","连发秒数"],module:"groupModeration",path:"burstMessage.windowSeconds",label:"连发时间窗(秒)",kind:"number",min:2,max:600},
  {names:["禁言秒数","禁言时长"],module:"groupModeration",path:"burstMessage.muteSeconds",label:"连发禁言秒数",kind:"number",min:0,max:2592000},
  {names:["超长转发"],module:"groupModeration",path:"overlongMessage.forwardEnabled",label:"超长折叠后转发",kind:"boolean"},
  {names:["连发转发"],module:"groupModeration",path:"burstMessage.forwardEnabled",label:"连发折叠后转发",kind:"boolean"},
  {names:["刷屏条数","刷屏条数上限"],module:"groupModeration",path:"floodMaxMessages",label:"刷屏条数上限",kind:"number",min:3,max:100},
  {names:["刷屏窗口","刷屏时间窗","刷屏秒数"],module:"groupModeration",path:"floodWindowSeconds",label:"刷屏时间窗(秒)",kind:"number",min:3,max:600},
  {names:["刷屏等级","刷屏检测等级"],module:"groupModeration",path:"floodMaxLevel",label:"刷屏检测等级上限",kind:"number",min:0,max:100},
  {names:["等级阈值","低活跃等级"],module:"groupModeration",path:"minActiveLevel",label:"低活跃等级阈值",kind:"number",min:0,max:100},
  {names:["广告禁言秒数","广告禁言时长"],module:"groupModeration",path:"actions.muteSeconds",label:"广告禁言秒数",kind:"number",min:60,max:2592000},
  {names:["提醒阈值"],module:"groupModeration",path:"thresholds.report",label:"提醒阈值",kind:"number",min:0,max:1,decimal:true},
  {names:["撤回阈值"],module:"groupModeration",path:"thresholds.recall",label:"撤回阈值",kind:"number",min:0,max:1,decimal:true},
  {names:["禁言阈值"],module:"groupModeration",path:"thresholds.mute",label:"禁言阈值",kind:"number",min:0,max:1,decimal:true},
  {names:["踢出阈值"],module:"groupModeration",path:"thresholds.kick",label:"踢出阈值",kind:"number",min:0,max:1,decimal:true},
  {names:["题目范围","数字范围"],module:"groupGuard",path:"questionMaxNumber",label:"题目数字范围",kind:"number",min:1,max:100},
  {names:["答题超时","验证超时"],module:"groupGuard",path:"timeoutSeconds",label:"答题超时(秒)",kind:"number",min:30,max:3600},
  {names:["错误次数","允许错误"],module:"groupGuard",path:"maxWrongTimes",label:"允许答错次数",kind:"number",min:1,max:5},
  {names:["欢迎语","欢迎文案"],module:"groupNotice",path:"welcomeMessage",label:"欢迎文案",kind:"text",textMax:200},
  {names:["退群语","退群文案"],module:"groupNotice",path:"leaveMessage",label:"退群文案",kind:"text",textMax:200}
]

const TRUE_WORDS = new Set(["开","开启","打开","true","on","yes","是"])
const FALSE_WORDS = new Set(["关","关闭","关掉","false","off","no","否"])

// ---------- 功能注册表：.群管 <功能> [开|关|参数 值...] ----------

interface FeatureParam {names:string[];path:string;label:string;kind:"number"|"boolean";min?:number;max?:number;decimal?:boolean;help:string}
interface FeatureTextParam {names:string[];path:string;label:string;max:number;help:string}
export interface FeatureDef {
  names:string[]
  module:string
  label:string
  togglePath?:string
  params:FeatureParam[]
  textParams:FeatureTextParam[]
}

export const FEATURE_DEFS:FeatureDef[] = [
  {
    names:["广告检测","广告扫描","广告与刷屏检测","风控"],
    module:"groupModeration",
    label:"广告与刷屏检测",
    togglePath:"adScan.enabled",
    params:[
      {names:["等级"],path:"minActiveLevel",label:"低活跃等级阈值",kind:"number",min:0,max:100,help:"只检测活跃等级≤该值的成员"},
      {names:["低活跃"],path:"inspectLowLevelOnly",label:"只检测低活跃",kind:"boolean",help:"开=只检测低活跃成员，关=检测全员"},
      {names:["自动撤回"],path:"actions.recallEnabled",label:"自动撤回",kind:"boolean",help:"达到撤回阈值自动撤回"},
      {names:["自动禁言"],path:"actions.muteEnabled",label:"自动禁言",kind:"boolean",help:"达到禁言阈值自动禁言"},
      {names:["自动踢出"],path:"actions.kickEnabled",label:"自动踢出",kind:"boolean",help:"达到踢出阈值自动踢出"},
      {names:["禁言秒数"],path:"actions.muteSeconds",label:"广告禁言秒数",kind:"number",min:60,max:2592000,help:"广告禁言时长"},
      {names:["提醒阈值"],path:"thresholds.report",label:"提醒阈值",kind:"number",min:0,max:1,decimal:true,help:"0-1，越低越敏感"},
      {names:["撤回阈值"],path:"thresholds.recall",label:"撤回阈值",kind:"number",min:0,max:1,decimal:true,help:"0-1"},
      {names:["禁言阈值"],path:"thresholds.mute",label:"禁言阈值",kind:"number",min:0,max:1,decimal:true,help:"0-1"},
      {names:["踢出阈值"],path:"thresholds.kick",label:"踢出阈值",kind:"number",min:0,max:1,decimal:true,help:"0-1"}
    ],
    textParams:[]
  },
  {
    names:["刷屏检测","刷屏"],
    module:"groupModeration",
    label:"刷屏检测",
    togglePath:"floodEnabled",
    params:[
      {names:["条数"],path:"floodMaxMessages",label:"刷屏条数上限",kind:"number",min:3,max:100,help:"时间窗内发满该条数即命中"},
      {names:["窗口"],path:"floodWindowSeconds",label:"刷屏时间窗(秒)",kind:"number",min:3,max:600,help:"滑动窗口长度"},
      {names:["等级"],path:"floodMaxLevel",label:"刷屏检测等级上限",kind:"number",min:0,max:100,help:"只检测等级≤该值的成员"}
    ],
    textParams:[]
  },
  {
    names:["超长折叠","超长消息折叠","长消息折叠"],
    module:"groupModeration",
    label:"超长消息折叠",
    togglePath:"overlongMessage.enabled",
    params:[
      {names:["字数"],path:"overlongMessage.maxLength",label:"超长判定字数",kind:"number",min:100,max:20000,help:"单条超过该字数即折叠"},
      {names:["转发"],path:"overlongMessage.forwardEnabled",label:"折叠后转发",kind:"boolean",help:"开=撤回后转成聊天记录"}
    ],
    textParams:[]
  },
  {
    names:["连发折叠","连发消息折叠","刷屏折叠"],
    module:"groupModeration",
    label:"连发消息折叠",
    togglePath:"burstMessage.enabled",
    params:[
      {names:["条数"],path:"burstMessage.maxMessages",label:"连发条数上限",kind:"number",min:3,max:100,help:"窗口内发满该条数即折叠"},
      {names:["窗口"],path:"burstMessage.windowSeconds",label:"连发时间窗(秒)",kind:"number",min:2,max:600,help:"滑动窗口长度"},
      {names:["禁言"],path:"burstMessage.muteSeconds",label:"禁言秒数",kind:"number",min:0,max:2592000,help:"0=只折叠不禁言"},
      {names:["转发"],path:"burstMessage.forwardEnabled",label:"折叠后转发",kind:"boolean",help:"开=整批转成聊天记录"}
    ],
    textParams:[]
  },
  {
    names:["入群验证","入群审核","进群验证"],
    module:"groupGuard",
    label:"入群验证",
    togglePath:"enabled",
    params:[
      {names:["超时"],path:"timeoutSeconds",label:"答题超时(秒)",kind:"number",min:30,max:3600,help:"须在该时间内答对"},
      {names:["范围"],path:"questionMaxNumber",label:"题目数字范围",kind:"number",min:1,max:100,help:"0 到该数字的加减法"},
      {names:["错误"],path:"maxWrongTimes",label:"允许答错次数",kind:"number",min:1,max:5,help:"答错次数用尽后按踢出设置处理"},
      {names:["超时踢出"],path:"kickOnTimeout",label:"超时踢出",kind:"boolean",help:"开=超时移出群聊"},
      {names:["答错踢出"],path:"kickOnWrongAnswer",label:"答错踢出",kind:"boolean",help:"开=答错次数用尽移出群聊"}
    ],
    textParams:[]
  },
  {
    names:["群通知","欢迎退群"],
    module:"groupNotice",
    label:"群通知",
    togglePath:"enabled",
    params:[
      {names:["欢迎"],path:"welcomeEnabled",label:"入群欢迎",kind:"boolean",help:"开=入群时发送欢迎文案"},
      {names:["退群"],path:"leaveEnabled",label:"退群提示",kind:"boolean",help:"开=退群时发送提示文案"}
    ],
    textParams:[
      {names:["欢迎语"],path:"welcomeMessage",label:"欢迎文案",max:200,help:"支持变量 {at}"},
      {names:["退群语"],path:"leaveMessage",label:"退群文案",max:200,help:"支持变量 {userId}"}
    ]
  }
]

export interface FeatureChange {path:string;value:unknown}
export type GroupAdminCommand =
  | {ok:true;type:"view"}
  | {ok:true;type:"toggle";feature:ToggleFeature;enable:boolean}
  | {ok:true;type:"set";rule:SetRule;value:number|boolean|string}
  | {ok:true;type:"feature";feature:FeatureDef;action:"help"}
  | {ok:true;type:"feature";feature:FeatureDef;action:"toggle";enable:boolean}
  | {ok:true;type:"feature";feature:FeatureDef;action:"set";changes:FeatureChange[]}
  | {ok:false;type:"toggle"|"set"|"feature";message:string}

function findFeature(name:string) {
  return FEATURE_DEFS.find(item => item.names.includes(name))
}

function validateParamValue(param:FeatureParam, raw:string):{ok:true;value:number|boolean}|{ok:false;message:string} {
  if (param.kind === "boolean") {
    if (TRUE_WORDS.has(raw.toLowerCase())) return {ok:true,value:true}
    if (FALSE_WORDS.has(raw.toLowerCase())) return {ok:true,value:false}
    return {ok:false,message:`「${param.label}」只能填 开 或 关`}
  }
  if (!Number.isFinite(Number(raw))) return {ok:false,message:`「${param.label}」需要填${param.decimal ? "数字" : "整数"}`}
  const value = Number(raw)
  if (!param.decimal && !Number.isInteger(value)) return {ok:false,message:`「${param.label}」需要填整数`}
  if (value < (param.min ?? -Infinity) || value > (param.max ?? Infinity)) return {ok:false,message:`「${param.label}」需在 ${param.min} 到 ${param.max} 之间`}
  return {ok:true,value}
}

/** 解析 `.群管` 系列命令；非群管命令返回 null。功能语法：.群管 <功能> [开|关|参数 值...] */
export function parseGroupAdminCommand(msg:unknown):GroupAdminCommand|null {
  const text = String(msg || "").trim()
  if (/^[#＃.。]\s*群管(?:页面|面板)?\s*$/.test(text)) return {ok:true,type:"view"}
  const head = text.match(/^[#＃.。]\s*群管\s+(\S+)(?:\s+([\s\S]+?))?\s*$/)
  if (!head) return null
  const name = head[1]!
  const rest = (head[2] || "").trim()
  if (!rest && ["页面","面板","帮助","help"].includes(name)) return {ok:true,type:"view"}

  // 功能语法
  const feature = findFeature(name)
  if (feature) {
    if (!rest) return {ok:true,type:"feature",feature,action:"help"}
    if (TRUE_WORDS.has(rest) || rest === "帮助" || rest === "help") {
      if (rest === "帮助" || rest === "help") return {ok:true,type:"feature",feature,action:"help"}
      if (!feature.togglePath) return {ok:false,type:"feature",message:`「${feature.label}」没有开关，只能调参数。发送 .群管 ${feature.names[0]} 查看用法`}
      return {ok:true,type:"feature",feature,action:"toggle",enable:TRUE_WORDS.has(rest)}
    }
    if (FALSE_WORDS.has(rest)) {
      if (!feature.togglePath) return {ok:false,type:"feature",message:`「${feature.label}」没有开关，只能调参数`}
      return {ok:true,type:"feature",feature,action:"toggle",enable:false}
    }
    // 参数序列：参数 值 [参数 值 ...]；文本参数取剩余整行
    const tokens = rest.split(/\s+/)
    const changes:FeatureChange[] = []
    let index = 0
    while (index < tokens.length) {
      const paramName = tokens[index]!
      const textParam = feature.textParams.find(item => item.names.includes(paramName))
      if (textParam) {
        const value = tokens.slice(index + 1).join(" ").replace(/\s+/g, " ").trim()
        if (!value) return {ok:false,type:"feature",message:`「${textParam.label}」内容不能为空，用法：.群管 ${feature.names[0]} ${textParam.names[0]} <内容>`}
        if ([...value].length > textParam.max) return {ok:false,type:"feature",message:`「${textParam.label}」最多 ${textParam.max} 字`}
        changes.push({path:textParam.path,value})
        index = tokens.length
        break
      }
      const param = feature.params.find(item => item.names.includes(paramName))
      if (!param) return {ok:false,type:"feature",message:`「${feature.label}」没有参数「${paramName}」。发送 .群管 ${feature.names[0]} 查看可用参数`}
      const raw = tokens[index + 1]
      if (raw === undefined) return {ok:false,type:"feature",message:`「${param.label}」缺少值，用法：.群管 ${feature.names[0]} ${param.names[0]} <值>`}
      const validated = validateParamValue(param, raw)
      if (!validated.ok) return {ok:false,type:"feature",message:validated.message}
      changes.push({path:param.path,value:validated.value})
      index += 2
    }
    if (!changes.length) return {ok:false,type:"feature",message:`没解析到任何参数。发送 .群管 ${feature.names[0]} 查看用法`}
    return {ok:true,type:"feature",feature,action:"set",changes}
  }

  // 兼容旧语法：开启/关闭 与 设置
  if (name === "开启" || name === "关闭") {
    const legacy = TOGGLE_FEATURES.find(item => item.names.includes(rest))
    if (!legacy) {
      if (findFeature(rest)) {
        const target = findFeature(rest)!
        return {ok:true,type:"feature",feature:target,action:"toggle",enable:name === "开启"}
      }
      return {ok:false,type:"toggle",message:`没有叫「${rest}」的功能。可开关：${TOGGLE_FEATURES.map(item => item.names[0]).join("、")}`}
    }
    return {ok:true,type:"toggle",feature:legacy,enable:name === "开启"}
  }
  if (name === "设置") {
    const setMatch = rest.match(/^(\S+)\s+([\s\S]+)$/)
    if (!setMatch) return {ok:false,type:"set",message:"设置需要参数和值，例如 .群管 设置 连发条数 8"}
    const rule = SET_RULES.find(item => item.names.includes(setMatch[1]!))
    if (!rule) return {ok:false,type:"set",message:`没有叫「${setMatch[1]}」的规则。可设置：${SET_RULES.map(item => item.names[0]).join("、")}`}
    const rawValue = setMatch[2]!.trim()
    if (rule.kind === "text") {
      const singleLine = rawValue.replace(/\s+/g, " ")
      if (!singleLine) return {ok:false,type:"set",message:`「${rule.label}」内容不能为空`}
      if ([...singleLine].length > (rule.textMax ?? 200)) return {ok:false,type:"set",message:`「${rule.label}」最多 ${rule.textMax ?? 200} 字`}
      return {ok:true,type:"set",rule,value:singleLine}
    }
    if (rule.kind === "boolean") {
      if (TRUE_WORDS.has(rawValue.toLowerCase())) return {ok:true,type:"set",rule,value:true}
      if (FALSE_WORDS.has(rawValue.toLowerCase())) return {ok:true,type:"set",rule,value:false}
      return {ok:false,type:"set",message:`「${rule.label}」只能填 开 或 关`}
    }
    if (/\s/.test(rawValue)) return {ok:false,type:"set",message:`「${rule.label}」只需填一个数字`}
    const value = Number(rawValue)
    if (!Number.isFinite(value)) return {ok:false,type:"set",message:`「${rule.label}」需要填${rule.decimal ? "数字" : "整数"}`}
    if (!rule.decimal && !Number.isInteger(value)) return {ok:false,type:"set",message:`「${rule.label}」需要填整数`}
    if (value < (rule.min ?? -Infinity) || value > (rule.max ?? Infinity)) return {ok:false,type:"set",message:`「${rule.label}」需在 ${rule.min} 到 ${rule.max} 之间`}
    return {ok:true,type:"set",rule,value}
  }

  return {ok:false,type:"feature",message:`没有叫「${name}」的功能。可用：${FEATURE_DEFS.map(item => item.names[0]).join("、")}；发送 .群管 查看面板`}
}

// ---------- 面板数据 ----------

export interface PageFeatureRow {label:string;on:boolean;detail:string;commands?:string[]}
export interface PageSection {label:string;enabled:boolean;masterOk:boolean;rows:PageFeatureRow[]}
export interface GroupAdminPageData {groupId:string;sections:PageSection[]}

export function buildGroupAdminPageData(settings:Data, groupId:unknown):GroupAdminPageData {
  const id = String(groupId || "")
  const resolved = resolveGroupAdminSettings(settings, id)
  const moderation = normalizeGroupModerationConfig(resolved.groupModeration)
  const guard = normalizeGroupGuardConfig(resolved.groupGuard)
  const notice = normalizeGroupNoticeConfig(resolved.groupNotice)
  const masterOk = (key:string) => adminRecord(settings[key]).enabled === true
  const on = (key:string) => enabledInGroups(resolved[key], id)
  const actionText = [
    moderation.actions.recallEnabled ? "撤回" : "",
    moderation.actions.muteEnabled ? `禁言${moderation.actions.muteSeconds}秒` : "",
    moderation.actions.kickEnabled ? "踢出" : ""
  ].filter(Boolean).join(" · ")
  return {
    groupId: id,
    sections: [
      {
        label: "广告与刷屏",
        enabled: on("groupModeration"),
        masterOk: masterOk("groupModeration"),
        rows: [
          {
            label: "广告与刷屏检测",
            on: moderation.adScan.enabled,
            detail: "广告/引流话术判定，命中按阈值处置",
            commands: [`.群管 广告检测 ${moderation.adScan.enabled ? "关" : "开"}`, ".群管 广告检测 帮助"]
          },
          {
            label: "刷屏检测",
            on: moderation.floodEnabled,
            detail: `${moderation.floodWindowSeconds} 秒内发满 ${moderation.floodMaxMessages} 条命中（检测等级≤${moderation.floodMaxLevel}）`,
            commands: [
              `.群管 刷屏检测 ${moderation.floodEnabled ? "关" : "开"}`,
              `.群管 刷屏检测 条数 ${moderation.floodMaxMessages}`,
              `.群管 刷屏检测 窗口 ${moderation.floodWindowSeconds}`,
              `.群管 刷屏检测 等级 ${moderation.floodMaxLevel}`
            ]
          },
          {
            label: "检测范围",
            on: true,
            detail: moderation.inspectLowLevelOnly ? `只检测活跃等级≤${moderation.minActiveLevel} 的成员` : "检测全部成员",
            commands: [
              `.群管 广告检测 低活跃 ${moderation.inspectLowLevelOnly ? "关" : "开"}`,
              `.群管 广告检测 等级 ${moderation.minActiveLevel}`
            ]
          },
          {
            label: "自动处置",
            on: moderation.actions.recallEnabled || moderation.actions.muteEnabled || moderation.actions.kickEnabled,
            detail: actionText ? `${actionText}（提醒${moderation.thresholds.report} / 撤回${moderation.thresholds.recall} / 禁言${moderation.thresholds.mute} / 踢出${moderation.thresholds.kick}）` : "全部关闭，仅提醒和私发证据",
            commands: [
              `.群管 广告检测 自动撤回 ${moderation.actions.recallEnabled ? "关" : "开"}`,
              `.群管 广告检测 自动禁言 ${moderation.actions.muteEnabled ? "关" : "开"}`,
              `.群管 广告检测 自动踢出 ${moderation.actions.kickEnabled ? "关" : "开"}`,
              `.群管 广告检测 禁言秒数 ${moderation.actions.muteSeconds}`
            ]
          },
          {
            label: "超长消息折叠",
            on: moderation.overlongMessage.enabled,
            detail: `单条超过 ${moderation.overlongMessage.maxLength} 字撤回并转聊天记录${moderation.overlongMessage.forwardEnabled ? "" : "（不转发）"}`,
            commands: [
              `.群管 超长折叠 ${moderation.overlongMessage.enabled ? "关" : "开"}`,
              `.群管 超长折叠 字数 ${moderation.overlongMessage.maxLength}`,
              `.群管 超长折叠 转发 ${moderation.overlongMessage.forwardEnabled ? "关" : "开"}`
            ]
          },
          {
            label: "连发消息折叠",
            on: moderation.burstMessage.enabled,
            detail: `${moderation.burstMessage.windowSeconds} 秒内连发 ${moderation.burstMessage.maxMessages} 条整批撤回转发`
              + (moderation.burstMessage.muteSeconds > 0 ? `，禁言 ${moderation.burstMessage.muteSeconds} 秒` : "（不禁言）"),
            commands: [
              `.群管 连发折叠 ${moderation.burstMessage.enabled ? "关" : "开"}`,
              `.群管 连发折叠 条数 ${moderation.burstMessage.maxMessages}`,
              `.群管 连发折叠 窗口 ${moderation.burstMessage.windowSeconds}`,
              `.群管 连发折叠 禁言 ${moderation.burstMessage.muteSeconds}`,
              `.群管 连发折叠 转发 ${moderation.burstMessage.forwardEnabled ? "关" : "开"}`
            ]
          }
        ]
      },
      {
        label: "入群验证",
        enabled: on("groupGuard"),
        masterOk: masterOk("groupGuard"),
        rows: [
          {
            label: "入群答题验证",
            on: on("groupGuard"),
            detail: `${guard.timeoutSeconds} 秒内答对 0-${guard.questionMaxNumber} 加减法，允许错 ${guard.maxWrongTimes} 次`,
            commands: [
              `.群管 入群验证 ${on("groupGuard") ? "关" : "开"}`,
              `.群管 入群验证 超时 ${guard.timeoutSeconds}`,
              `.群管 入群验证 范围 ${guard.questionMaxNumber}`,
              `.群管 入群验证 错误 ${guard.maxWrongTimes}`
            ]
          },
          {
            label: "超时踢出",
            on: guard.kickOnTimeout,
            detail: guard.kickOnTimeout ? "超时未答对即移出群聊" : "超时仅取消验证，不踢人",
            commands: [`.群管 入群验证 超时踢出 ${guard.kickOnTimeout ? "关" : "开"}`]
          },
          {
            label: "答错踢出",
            on: guard.kickOnWrongAnswer,
            detail: guard.kickOnWrongAnswer ? "答错次数用尽即移出群聊" : "答错次数用尽仅提示失败",
            commands: [`.群管 入群验证 答错踢出 ${guard.kickOnWrongAnswer ? "关" : "开"}`]
          }
        ]
      },
      {
        label: "群通知",
        enabled: on("groupNotice"),
        masterOk: masterOk("groupNotice"),
        rows: [
          {
            label: "入群欢迎",
            on: notice.welcomeEnabled,
            detail: notice.welcomeMessage || "（未设置文案）",
            commands: [`.群管 群通知 欢迎 ${notice.welcomeEnabled ? "关" : "开"}`, ".群管 群通知 欢迎语 {at} 欢迎加入本群"]
          },
          {
            label: "退群提示",
            on: notice.leaveEnabled,
            detail: notice.leaveMessage || "（未设置文案）",
            commands: [`.群管 群通知 退群 ${notice.leaveEnabled ? "关" : "开"}`, ".群管 群通知 退群语 用户 {userId} 退出了群聊"]
          }
        ]
      }
    ]
  }
}

/** 渲染失败时的纯文本降级版面板 */
export function buildGroupAdminPageText(data:GroupAdminPageData) {
  const lines = [`群 ${data.groupId} 群管面板`]
  for (const section of data.sections) {
    const state = !section.masterOk ? "总开关未开" : section.enabled ? "本群已开启" : "本群未开启"
    lines.push(`\n【${section.label}】${state}`)
    for (const row of section.rows) {
      lines.push(`${row.on ? "✅" : "▫️"} ${row.label}：${row.detail}`)
      for (const cmdText of row.commands || []) lines.push(`　${cmdText}`)
    }
  }
  lines.push("\n命令示例值即当前值，改数字/开关直接抄；仅群主/群管理/群管管理员可修改，发送 .群管 查看最新面板")
  return lines.join("\n")
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export function buildGroupAdminPageHtml(data:GroupAdminPageData) {
  const sections = data.sections.map(section => {
    const state = !section.masterOk
      ? '<i class="badge warn">总开关未开</i>'
      : section.enabled
        ? '<i class="badge ok">本群已开启</i>'
        : '<i class="badge no">本群未开启</i>'
    const rows = section.rows.map(row => `
      <div class="feature ${row.on ? "" : "off"}">
        <div class="f-main">
          <span class="f-name">${escapeHtml(row.label)}</span>
          <span class="f-detail">${escapeHtml(row.detail)}</span>
          <span class="f-state">${row.on ? '<i class="badge ok">开</i>' : '<i class="badge no">关</i>'}</span>
        </div>
        ${(row.commands || []).length
          ? `<div class="f-cmds">${row.commands!.map(cmdText => `<code>${escapeHtml(cmdText)}</code>`).join("")}</div>`
          : ""}
      </div>`).join("")
    return `
    <div class="section">
      <div class="section-head"><h2>${escapeHtml(section.label)}</h2>${state}</div>
      ${rows}
    </div>`
  }).join("")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 760px; font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; background: #f3f5f9; color: #1f2430; padding: 22px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 6px 24px rgba(15, 23, 42, .08); overflow: hidden; }
  .head { padding: 18px 22px 14px; border-bottom: 1px solid #e8ecf3; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .head h1 { font-size: 20px; }
  .head .gid { font-size: 13px; color: #6b7280; font-variant-numeric: tabular-nums; }
  .section { padding: 6px 0 8px; }
  .section + .section { border-top: 1px solid #eef1f6; }
  .section-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 22px 4px; }
  .section-head h2 { font-size: 15px; }
  .feature { padding: 7px 22px 8px; }
  .feature + .feature { border-top: 1px dashed #eef1f6; }
  .f-main { display: flex; align-items: baseline; gap: 12px; }
  .f-name { width: 128px; flex-shrink: 0; font-weight: 550; font-size: 13.5px; }
  .f-detail { flex: 1; min-width: 0; color: #5b6472; font-size: 13px; word-break: break-all; }
  .f-state { flex-shrink: 0; }
  .feature.off .f-name, .feature.off .f-detail { color: #a2abba; }
  .f-cmds { margin-top: 6px; padding-left: 140px; display: flex; flex-wrap: wrap; gap: 5px; }
  .f-cmds code { background: #f1f4f9; border-radius: 5px; padding: 1px 7px; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #333c4d; white-space: nowrap; }
  .badge { font-style: normal; font-size: 12px; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
  .badge.ok { background: #e7f6ec; color: #147d3d; }
  .badge.no { background: #eceef2; color: #6b7280; }
  .badge.warn { background: #fef3c7; color: #92400e; }
  .foot { padding: 12px 22px 16px; border-top: 1px solid #e8ecf3; font-size: 12.5px; color: #5b6472; line-height: 1.8; }
  .foot code { background: #f1f4f9; border-radius: 5px; padding: 1px 6px; font-family: ui-monospace, Menlo, monospace; color: #1f2430; white-space: nowrap; display: inline-block; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <h1>群管面板</h1>
      <span class="gid">群 ${escapeHtml(data.groupId)}</span>
    </div>
    ${sections}
    <div class="foot">
      每个功能下方是它自己的配置命令（示例值即当前值）；发送 <code>.群管 功能名</code>（如 <code>.群管 刷屏检测</code>）可查看该功能完整用法。<br>
      支持一次多组参数：<code>.群管 连发折叠 条数 5 窗口 8</code>；仅群主/群管理/群管管理员可修改。
    </div>
  </div>
</body>
</html>`
}

// ---------- 写入：按群覆盖 ----------

function setPath(target:Data, dotted:string, value:unknown) {
  const parts = dotted.split(".")
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    const next = JSON.parse(JSON.stringify(adminRecord(cursor[part]))) as Data
    cursor[part] = next
    cursor = next
  }
  cursor[parts.at(-1)!] = value
}

export function buildGroupAdminOverrideUpdates(settings:Data, groupId:unknown, changes:{module:string;path:string;value:unknown}[]) {
  const id = String(groupId || "").trim()
  const rows = groupAdminOverrides(settings).map(row => JSON.parse(JSON.stringify(row)) as Data)
  let row = rows.find(item => groupAdminRowId(item) === id)
  if (!row) {
    row = { groupId: id }
    rows.push(row)
  }
  for (const change of changes) setPath(row, `${change.module}.${change.path}`, change.value)
  const meaningful = Object.keys(row).some(key => !["groupId", "group_id", "group"].includes(key))
  const filtered = meaningful ? rows : rows.filter(item => groupAdminRowId(item) !== id)
  return { "groupAdmin.overrides": filtered }
}

function getIn(source:unknown, dotted:string) {
  let cursor:unknown = source
  for (const key of dotted.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined
    cursor = (cursor as Data)[key]
  }
  return cursor
}

/** `.群管 <功能名>` 的用法帮助：当前值 + 子命令用法 */
export function buildFeatureHelp(feature:FeatureDef, settings:Data, groupId:unknown) {
  const resolved = resolveGroupAdminSettings(settings, String(groupId || ""))
  const configs:Record<string,unknown> = {
    groupModeration: normalizeGroupModerationConfig(resolved.groupModeration),
    groupGuard: normalizeGroupGuardConfig(resolved.groupGuard),
    groupNotice: normalizeGroupNoticeConfig(resolved.groupNotice)
  }
  const config = configs[feature.module]
  const entry = feature.names[0]!
  const lines = [`【${feature.label}】`]
  if (feature.togglePath) {
    const on = getIn(config, feature.togglePath) === true
    lines.push(`当前状态：${on ? "开" : "关"}　开关：.群管 ${entry} ${on ? "关" : "开"}`)
  }
  lines.push("参数用法（示例值即当前值，可一次多组）：")
  for (const param of feature.params) {
    const raw = getIn(config, param.path)
    const current = typeof raw === "boolean" ? (raw ? "开" : "关") : String(raw ?? "?")
    const range = param.kind === "boolean" ? "开/关" : `${param.min}~${param.max}`
    lines.push(`.群管 ${entry} ${param.names[0]} ${current} —— ${param.help}（${range}）`)
  }
  for (const param of feature.textParams) {
    const current = String(getIn(config, param.path) || "")
    lines.push(`.群管 ${entry} ${param.names[0]} ${current || "<内容>"} —— ${param.help}（≤${param.max}字）`)
  }
  return lines.join("\n")
}

// ---------- 插件 ----------

export interface GroupAdminPagePorts {
  readSettings():Data
  applyUpdates(updates:Data):unknown
  logger?:GroupAdminLogger
  cwd:string
  getSharedBrowser():Promise<Browser>
  scheduleSharedBrowserClose():void
  image(imagePath:string):unknown
}

export function createGroupAdminPageMessage(Plugin:new(options:Record<string,unknown>)=>object,ports:GroupAdminPagePorts,manager:GroupModerationManager) {
  async function renderPage(data:GroupAdminPageData) {
    const outputDir = path.join(ports.cwd, "resources", "shiloh-plugin", "group_admin_pages")
    await fs.promises.mkdir(outputDir, { recursive: true })
    const outputPath = path.join(outputDir, `group-admin-page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    const browser = await ports.getSharedBrowser()
    const page = await browser.newPage()
    try {
      await page.setViewport({ width: 760, height: 900, deviceScaleFactor: 2 })
      await page.setContent(buildGroupAdminPageHtml(data), { waitUntil: "domcontentloaded", timeout: 30000 })
      const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height))
      await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: 760, height: Math.max(1, height) }, type: "png" })
      return outputPath
    } finally {
      await page.close().catch(() => {})
      ports.scheduleSharedBrowserClose()
    }
  }

  async function deletePage(path_ = "") {
    if (!path_) return
    try { await fs.promises.unlink(path_) } catch {}
  }

  async function sendPage(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
    const data = buildGroupAdminPageData(ports.readSettings(), e.group_id)
    let imagePath = ""
    try {
      imagePath = await renderPage(data)
      await e.reply(ports.image(imagePath))
    } catch (error) {
      ports.logger?.warn?.(`[GroupAdminPage] 面板渲染失败，改发文本: ${adminError(error)}`)
      await e.reply(buildGroupAdminPageText(data))
    } finally {
      await deletePage(imagePath)
    }
    return true
  }

  function canManage(e:AdminEvent) {
    const config = manager.getConfig(e.group_id)
    return Boolean(e?.isMaster || manager.isNativeGroupAdmin(e) || manager.isConfiguredAdmin(config, e.group_id, e.user_id))
  }

  function notAllowedMessage() {
    return "只有群主、群管理或群管配置的管理员可以用命令修改，发送 .群管 查看当前面板。"
  }

  return class GroupAdminPageMessage extends Plugin {
    constructor() {
      super({
        name: "群管理-群管面板",
        dsc: "群内群管面板：.群管 查看面板，.群管 <功能> [开|关|参数 值...] 查看用法与配置",
        event: "message.group",
        priority: 4800,
        rule: [
          { reg: "^[#＃.。]\\s*群管\\s+\\S", fnc: "handleGroupAdminCommand" },
          { reg: "^[#＃.。]\\s*群管(?:\\s*(?:页面|面板|帮助|help))?\\s*$", fnc: "handleGroupAdminView" }
        ]
      })
    }

    async handleGroupAdminView(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
      return await sendPage(e)
    }

    describeChange(feature:FeatureDef, change:FeatureChange) {
      const param = feature.params.find(item => item.path === change.path)
        || feature.textParams.find(item => item.path === change.path)
      const label = param?.label || (feature.togglePath === change.path ? "开关" : change.path)
      const value = typeof change.value === "boolean" ? (change.value ? "开" : "关") : String(change.value)
      return `${label}=${value}`
    }

    async handleGroupAdminCommand(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
      const command = parseGroupAdminCommand(e.msg)
      if (!command) return false
      if (!command.ok) {
        await e.reply(command.message)
        return true
      }
      if (command.type === "view") return await sendPage(e)

      // 功能语法：.群管 <功能> —— 帮助对所有人可见，修改需要权限
      if (command.type === "feature") {
        if (command.action === "help") {
          await e.reply(buildFeatureHelp(command.feature, ports.readSettings(), e.group_id))
          return true
        }
        if (!canManage(e)) {
          await e.reply(notAllowedMessage())
          return true
        }
        const changes = command.action === "toggle"
          ? [{ path: command.feature.togglePath!, value: command.enable }]
          : command.changes
        ports.applyUpdates(buildGroupAdminOverrideUpdates(ports.readSettings(), e.group_id,
          changes.map(change => ({ module: command.feature.module, path: change.path, value: change.value }))))
        const summary = changes.map(change => this.describeChange(command.feature, change)).join("、")
        ports.logger?.info?.(`[GroupAdminPage] ${e.group_id} user=${e.user_id} ${command.feature.label}: ${summary}`)
        await e.reply(`已设置「${command.feature.label}」：${summary}，发送 .群管 查看最新面板。`)
        return true
      }

      // 兼容旧语法
      if (!canManage(e)) {
        await e.reply(notAllowedMessage())
        return true
      }
      if (command.type === "toggle") {
        const { feature, enable } = command
        ports.applyUpdates(buildGroupAdminOverrideUpdates(ports.readSettings(), e.group_id, [
          { module: feature.module, path: feature.path, value: enable }
        ]))
        ports.logger?.info?.(`[GroupAdminPage] ${e.group_id} user=${e.user_id} ${enable ? "开启" : "关闭"} ${feature.label}`)
        await e.reply(`已${enable ? "开启" : "关闭"}「${feature.label}」，发送 .群管 查看最新面板。`)
        return true
      }
      const { rule, value } = command
      ports.applyUpdates(buildGroupAdminOverrideUpdates(ports.readSettings(), e.group_id, [
        { module: rule.module, path: rule.path, value }
      ]))
      ports.logger?.info?.(`[GroupAdminPage] ${e.group_id} user=${e.user_id} 设置 ${rule.label}=${String(value)}`)
      const shown = rule.kind === "boolean"
        ? value ? "开" : "关"
        : rule.kind === "text"
          ? `「${[...String(value)].slice(0, 40).join("")}${[...String(value)].length > 40 ? "…" : ""}」`
          : String(value)
      await e.reply(`已设置「${rule.label}」为 ${shown}，发送 .群管 查看最新面板。`)
      return true
    }
  }
}
