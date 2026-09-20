import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, utimes} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {main as cli} from '../src/cli.mjs';
import {runOrdinary} from '../src/ordinary-run.mjs';
import {batchDigest} from '../src/batch.mjs';

async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'ordinary-run-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'clips'));await writeFile(path.join(dir,'clips/test.mp4'),'fixture');
  const readyAt=new Date(Date.now()-5000);await utimes(path.join(dir,'clips/test.mp4'),readyAt,readyAt);
  const configFile=path.join(dir,'config.json');
  const ui={evidence:'live_verified',uploadUrl:'https://creator.douyin.com/creator-micro/content/post/video',timeoutMs:1000,uploadTimeoutMs:1000,
    identity:{selector:'#identity'},uploadInput:'#upload',uploadComplete:'#complete',titleInput:'#title',publishButton:'#publish',
    receipt:{kind:'network',url:'https://creator.douyin.com/web/api/media/aweme/create_v2/'},publication:{visibilityLabel:'公开',scheduleLabel:'立即发布',crossPostLabel:'不同时发布'}};
  await writeFile(path.join(dir,'ui.json'),JSON.stringify(ui));
  const config={dataDir:'./data',uiFile:'./ui.json',dailyTarget:1,maxAttemptsPerDay:1,minFileAgeSeconds:0,intervalSeconds:0,
    accounts:[{id:'a',mode:'ordinary',expectedIdentity:'123',materialDir:'./clips',tasks:[],titleTemplate:'{filename}'}]};
  await writeFile(configFile,JSON.stringify(config));
  return {dir,configFile,config};
}
test('ordinary entry cancellation previews but never invokes live run',async t=>{
  const {configFile}=await fixture(t);const commands=[];const logs=[];
  const result=await runOrdinary(configFile,{ask:async()=> 'no',log:s=>logs.push(s),execute:async args=>{commands.push(args[0]);return cli(args,{log(){}});}});
  assert.equal(result.status,'CANCELLED');assert.deepEqual(commands,['plan']);
  assert.ok(logs.some(s=>s.includes('123')&&s.includes('test')));
});
test('exact confirmation invokes run with a bound batch digest',async t=>{
  const {configFile}=await fixture(t);let command;
  await runOrdinary(configFile,{ask:async()=> 'PUBLISH 1',log(){},execute:async args=>{
    if(args[0]==='run'){command=args;return {outcomes:[]};}return cli(args,{log(){}});
  }});
  assert.ok(command.includes('--confirm-remote-write'));assert.match(command[command.indexOf('--plan-digest')+1],/^[a-f0-9]{64}$/);
});
test('changing the title after confirmation preview stops before browser launch',async t=>{
  const {dir,configFile}=await fixture(t);
  await assert.rejects(runOrdinary(configFile,{log(){},ask:async()=>{
    const file=path.join(dir,'data/ledger.json');const ledger=JSON.parse(await readFile(file));ledger.jobs[0].title='changed';await writeFile(file,JSON.stringify(ledger));return 'PUBLISH 1';
  }}),/批次.*变化|digest/);
});
test('previously published material creates no new job and never prompts',async t=>{
  const {dir,configFile}=await fixture(t);await cli(['plan','--config',configFile],{log(){}});
  const file=path.join(dir,'data/ledger.json');const ledger=JSON.parse(await readFile(file));ledger.jobs[0].status='APPROVED';ledger.jobs[0].platformId='7686179798686731572';await writeFile(file,JSON.stringify(ledger));
  const result=await runOrdinary(configFile,{log(){},ask:async()=>{throw new Error('No prompt for empty batch');}});
  assert.equal(result.status,'EMPTY');assert.equal(JSON.parse(await readFile(file)).jobs.length,1);
});
test('batch digest changes for settings, identity or material changes',()=>{
  const config={accounts:[{expectedIdentity:'123'}]},ui={publication:{visibilityLabel:'公开'}},jobs=[{id:'one',hash:'a',title:'test'}];
  const original=batchDigest(config,jobs,'2026-09-17',ui);
  assert.notEqual(original,batchDigest(config,[{...jobs[0],hash:'b'}],'2026-09-17',ui));
  assert.notEqual(original,batchDigest({accounts:[{expectedIdentity:'456'}]},jobs,'2026-09-17',ui));
  assert.notEqual(original,batchDigest(config,jobs,'2026-09-17',{publication:{visibilityLabel:'私密'}}));
});
