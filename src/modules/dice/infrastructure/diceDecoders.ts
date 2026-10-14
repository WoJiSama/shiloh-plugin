import type {DiceState,DiceCard,DiceGroup,DiceUser,DiceLogLine} from '../../../contracts/dice.js'
export function diceRecord(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
export function diceError(value:unknown):string{return value instanceof Error?value.message:String(value)}
function validRecord(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function validateOptional(value:Record<string,unknown>,key:string,predicate:(value:unknown)=>boolean){if(value[key]!==undefined&&!predicate(value[key]))throw new Error(`${key} 字段损坏`)}
const isString=(value:unknown)=>typeof value==='string'
const isBoolean=(value:unknown)=>typeof value==='boolean'
const isNumber=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)
const isStrings=(value:unknown)=>Array.isArray(value)&&value.every(isString)
function validateDnd(value:unknown){
 if(!validRecord(value))return false
 validateOptional(value,'buffs',isStrings)
 validateOptional(value,'spellSlots',slots=>validRecord(slots)&&Object.values(slots).every(slot=>isNumber(slot)||(validRecord(slot)&&isNumber(slot.current)&&isNumber(slot.max))))
 validateOptional(value,'deathSaves',saves=>validRecord(saves)&&isNumber(saves.success)&&isNumber(saves.failure))
 return true
}
function validateLog(value:unknown){if(!validRecord(value)||!isString(value.file)||!isBoolean(value.active))return false;for(const key of ['title','startedAt','startedBy','endedAt'])validateOptional(value,key,isString);return true}
function numericBag(value:unknown):Record<string,number>{const result:Record<string,number>={};for(const [k,v]of Object.entries(diceRecord(value)))if(typeof v==='number'&&Number.isFinite(v))result[k]=v;return result}
export function decodeDiceState(value:unknown):DiceState {
 if(!validRecord(value))throw new Error('数据根节点不是对象')
 for(const key of ['users','groups'])if(value[key]!==undefined&&!validRecord(value[key]))throw new Error(`${key} 字段损坏`)
 const users:Record<string,DiceUser>={},groups:Record<string,DiceGroup>={}
 for(const [id,raw]of Object.entries(diceRecord(value.users))){
  if(!validRecord(raw))throw new Error('users 成员损坏')
  validateOptional(raw,'nickname',isString);validateOptional(raw,'locked',isBoolean);validateOptional(raw,'dnd',validateDnd)
  const cards:Record<string,DiceCard>={}
  if(raw.cards!==undefined&&!validRecord(raw.cards))throw new Error('人物卡字段损坏')
  for(const [name,card]of Object.entries(diceRecord(raw.cards))){
   if(!validRecord(card))throw new Error('人物卡记录损坏')
   validateOptional(card,'locked',isBoolean);validateOptional(card,'hiddenAttrs',isStrings);validateOptional(card,'tags',isStrings);validateOptional(card,'dnd',validateDnd)
   validateOptional(card,'sanLossLog',log=>validRecord(log)&&Object.values(log).every(entry=>isNumber(entry)||(validRecord(entry)&&isNumber(entry.loss)&&isNumber(entry.baseline))))
   cards[name]={...card,name:typeof card.name==='string'?card.name:name,attrs:numericBag(card.attrs),skills:numericBag(card.skills)} as DiceCard
  }
  users[id]={...raw,activeCard:typeof raw.activeCard==='string'?raw.activeCard:'默认',cards} as DiceUser
 }
 for(const [id,group]of Object.entries(diceRecord(value.groups))){if(!validRecord(group))throw new Error('groups 成员损坏');for(const key of ['replyEnabled'])validateOptional(group,key,isBoolean);for(const key of ['rule','system','stFmt'])validateOptional(group,key,isString);validateOptional(group,'defaultDiceSides',isNumber);validateOptional(group,'observers',isStrings);validateOptional(group,'teams',teams=>validRecord(teams)&&Object.values(teams).every(isStrings));validateOptional(group,'log',validateLog);validateOptional(group,'logs',logs=>Array.isArray(logs)&&logs.every(validateLog));validateOptional(group,'initiative',list=>Array.isArray(list)&&list.every(item=>validRecord(item)&&isString(item.name)&&isNumber(item.value)));validateOptional(group,'autoCardNames',names=>validRecord(names)&&Object.values(names).every(validRecord));groups[id]=group as DiceGroup}
 return {...value,version:Number(value.version)||1,users,groups}
}
export function decodeDiceLogLine(value:unknown):DiceLogLine|null {
 if(!validRecord(value))return null
 const result:DiceLogLine={...value}
 for(const key of ['at','name','userId','content','type'] as const)if(value[key]!==undefined)result[key]=String(value[key])
 return result
}
export function numericDiceTotal(value:number|string):number {if(typeof value!=='number'||!Number.isFinite(value))throw new Error('此处需要数值骰点结果，不能使用比较计数表达式');return value}
