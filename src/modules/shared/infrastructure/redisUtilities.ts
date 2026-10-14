export interface RedisUtilitiesPort {
 exists(key:string):Promise<number|boolean>;get(key:string):Promise<string|null>;set(key:string,value:string):Promise<unknown>;del(key:string):Promise<number>;keys(pattern:string):Promise<string[]>;expire(key:string,seconds:number):Promise<number|boolean>;ttl(key:string):Promise<number>
}
function object(value:unknown):Record<string,unknown>|null{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null}
export function createRedisUtilities(client:()=>RedisUtilitiesPort){
 const redisExistKey=(key:string)=>client().exists(key)
 const redisGetKey=async(key:string):Promise<unknown>=>{const value=await client().get(key);return value===null?null:JSON.parse(value)}
 const redisSetKey=(key:string,value:unknown={})=>client().set(key,JSON.stringify(value))
 const redisExistAndGetKey=async(key:string)=>await redisExistKey(key)?redisGetKey(key):null
 const redisExistAndInsertObject=async(key:string,value:Record<string,unknown>)=>{const previous=object(await redisExistAndGetKey(key));await redisSetKey(key,{...previous,...value})}
 const redisExistAndUpdateObject=async(key:string,updateKey:string,value:unknown)=>{const previous=object(await redisExistAndGetKey(key));if(previous&&Object.hasOwn(previous,updateKey)){previous[updateKey]=value;await redisSetKey(key,previous)}}
 return {redisExistKey,redisGetKey,redisSetKey,redisExistAndGetKey,redisExistAndInsertObject,redisExistAndUpdateObject,redisDeleteKey:(key:string)=>client().del(key),redisGetAllKeys:()=>client().keys('*'),redisExpireKey:(key:string,seconds:number)=>client().expire(key,seconds),redisTTLKey:(key:string)=>client().ttl(key)}
}
