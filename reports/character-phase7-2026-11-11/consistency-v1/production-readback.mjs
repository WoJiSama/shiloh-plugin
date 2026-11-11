import fs from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
const root='/opt/trss-yunzai/plugins/shiloh-plugin', group='609235590'
const hash=x=>createHash('sha256').update(x).digest('hex')
const manifest=JSON.parse(fs.readFileSync(root+'/release-manifest.json'))
const YAML=createRequire(root+'/package.json')('yaml')
const settingsDocument=YAML.parse(fs.readFileSync(root+'/config/message.yaml','utf8'))
const settings=settingsDocument.pluginSettings||settingsDocument
const review=settings.taskAiConfig?.characterConsistency
const consistency={enabled:settings.simulation?.consistency?.enabled===true,independentBackendConfigured:!!(review?.apiUrl&&review?.model&&review?.apiKey?.length)}
const mismatchedFiles=Object.entries(manifest.files).filter(([p,h])=>{try{return hash(fs.readFileSync(root+'/'+p))!==h}catch{return true}}).map(([p])=>p)
const token=JSON.parse(fs.readFileSync(root+'/config/console.json')).token
const get=async p=>{const r=await fetch('http://127.0.0.1:8787'+p,{headers:{'x-console-token':token},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('Readback HTTP '+r.status);return r.json()}
const detail=await get('/api/simulation/group?group='+group), overview=await get('/api/simulation/overview')
const life=await get('/api/life/overview'),health=await get('/api/health/alerts')
const unauth=await fetch('http://127.0.0.1:8787/api/simulation/group?group='+group)
const character=detail.character||{},binding=detail.characterBinding||detail.binding||{}
const scope=character.scope
let independentRedisMatches=null
if(scope){const key='shiloh:character:v1:'+['botId','personaId','groupId'].map(k=>encodeURIComponent(scope[k])).join(':');const actual=execFileSync('redis-cli',['--raw','GET',key],{encoding:'utf8'}).trim();independentRedisMatches=actual?JSON.stringify(JSON.parse(actual))===JSON.stringify(character):false}
const services=Object.fromEntries(['trss-yunzai','bl-console'].map(name=>[name,execFileSync('systemctl',['is-active',name],{encoding:'utf8'}).trim()]))
console.log(JSON.stringify({at:new Date().toISOString(),commit:manifest.commit,runtimeFiles:Object.keys(manifest.files).length,mismatchedFiles,privateConfigSha256:hash(fs.readFileSync(root+'/config/message.yaml')),services,consistency,group:{groupId:group,running:detail.running,active:detail.active,replyMode:detail.replyMode,budget:detail.budget,binding,scope,paused:character.paused,memoryCount:character.memories?.length,goalCount:character.goals?.length,revision:character.revision,independentRedisMatches},overviewGroups:overview.groups?.length,lifeOverviewReachable:!!life,healthAlertsReachable:!!health,unauthenticatedStatus:unauth.status,qqMessagesSentByVerifier:0,productionWritesByVerifier:0},null,2))
