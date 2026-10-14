export interface KnowledgeItem {text:string;embedding:number[];hash?:string}
export interface KnowledgeConfig {apiKey:string;apiUrl:string;dbPath?:string;model?:string;topN?:number;threshold?:number;keywordCandidateLimit?:number}
export function parseKnowledge(value:unknown):KnowledgeItem|null{
 if(!value||typeof value!=='object')return null
 const item=value as Record<string,unknown>
 if(typeof item.text!=='string'||!item.text||!Array.isArray(item.embedding)||!item.embedding.length||!item.embedding.every(v=>typeof v==='number'&&Number.isFinite(v)))return null
 return {text:item.text,embedding:item.embedding,...(typeof item.hash==='string'?{hash:item.hash}:{})}
}
export function parseEmbeddingResponse(value:unknown):{data:{embedding:number[]}[]}{
 if(!value||typeof value!=='object'||!('data'in value)||!Array.isArray(value.data))throw Error('Embedding API 返回结构无效')
 return {data:value.data.map(item=>{
  if(!item||typeof item!=='object'||!Array.isArray(item.embedding)||!item.embedding.length||!item.embedding.every((v:unknown)=>typeof v==='number'&&Number.isFinite(v)))throw Error('Embedding API 返回向量无效')
  return {embedding:item.embedding}
 })}
}
