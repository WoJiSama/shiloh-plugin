import test from 'node:test'
import assert from 'node:assert/strict'
import {createDeltaForceReport} from '../dist/backend/modules/games/infrastructure/DeltaForceReport.js'
import {buildDeltaForceReportView,createDeltaForceReportRenderer} from '../dist/backend/modules/games/infrastructure/DeltaForceReportRenderer.js'
import {createDeltaForceTool} from '../dist/backend/modules/games/infrastructure/DeltaForceTool.js'
import {createDeltaForcePlugin} from '../dist/backend/modules/games/infrastructure/deltaForceApp.js'
test('delta compiled report has unique sanitized concurrent render IDs',async()=>{
  class Base{constructor(){this.userId='../same-user';this.screenData={tplFile:'report.html'}}}
  const Model=createDeltaForceReport(Base);const [a,b]=await Promise.all([new Model({}).getData({}),new Model({}).getData({})]);assert.notEqual(a.saveId,b.saveId);assert.doesNotMatch(a.saveId,/[/.]/);assert.equal(a.tplFile,'report.html')
})
test('delta compiled report escapes remote data including price ranges',()=>{
  const view=buildDeltaForceReportView({kind:'object-value',columns:['<header>'],rows:[{name:'<script>',minPrice:'<img>',maxPrice:'&'}]});assert.doesNotMatch(view.rowsHtml,/<script>|<img>/);assert.match(view.rowsHtml,/&lt;img&gt;/);assert.equal(view.columnsHtml,'<th>&lt;header&gt;</th>')
})
test('delta renderer passes compiled view to screenshot adapter',async()=>{
  let input;class Report{async getData(data){return data}}
  const renderer=createDeltaForceReportRenderer({screenshot:async(name,data)=>{input={name,data};return 'image'}},Report)
  assert.equal(await renderer.renderDeltaForceReport({}, {kind:'profit-rank',columns:[],rows:[],emptyText:'empty'}),'image');assert.equal(input.name,'deltaForceReport');assert.match(input.data.rowsHtml,/empty/)
})
test('delta compiled tool validates missing keywords before network or render',async()=>{
  const Tool=createDeltaForceTool({renderReport:async()=>{throw Error('unexpected render')},logger:{}});const replies=[];const event={msg:'',reply(text){replies.push(text);return Promise.resolve()}}
  assert.equal(await new Tool().func({operation:'object_value'},event),'缺少三角洲物品关键词');assert.match(replies[0],/H70/)
})
test('delta plugin creates command rules and returns help through event port',async()=>{
  class Plugin{constructor(options){this.rule=options.rule}}
  const App=createDeltaForcePlugin(Plugin,{renderReport:async()=>null,logger:{}});const app=new App();assert.ok(app.rule.some(rule=>rule.fnc==='priceHistory'));let help='';assert.equal(await app.showHelp({msg:'',reply:async text=>{help=text}}),true);assert.match(help,/三角洲/)
})
