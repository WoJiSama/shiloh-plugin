import test from 'node:test'
import assert from 'node:assert/strict'
import {createUmaRaceReport} from '../dist/backend/modules/games/infrastructure/uma/UmaRaceReport.js'
import {buildUmaRaceReportView,createUmaRaceReportRenderer} from '../dist/backend/modules/games/infrastructure/uma/UmaRaceReportRenderer.js'
import {createUmaRacePlugin} from '../dist/backend/modules/games/infrastructure/uma/app.js'
test('compiled Uma view escapes untrusted names and clamps progress',()=>{
 const view=buildUmaRaceReportView({title:'<script>',ranking:[{rank:1,name:'<img>',affix:{label:'<b>',quality:'evil-class'}}],proficiencyGains:[{umaName:'<svg>',gains:[{actionKey:'x',label:'<i>',gain:1,after:10,progress:{percent:10000,target:100,need:90,levelIndex:1}}]}]})
 assert.equal(view.title,'&lt;script&gt;');assert.match(view.rankRowsHtml,/&lt;img&gt;/);assert.match(view.rankRowsHtml,/affix-common/);assert.match(view.proficiencyHtml,/width:100%/);assert.doesNotMatch(view.proficiencyHtml,/<svg>/)
})
test('compiled Uma report uses distinct safe filenames for concurrent renders',async()=>{
 class Base{constructor(){this.userId='../user';this.screenData={tplFile:'template'};this.model=''}}
 const Model=createUmaRaceReport(Base),model=new Model({});const [a,b]=await Promise.all([model.getData({title:'a'}),model.getData({title:'b'})]);assert.notEqual(a.saveId,b.saveId);assert.doesNotMatch(a.saveId,/[/.]/);assert.equal(a.tplFile,'template')
 const seen=[];const render=createUmaRaceReportRenderer({screenshot:async(...args)=>{seen.push(args);return 'image'}},Model)
 assert.equal(await render({}, {title:'race'}),'image');assert.equal(seen[0][0],'umaRaceReport');assert.equal(seen[0][1].title,'race')
})
test('compiled Uma command forwards adoption and abandon confirmation explicitly',async()=>{
 class Plugin{constructor(options){Object.assign(this,options)}}
 const calls=[],sent=[];const manager={adoptUma:async(e,options)=>{calls.push(options);return 'adopted'},abandonUma:async(e,options)=>{calls.push(options);return 'abandoned'},raceDecision:async()=>null}
 const App=createUmaRacePlugin(Plugin,{umaRaceManager:manager,sendSmartReply:async(e,text)=>sent.push(text)}),app=new App();const e={msg:'.赛马娘 弃养 确认',reply:async()=>{}}
 await app.readoptUma(e);await app.abandonUma(e);await app.raceDecision(e)
 assert.deepEqual(calls,[{overwrite:true},{confirm:true}]);assert.deepEqual(sent,['adopted','abandoned'])
})
