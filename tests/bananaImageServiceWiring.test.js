import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('real BananaTool entry executes compiled image service with only host modules stubbed', () => {
 const script = `
 import { registerHooks } from 'node:module';
 import assert from 'node:assert/strict';
 import sharp from 'sharp';
 registerHooks({resolve(specifier,context,next){
   if (/lib\\/(config\\/config|puppeteer\\/puppeteer|common\\/common)\\.js$/.test(specifier)) return {url:'data:text/javascript,export default {}',shortCircuit:true};
   return next(specifier,context);
 }});
 const png = await sharp({create:{width:9,height:16,channels:3,background:'red'}}).png().toBuffer();
 let calls=0;
 globalThis.fetch=async (_url,options)=>{calls++; const body=JSON.parse(options.body); assert.equal(body.prompt,'fixture'); return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));};
 const {BananaTool}=await import('./functions/functions_tools/BananaTool.js');
 const tool=new BananaTool();
 const image=await tool.generateImage([{apiUrl:'https://fixture.invalid',apiKey:'fixture',model:'gpt-image-2'}],'fixture');
 assert.equal(calls,1);assert.ok(Buffer.isBuffer(image));assert.deepEqual(image,png);
 assert.equal(tool.isImagesEditEndpoint('https://fixture.invalid/v1/images/edits'),true);
 assert.equal(tool.isImagesEditEndpoint('https://fixture.invalid/v1/chat/completions'),false);
 let delivered;
 tool.loadConfig=()=>({imageGenerationAiConfig:{imageGenerationApiUrl:'https://fixture.invalid',imageGenerationApiKey:'fixture',imageGenerationApiModel:'gpt-image-2'}});
 tool.resolveImageGenerationConfigs=()=>[{apiUrl:'https://fixture.invalid',apiKey:'fixture',model:'gpt-image-2'}];
 tool.resolveImageEditConfigs=()=>[];
 tool.replyImageToRequester=async(_event,value)=>{delivered=value};
 assert.equal(await tool.performDraw({prompt:'fixture'}, {}, {skipProgressNotice:true}),'图片生成成功');
 assert.equal(calls,2);assert.deepEqual(delivered,png);
 console.log('QQ compiled service wiring passed');
 `
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8',timeout:15000})
 assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`)
 assert.match(result.stdout,/QQ compiled service wiring passed/)
})
