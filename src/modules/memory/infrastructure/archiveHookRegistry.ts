interface ArchiveHost<R> { recordMessage(event: unknown, options?: unknown): Promise<R | null> }
interface Registry { base(event:unknown, options?:unknown):Promise<unknown>; wrapped(event:unknown, options?:unknown):Promise<unknown>; subscribers:Set<(record:unknown)=>void> }
const registries = new WeakMap<object,Registry>()
/** One host wrapper fans out to independent listeners; teardown order never nests wrappers. */
export function subscribeArchiveRecords<R>(archive:ArchiveHost<R>, listener:(record:R)=>void):()=>void {
 let registry=registries.get(archive)
 if (!registry) {
  const base=archive.recordMessage
  const subscribers=new Set<(record:unknown)=>void>()
  const wrapped=async(event:unknown,options?:unknown)=>{
   const result=await base.call(archive,event,options)
   if(result) for(const callback of [...subscribers]) { try {callback(result)} catch {} }
   return result
  }
  registry={base,wrapped,subscribers}
  registries.set(archive,registry)
  archive.recordMessage=wrapped
 }
 // All subscribers for this host consume the exact return value of its original method.
 const callback=(record:unknown)=>listener(record as R)
 registry.subscribers.add(callback)
 let active=true
 return ()=>{
  if(!active)return
  active=false
  registry.subscribers.delete(callback)
  if(registry.subscribers.size===0) {
   if(archive.recordMessage===registry.wrapped) archive.recordMessage=registry.base as ArchiveHost<R>['recordMessage']
   registries.delete(archive)
  }
 }
}
