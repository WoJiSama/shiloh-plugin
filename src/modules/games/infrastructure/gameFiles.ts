// 小游戏模块共用的文件基建:目录保障、带写入链的原子JSON读写(pluginSettings 读取)。
// 抽象尺度:只放无游戏语义的通用件,赛马娘现有代码暂不迁移,待海龟汤跑通后再收敛。
import fs from "fs"
import path from "path"
import YAML from "yaml"
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {execFileSync} from 'node:child_process'

export function ensureDir(dir:string) {
  fs.mkdirSync(dir, {recursive: true})
}

export interface AtomicJsonStore {
  readonly filePath:string
  exists():boolean
  readText():string|null
  write(data:unknown):Promise<void>
}

// 同一文件的写操作串行化(写入链),临时文件+rename 保证崩溃不产生半截文件。
export function createAtomicJsonStore(filePath:string):AtomicJsonStore {
  let writeChain:Promise<unknown> = Promise.resolve()
  const enqueue = (task:() => Promise<void>) => {
    const next = writeChain.catch(() => {}).then(task)
    writeChain = next.catch(() => {})
    return next
  }
  return {
    filePath,
    exists: () => fs.existsSync(filePath),
    readText: () => (fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null),
    write: data => enqueue(async () => {
      ensureDir(path.dirname(filePath))
      const tmp = `${filePath}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
      fs.renameSync(tmp, filePath)
    })
  }
}

export function resolvePluginRoot(cwd:string):string {
  const nested=path.join(cwd,'plugins/shiloh-plugin')
  if(path.basename(cwd)==='shiloh-plugin'||fs.existsSync(path.join(cwd,'config_default/message.yaml')))return cwd
  try { if(record(JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8'))).name==='shiloh-plugin')return cwd } catch {}
  if(fs.existsSync(nested))return nested
  if(fs.existsSync(path.join(cwd,'config/message.yaml')))return cwd
  return nested
}

export function readPluginSettings(cwd:string):Record<string,unknown> {
  const root=resolvePluginRoot(cwd)
  const userPath = path.join(root, "config/message.yaml")
  const defaultPath = path.join(root, "config_default/message.yaml")
  const configPath = fs.existsSync(userPath) ? userPath : defaultPath
  if (!fs.existsSync(configPath)) return {}
  try {
    const parsed=record(YAML.parse(fs.readFileSync(configPath, "utf8")))
    return {...parsed,...record(parsed.pluginSettings)}
  } catch {
    return {}
  }
}

export function resolveDataDir(cwd:string, baseDir:string):string {
  return path.isAbsolute(baseDir) ? baseDir : path.join(resolvePluginRoot(cwd), baseDir)
}

const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
export function decodeMiniGamesSettings(settings:Record<string,unknown>):{enabled:boolean;turtleSoup:Record<string,unknown>} {
  const raw = record(record(settings).miniGames)
  return {enabled: raw.enabled !== false, turtleSoup: {...record(settings.turtleSoup),...record(raw.turtleSoup)}}
}

// A committed journal is written before any of the legacy JSON files change.
// Readers use that complete snapshot until the files and revision marker are durable.
export function writeAtomicJson(filePath:string,data:unknown):void {
  ensureDir(path.dirname(filePath))
  const temporary=`${filePath}.${process.pid}.${randomUUID()}.tmp`
  let fd:number|undefined
  try {
    fd=fs.openSync(temporary,'wx',0o600)
    fs.writeFileSync(fd,JSON.stringify(data,null,2),'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd);fd=undefined
    fs.renameSync(temporary,filePath)
    const directory=fs.openSync(path.dirname(filePath),'r')
    try {fs.fsyncSync(directory)}finally{fs.closeSync(directory)}
  } finally {
    if(fd!==undefined)fs.closeSync(fd)
    if(fs.existsSync(temporary))fs.unlinkSync(temporary)
  }
}

// A PID alone is reusable after a process/container/host restart. Bind leases
// to the process start identity as well, without expiring live model requests.
function processIdentity(pid:number):string|null {
  try {
    if(process.platform==='linux'){
      const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8')
      const start=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19]
      const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()
      return start?`${boot}:${start}`:null
    }
    if(process.platform==='darwin')return execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim()||null
  } catch {}
  return null
}
const ownProcessIdentity=processIdentity(process.pid)
const processStartedAt=Date.now()-process.uptime()*1000

export async function withFileLock<Result>(lockPath:string,operation:()=>Promise<Result>|Result,timeoutMs=5000):Promise<Result> {
  ensureDir(path.dirname(lockPath))
  const token=randomUUID(),started=Date.now()
  const ownerFile=path.join(lockPath,'owner.json')
  const isAbandoned=(directory:string):boolean=>{
    try {
      const owner=record(JSON.parse(fs.readFileSync(path.join(directory,'owner.json'),'utf8')))
      if(typeof owner.pid==='number'){
        try {process.kill(owner.pid,0)}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'}
        const identity=owner.pid===process.pid?ownProcessIdentity:processIdentity(owner.pid)
        if(typeof owner.processIdentity==='string'&&identity)return owner.processIdentity!==identity
        // Compatibility for a lock left before start identities were recorded.
        if(owner.pid===process.pid)return (typeof owner.createdAt==='number'?owner.createdAt:fs.statSync(directory).mtimeMs)<processStartedAt-1000
        return false
      }
    } catch {}
    try {return Date.now()-fs.statSync(directory).mtimeMs>30_000}catch{return false}
  }
  while(true){
    try {
      fs.mkdirSync(lockPath)
      try {fs.writeFileSync(ownerFile,JSON.stringify({pid:process.pid,token,createdAt:Date.now(),processIdentity:ownProcessIdentity}),{flag:'wx'})}
      catch(error){fs.rmSync(lockPath,{recursive:true,force:true});throw error}
      break
    } catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
      if(isAbandoned(lockPath)){
        const recoveryPath=`${lockPath}.recovery`
        try {
          fs.mkdirSync(recoveryPath)
          const recoveryToken=randomUUID()
          try {
            fs.writeFileSync(path.join(recoveryPath,'owner.json'),JSON.stringify({pid:process.pid,token:recoveryToken,createdAt:Date.now(),processIdentity:ownProcessIdentity}),{flag:'wx'})
            if(isAbandoned(lockPath))fs.rmSync(lockPath,{recursive:true,force:true})
          } finally {
            const owner=record(JSON.parse(fs.readFileSync(path.join(recoveryPath,'owner.json'),'utf8')))
            if(owner.token===recoveryToken)fs.rmSync(recoveryPath,{recursive:true,force:true})
          }
        } catch(error){
          if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
          // A process may also die during recovery. Never spin synchronously on
          // that directory, or let it permanently prevent later lock recovery.
          if(isAbandoned(recoveryPath))fs.rmSync(recoveryPath,{recursive:true,force:true})
        }
      }
      if(Date.now()-started>=timeoutMs)throw new Error(path.basename(lockPath)==='.generation-lock'?'已有海龟汤生成任务进行中，请稍后重试':'海龟汤存储忙，请稍后重试')
      await delay(15+Math.floor(Math.random()*20))
    }
  }
  try {return await operation()}
  finally {
    try {
      const owner=record(JSON.parse(fs.readFileSync(ownerFile,'utf8')))
      if(owner.token===token)fs.rmSync(lockPath,{recursive:true,force:true})
    } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
}
