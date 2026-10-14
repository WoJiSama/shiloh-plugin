import type {UmaPoints,UmaPlayerRecord,UmaPet,UmaRaceState} from '../../../../contracts/uma.js'
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
function numbers(value:unknown):Record<string,number>{const result:Record<string,number>={};for(const [key,v]of Object.entries(record(value)))if(typeof v==='number'&&Number.isFinite(v))result[key]=v;return result}
export function decodeUmaPoints(value:unknown):UmaPoints {
 const root=record(value);if(!root.players||typeof root.players!=='object'||Array.isArray(root.players))throw new Error('赛马积分文件格式无效')
 const players:Record<string,UmaPlayerRecord>={}
 for(const [id,item]of Object.entries(record(root.players))){
  const raw=record(item);if(!item||typeof item!=='object'||Array.isArray(item)||!Object.keys(raw).length)throw new Error('赛马玩家记录无效');const player:UmaPlayerRecord={userId:String(raw.userId||id),nickname:String(raw.nickname||''),points:Number(raw.points)||0,wins:Number(raw.wins)||0,races:Number(raw.races)||0,podiums:Number(raw.podiums)||0}
  for(const key of ['updatedAt','lastRaceAt'] as const)if(typeof raw[key]==='string')player[key]=raw[key]
  const pet=record(raw.uma)
  if(typeof pet.name==='string'&&typeof pet.personality==='string'){
   const uma:UmaPet={name:pet.name,personality:pet.personality,attributes:numbers(pet.attributes),proficiency:numbers(pet.proficiency)}
   for(const key of ['adoptedAt','updatedAt','createdAt'] as const)if(typeof pet[key]==='string')uma[key]=pet[key]
   if(typeof pet.total==='number')uma.total=pet.total
   const trait=record(pet.trait);if(typeof trait.key==='string')uma.trait={key:trait.key,label:String(trait.label||''),description:String(trait.description||''),fit:numbers(trait.fit),tagFit:numbers(trait.tagFit),...(typeof trait.riskAdjust==='number'?{riskAdjust:trait.riskAdjust}:{}),...(typeof trait.luckBonus==='number'?{luckBonus:trait.luckBonus}:{})}
   const affix=record(pet.affix);if(typeof affix.label==='string')uma.affix={id:String(affix.id||''),label:affix.label,quality:String(affix.quality||'common'),qualityLabel:String(affix.qualityLabel||''),tags:Array.isArray(affix.tags)?affix.tags.filter((v):v is string=>typeof v==='string'):[],mechanic:String(affix.mechanic||''),effect:Number(affix.effect)||0,rolledAt:String(affix.rolledAt||'')}
   player.uma=uma
  }
  if(raw.trainingPity){player.trainingPity={};for(const[key,v]of Object.entries(record(raw.trainingPity)))player.trainingPity[key]=numbers(v)}
  players[id]=player
 }
 return {players}
}
export function emptyUmaRaceState():UmaRaceState{return {speed:0,staminaAttr:0,power:0,focus:0,wisdom:0,luck:0,position:0,distance:0,velocity:0,maxVelocity:0,staminaMax:0,stamina:0,rhythmMax:0,rhythm:0,burstMax:0,burstReserve:0,route:0,luckState:0,notes:[]}}
