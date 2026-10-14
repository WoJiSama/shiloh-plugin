import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createUmaRaceManager} from '../../src/modules/games/infrastructure/uma/UmaRaceManager.js'
import {decodeUmaPoints} from '../../src/modules/games/infrastructure/uma/umaState.js'
test('Uma persistence preserves training and personality fields and rejects corrupt players',()=>{
 const fixture={players:{'1':{userId:'1',nickname:'user',points:25,wins:1,races:2,podiums:2,trainingPity:{basic:{speed:3}},uma:{name:'horse',personality:'calm',attributes:{speed:8},total:40,createdAt:'today',trait:{key:'calm',label:'calm',description:'calm',fit:{normal:4},tagFit:{corner:3},riskAdjust:0.04,luckBonus:2},proficiency:{steady:10}}}}}
 const value=decodeUmaPoints(fixture).players['1']!
 assert.equal(value.podiums,2);assert.equal(value.uma?.createdAt,'today');assert.deepEqual(value.uma?.trait?.fit,{normal:4});assert.equal(value.uma?.trait?.luckBonus,2);assert.equal(value.trainingPity?.basic?.speed,3)
 for(const invalid of [{players:[]},{players:{a:{}}},{players:{a:null}}])assert.throws(()=>decodeUmaPoints(invalid))
})
test('Uma damaged points fail closed and failed writes do not poison subsequent writes',async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'uma-state-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}))
 const {UmaRaceManager}=createUmaRaceManager({sendSmartReply:async()=>{}}),manager=new UmaRaceManager({cwd})
 const config={...manager.getConfig(),baseDir:path.join(cwd,'state')}
 fs.mkdirSync(config.baseDir);fs.writeFileSync(manager.getPointsPath(config),'broken')
 assert.throws(()=>manager.readPoints(config),/停止写入/);assert.equal(fs.readFileSync(manager.getPointsPath(config),'utf8'),'broken')
 const bad=path.join(cwd,'file');fs.writeFileSync(bad,'not a directory')
 await assert.rejects(manager.writePoints({players:{}},{...config,baseDir:bad}))
 await manager.writePoints({players:{}},config)
 assert.deepEqual(manager.readPoints(config),{players:{}})
})
