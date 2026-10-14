import type {EmojiItem} from '../../../contracts/emoji.js'
export function emojiRecord(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
export function emojiError(value:unknown):string{return value instanceof Error?value.message:String(value)}
export function emojiStrings(value:unknown):string[]{return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[]}
export function emojiContent(value:unknown):string {const root=emojiRecord(value),choices=Array.isArray(root.choices)?root.choices:[],content=emojiRecord(emojiRecord(choices[0]).message).content;return typeof content==='string'?content:''}
export function decodeEmojiItem(value:unknown):EmojiItem|null {
 const item=emojiRecord(value)
 if(typeof item.hash!=='string'||!item.hash||typeof item.file!=='string'||!item.file)return null
 return {hash:item.hash,file:item.file,tags:emojiStrings(item.tags),useCases:emojiStrings(item.useCases),description:typeof item.description==='string'?item.description:'',embedding:Array.isArray(item.embedding)&&item.embedding.every(v=>typeof v==='number'&&Number.isFinite(v))?item.embedding:null,usedCount:Number(item.usedCount)||0,lastUsedAt:typeof item.lastUsedAt==='string'?item.lastUsedAt:null,registeredAt:typeof item.registeredAt==='string'?item.registeredAt:'',isBanned:item.isBanned===true,noFileFlag:item.noFileFlag===true,...(typeof item.source==='string'?{source:item.source}:{})}
}
