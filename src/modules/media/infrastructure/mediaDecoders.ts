export function mediaRecord(value:unknown):Record<string,unknown> {return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
export function mediaRecords(value:unknown):Record<string,unknown>[] {return Array.isArray(value)?value.map(mediaRecord):[]}
export function mediaString(value:unknown):string {return typeof value==='string'?value:typeof value==='number'?String(value):''}
export function mediaError(value:unknown):{message:string;code:string;killed:boolean;signal:string;stderr:string} {
 const record=mediaRecord(value);return {message:value instanceof Error?value.message:mediaString(record.message),code:mediaString(record.code),killed:record.killed===true,signal:mediaString(record.signal),stderr:mediaString(record.stderr)}
}
export function mediaCookieHeaders(headers:{raw?():Record<string,string[]>;getSetCookie?():string[]}):string[] {return headers.getSetCookie?.()||headers.raw?.()['set-cookie']||[]}
export function decodeBilibiliVideo(value:unknown):import('../../../contracts/mediaRelay.js').BilibiliVideoDetails {
 const data=mediaRecord(value),owner=mediaRecord(data.owner),stat=mediaRecord(data.stat),stats:Record<string,number>={}
 for(const [key,value]of Object.entries(stat))if(Number.isFinite(Number(value)))stats[key]=Number(value)
 return {bvid:mediaString(data.bvid),aid:Number(data.aid)||0,cid:Number(data.cid)||0,owner:{mid:Number(owner.mid)||0,name:mediaString(owner.name)},pic:mediaString(data.pic),title:mediaString(data.title),desc:mediaString(data.desc),stat:stats,duration:Number(data.duration)||0,pubdate:Number(data.pubdate)||0,tname:mediaString(data.tname),view:Number(data.view)||0}
}
