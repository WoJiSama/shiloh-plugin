import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {SealExtRuntime} from '../dist/backend/modules/dice/infrastructure/SealExtRuntime.js'
import {DeckManager} from '../dist/backend/modules/dice/infrastructure/DeckManager.js'
import {createDiceLogRecorder} from '../dist/backend/modules/dice/infrastructure/logRecorder.js'
test('compiled extension validates persisted primitive state and supports async solve',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'seal-compiled-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.json');fs.writeFileSync(file,'42');const runtime=new SealExtRuntime({statePath:file});assert.deepEqual(runtime.storage,{});runtime.run(`const ext=seal.ext.new('test','a','1');seal.ext.register(ext);const cmd=seal.ext.newCmdItemInfo();cmd.solve=async(ctx,msg)=>{await Promise.resolve();seal.replyToSender(ctx,msg,'ok');return {solved:true}};ext.cmdMap.test=cmd;`);const result=await runtime.dispatch('test',{userId:'1'});assert.equal(result.solved,true);assert.equal(result.replies[0].text,'ok')})
test('compiled deck rejects primitive records and preserves hidden nested groups',()=>{const deck=new DeckManager({decksDir:'/unused'});assert.equal(deck.normalizeDeck('bad'),null);const normalized=deck.normalizeDeck({_name:['test'],public:['{_hidden}'],_hidden:['answer']},'deck.json');deck.decks=[normalized];deck.loadedAt=Date.now();assert.equal(deck.draw('public').text,'answer');assert.match(deck.draw('_hidden').error,/不存在/)})
test('compiled log recorder observes background rejection without consuming message',async()=>{const warnings=[];class Plugin{constructor(){}}const Recorder=createDiceLogRecorder(Plugin,{recordLogMessage:async()=>{throw new Error('disk failed')},warn:message=>warnings.push(message)});assert.equal(await new Recorder().recordDiceLog({}),false);await Promise.resolve();assert.match(warnings[0],/disk failed/)})
test('compiled seal concurrent dispatch keeps replies and temporary variables local',async()=>{
  const runtime=new SealExtRuntime();runtime.run(`const e=seal.ext.new('isolation','a','1');seal.ext.register(e);e.cmdMap.test=seal.ext.newCmdItemInfo();e.cmdMap.test.solve=()=>({solved:true})`)
  const command=runtime.findCommand('test');const api=runtime.buildSealApi();let release;const blocked=new Promise(resolve=>{release=resolve})
  command.solve=async(ctx,msg)=>{api.vars.strSet(ctx,'$tvalue',ctx.player.name);if(ctx.player.name==='first')await blocked;api.replyToSender(ctx,msg,api.vars.strGet(ctx,'$tvalue')[0]);return {solved:true}}
  const first=runtime.dispatch('test',{userId:'1',userName:'first'});const second=await runtime.dispatch('test',{userId:'1',userName:'second'});release();const result=await first
  assert.deepEqual(second.replies.map(r=>r.text),['second']);assert.deepEqual(result.replies.map(r=>r.text),['first'])
})
test('compiled seal ignores late replies and temporary writes after solve timeout',async()=>{
  const runtime=new SealExtRuntime();runtime.run(`const e=seal.ext.new('late','a','1');seal.ext.register(e);e.cmdMap.test=seal.ext.newCmdItemInfo();e.cmdMap.test.solve=()=>({solved:true})`)
  const command=runtime.findCommand('test');const api=runtime.buildSealApi();let release;const blocked=new Promise(resolve=>{release=resolve})
  command.solve=async(ctx,msg)=>{await blocked;api.replyToSender(ctx,msg,'late');api.vars.strSet(ctx,'$tvalue','late');return {solved:true}}
  const expired=await runtime.dispatch('test',{userId:'1'});assert.match(expired.error,/超时/);release();await Promise.resolve();await Promise.resolve()
  command.solve=(ctx,msg)=>{api.replyToSender(ctx,msg,'fresh');return {solved:true}}
  const result=await runtime.dispatch('test',{userId:'1'});assert.deepEqual(result.replies.map(r=>r.text),['fresh'])
})
