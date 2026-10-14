import test from 'node:test'
import assert from 'node:assert/strict'
import {createModrinthCard} from '../dist/backend/modules/media/infrastructure/ModrinthCard.js'
import {createMagnetSearchReport} from '../dist/backend/modules/media/infrastructure/MagnetSearchReport.js'
import {buildMagnetSearchReportView} from '../dist/backend/modules/media/infrastructure/MagnetSearchReportRenderer.js'
import {mergeMagnetSearchItems,buildMagnetSearchReportData,normalizeMagnetSearchItems} from '../dist/backend/modules/media/infrastructure/MagnetSearchClient.js'
import {createBilibiliRelayPlugin} from '../dist/backend/modules/media/infrastructure/BilibiliRelayPlugin.js'
import {ModrinthClient} from '../dist/backend/modules/media/infrastructure/modrinth.js'
class Base {constructor(e={}){this.userId=e.user_id;this.model='';this.screenData={}}}
test('compiled report cards use unique safe save IDs for parallel rendering',async()=>{
 for(const factory of [createModrinthCard,createMagnetSearchReport]){const Card=factory(Base),card=new Card({user_id:'../../42'});const [a,b]=await Promise.all([card.getData({projectId:'same'}),card.getData({projectId:'same'})]);assert.notEqual(a.saveId,b.saveId);assert.doesNotMatch(a.saveId,/[/\\]/)}
})
test('compiled magnet merges identical hashes despite differing magnet trackers',()=>{
 const hash='a'.repeat(40);const results=mergeMagnetSearchItems([{torrents:[{name:'one',magnet:`magnet:?xt=urn:btih:${hash}&tr=a`}]},{torrents:[{name:'two',magnet:`magnet:?xt=urn:btih:${hash}&tr=b`}]}]);assert.equal(results.length,1)
 assert.equal(normalizeMagnetSearchItems([{name:'array payload',infohash:hash}]).length,1)
})
test('compiled magnet renderer escapes remote title and magnet HTML',()=>{
 const report=buildMagnetSearchReportData({torrents:[{name:'<script>x</script>',infohash:'b'.repeat(40)}]},{keyword:'<img>'});const view=buildMagnetSearchReportView(report);assert.doesNotMatch(view.rowsHtml,/<script>/);assert.match(view.rowsHtml,/&lt;script&gt;/);assert.match(view.title,/&lt;img&gt;/)
})
test('compiled Bilibili auth command enforces master permission before host calls',async()=>{
 let invoked=0;class Plugin{constructor(options){this.options=options}}class Auth{status(){invoked++;return {authorized:false}}}
 const Handler=createBilibiliRelayPlugin(Plugin,{assertSoleResponsible:async()=>{invoked++;return true},BilibiliAuthManager:Auth,getBot:()=>null,segmentApi:{},logger:{warn(){},error(){}}});const handler=new Handler();assert.equal(await handler.bilibiliAuth({msg:'.B站授权状态',reply:async()=>{invoked++}}),false);assert.equal(invoked,0)
 assert.ok(new RegExp(handler.options.rule[0].reg).test('.B站授权状态   '))
})
test('compiled Modrinth discards failed cache entry and retries a later request',async()=>{
 let calls=0;const client=new ModrinthClient({fetchImpl:async()=>{calls++;return calls===1?new Response('{}',{status:503}):new Response('{"hits":[]}')}});await assert.rejects(client.search(),/503/);assert.deepEqual(await client.search(),{hits:[]});assert.equal(calls,2)
})
