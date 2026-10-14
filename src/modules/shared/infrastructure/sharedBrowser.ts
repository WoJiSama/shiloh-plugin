export interface SharedBrowser {isConnected():boolean;close():Promise<void>;on(event:'disconnected',listener:()=>void):unknown}
export function createSharedBrowser<B extends SharedBrowser>(launch:()=>Promise<B>,idleMs=600000) {
 let pending:Promise<B>|null=null
 let timer:ReturnType<typeof setTimeout>|null=null
 function clear(){if(timer)clearTimeout(timer);timer=null}
 async function getSharedBrowser():Promise<B>{
  clear()
  if(!pending){
   const launched=launch();pending=launched
   void launched.then(browser=>{browser.on('disconnected',()=>{if(pending===launched)pending=null})},()=>{if(pending===launched)pending=null})
  }
  const current=pending
  const browser=await current
  if(!browser.isConnected()){if(pending===current)pending=null;throw new Error('共享浏览器连接已断开，请重试')}
  return browser
 }
 function scheduleSharedBrowserClose(){clear();timer=setTimeout(async()=>{
  const closing=pending;pending=null;timer=null
  try{const browser=await closing;if(browser?.isConnected())await browser.close()}catch{}
 },idleMs);timer.unref?.()}
 return {getSharedBrowser,scheduleSharedBrowserClose}
}
