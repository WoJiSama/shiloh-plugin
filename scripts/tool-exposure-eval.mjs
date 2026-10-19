#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import YAML from 'yaml'
import {run,verifyBackend} from './lib/build-support.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
export async function main(argv=process.argv.slice(2)){
  const args=new Map(),flags=new Set()
  for(let i=0;i<argv.length;i++){const arg=argv[i];if(!arg.startsWith('--'))throw new Error(`未知参数: ${arg}`);if(['--live','--main-model','--summary','--strict','--help'].includes(arg))flags.add(arg);else{if(!['--json','--compare','--scenario','--modes','--config','--fixtures'].includes(arg))throw new Error(`未知参数: ${arg}`);if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`${arg} 缺少值`);args.set(arg,argv[++i])}}
  if(flags.has('--help')){console.log('node scripts/tool-exposure-eval.mjs [--summary] [--strict] [--json path] [--compare before.json] [--scenario id1,id2] [--modes tool,chat,low_confidence,timeout,unavailable,invalid] [--live] [--main-model] [--config config/message.yaml]\n默认校验源文件/编译产物，过期时自动构建。--strict 在生成了错误参数/误直调时失败（曝光尚未生成参数仍标为unmeasured）。--live 只请求分类器/规划器，--main-model 另请求主工具模型沙箱；从不执行工具或发送 QQ。');return}
  try{await verifyBackend(undefined,{source:true})}catch{console.log('后端产物缺失或过期，正在构建当前源码…');run(process.execPath,['scripts/backend-build.mjs'])}
  const api=await import('../dist/backend/scripts/toolExposureEval.js')
  const fixture=api.readExposureFixture(args.get('--fixtures')||path.join(root,'tests/fixtures/toolIntentScenarios.json'))
  const scenarioIds=args.get('--scenario')?.split(',').filter(Boolean)
  if(scenarioIds?.some(id=>!fixture.scenarios.some(item=>item.id===id)))throw new Error('包含未知场景 id')
  const modes=args.get('--modes')?.split(',')||api.MODEL_REPLAYS
  if(modes.some(mode=>!api.MODEL_REPLAYS.includes(mode)))throw new Error('未知模型分支；请使用 --help 中的 modes')
  const report=await api.evaluateToolExposure(fixture,{modes,scenarioIds})
  const sha=value=>createHash('sha256').update(value).digest('hex')
  const manifest=await fs.readFile(path.join(root,'dist/backend/manifest.json'))
  const fixtureFile=path.resolve(root,args.get('--fixtures')||'tests/fixtures/toolIntentScenarios.json')
  report.provenance={runtime:'current compiled source',manifestSha256:sha(manifest),sourcesSha256:sha(JSON.stringify(JSON.parse(manifest).sources)),fixtureSha256:sha(await fs.readFile(fixtureFile)),evaluatorSha256:sha(await fs.readFile(path.join(root,'src/scripts/toolExposureEval.ts')))}
  console.log(api.formatExposureReport(report,{details:!flags.has('--summary')}))
  if(flags.has('--main-model')&&!flags.has('--live'))throw new Error('--main-model 需要同时传 --live')
  if(flags.has('--live')){
    let config={}
    try{const parsed=YAML.parse(await fs.readFile(path.resolve(root,args.get('--config')||'config/message.yaml'),'utf8'))||{};config=parsed.pluginSettings||parsed}catch(error){if(error.code!=='ENOENT')throw new Error('无法解析评测配置（未输出配置内容）');console.log('live 配置文件不存在，模型阶段将明确标记 skipped。')}
    report.live=await api.runLiveExposure(fixture,config,{scenarioIds,mainModel:flags.has('--main-model')})
    for(const row of report.live.observations)console.log(`LIVE ${row.id} ${row.models.map(model=>`${model.stage}:${model.status} model=${model.model||'-'} ${model.ms}ms ${model.outputKind}${model.reason?` (${model.reason})`:''}`).join(' | ')}`)
  }
  if(args.has('--compare')){
    const before=JSON.parse(await fs.readFile(path.resolve(root,args.get('--compare')),'utf8'))
    if(!before.provenance?.fixtureSha256||before.provenance.fixtureSha256!==report.provenance.fixtureSha256)throw new Error('before与当前场景库hash不同；请使用同一fixture重新生成基线后比较')
    if(!before.provenance?.evaluatorSha256||before.provenance.evaluatorSha256!==report.provenance.evaluatorSha256)throw new Error('before与当前评测器hash不同；请在冻结的业务快照上用同一评测器重新生成基线')
    const stats=rows=>{const positive=rows.filter(row=>row.expectedAction==='tool');return {reached:positive.filter(row=>row.routingSuccess).length,total:positive.length,unsafeDirect:rows.filter(row=>row.unsafeDirectCall).length}}
    console.log('\n同场景对比（分支不能混作正常准确率）:')
    for(const mode of modes){const ids=new Set(report.rows.filter(row=>row.modelReplay===mode).map(row=>row.id));const old=stats(before.rows.filter(row=>row.modelReplay===mode&&ids.has(row.id))),now=stats(report.rows.filter(row=>row.modelReplay===mode));console.log(`${mode}: before=${old.reached}/${old.total} after=${now.reached}/${now.total} negative-direct=${old.unsafeDirect}→${now.unsafeDirect}`)}
  }
  if(args.has('--json')){const output=path.resolve(root,args.get('--json'));await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(`已写入 ${output}`)}
  if(flags.has('--strict')){const failures=report.rows.filter(row=>row.parameterStatus==='fail'||row.unsafeDirectCall);if(failures.length)throw new Error(`严格参数/误直调验收失败: ${failures.map(row=>`${row.id}/${row.modelReplay}`).join(', ')}`)}
  return report
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){main().catch(error=>{console.error(error.message);process.exitCode=1})}
