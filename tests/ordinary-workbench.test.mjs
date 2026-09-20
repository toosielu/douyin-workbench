import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, utimes, copyFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {OrdinaryWorkbench} from '../src/ordinary-workbench.mjs';

async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'ordinary-web-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const materials=path.join(dir,'materials'); await mkdir(materials);
  await writeFile(path.join(materials,'fzq_A_1_KOC1.mp4'),'fixture video');
  await utimes(path.join(materials,'fzq_A_1_KOC1.mp4'),new Date(0),new Date(0));
  const config={dataDir:path.join(dir,'data'),uiFile:path.join(dir,'ui.json'),copyFile:path.join(dir,'copy.xlsx'),dailyTarget:9,maxAttemptsPerDay:20,minFileAgeSeconds:0,intervalSeconds:0,accounts:[{id:'a',expectedIdentity:'123',mode:'ordinary',materialDir:materials,titleTemplate:'{filename}',tasks:[]}]};
  const file=path.join(dir,'config.json'); await writeFile(file,JSON.stringify(config));
  await writeFile(config.uiFile,'{}');
  const dependencies={loadConfig:async()=>({...config,copies:[{id:'1',text:'测试正文 #牙膏 #生活',enabled:true}]}),loadProfile:async()=>({}),assertAuth:async()=>{},openAccount:async()=>({prepare:async()=>{},publish:async()=>({status:'PENDING_REVIEW',platformId:'999'}),close:async()=>{}})};
  return {service:new OrdinaryWorkbench(file,dependencies),config,dir};
}

test('whenIdle waits for an in-flight configuration operation before exit',async t=>{
  const {service}=await fixture(t);let release,ended=false;
  const operation=service.exclusive(()=>new Promise(resolve=>{release=resolve;}));
  const idle=service.whenIdle().then(()=>{ended=true;});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(ended,false);
  release();await operation;await idle;assert.equal(ended,true);
});

test('AI preview requires consent, keeps publish explicit and drops old preview on failure',async t=>{
 const {service}=await fixture(t);let called=0;
 service.deps.planWithModel=async({jobs})=>{called++;return {jobs:jobs.map(j=>({...j,aiReason:'已匹配'})),summary:'AI 已完成选择'};};
 await assert.rejects(service.aiPreview({instruction:'选择全部'}),/同意/);assert.equal(called,0);
 const p=await service.aiPreview({instruction:'选择全部',consent:true});assert.equal(p.jobs.length,1);assert.equal(p.jobs[0].aiReason,'已匹配');
 assert.equal((await service.getState()).records.length,0);
 await assert.rejects(service.start({digest:p.digest,simulation:false}),/确认/);
 service.deps.planWithModel=async()=>{throw Error('model failed');};
 await assert.rejects(service.aiPreview({instruction:'选择全部',consent:true}),/model failed/);
 assert.equal(service.pending,null);assert.equal(service.busy,false);
});
test('preview is read-only, pins copy, requires explicit confirmation, publishes and archives once',async t=>{
  const {service,config}=await fixture(t);
  const p=await service.preview(); assert.equal(p.jobs.length,1); assert.match(p.jobs[0].description,/测试正文\n#牙膏#生活\nfzq_A_1/);
  await assert.rejects(readFile(path.join(config.dataDir,'ledger.json')),/ENOENT/);
  await assert.rejects(service.start({digest:p.digest,simulation:false}),/确认/);
  await service.start({digest:p.digest,simulation:false,confirmRemoteWrite:true}); await service.whenIdle();
  const s=await service.getState(); assert.equal(s.run.phase,'DONE'); assert.equal(s.records[0].platformId,'999'); assert.equal(s.records[0].archive.archiveStatus,'DONE');
  assert.equal((await service.preview()).jobs.length,0);
});
test('changed ledger invalidates preview before any upload',async t=>{
  const {service,config}=await fixture(t); const p=await service.preview();
  await mkdir(config.dataDir,{recursive:true}); await writeFile(path.join(config.dataDir,'ledger.json'),JSON.stringify({version:1,jobs:[],revision:2}));
  await assert.rejects(service.start({digest:p.digest,simulation:false,confirmRemoteWrite:true}),/变化/);
});
test('changed material prevents publication and reservation',async t=>{
  const {service,config}=await fixture(t); const p=await service.preview();
  await writeFile(path.join(config.accounts[0].materialDir,'fzq_A_1_KOC1.mp4'),'different');
  await assert.rejects(service.start({digest:p.digest,simulation:false,confirmRemoteWrite:true}),/hash/);
  assert.equal((await service.getState()).records.length,0);
});
test('stop finishes current item, cancels only unstarted reservations',async t=>{
  const {service,config}=await fixture(t);
  await writeFile(path.join(config.accounts[0].materialDir,'fzq_A_2_KOC1.mp4'),'second video');
  await utimes(path.join(config.accounts[0].materialDir,'fzq_A_2_KOC1.mp4'),new Date(0),new Date(0));
  let count=0;service.deps.openAccount=async()=>({prepare:async()=>{},publish:async()=>{count++;service.stop();return {status:'PENDING_REVIEW',platformId:'888'};},close:async()=>{}});
  const p=await service.preview();await service.start({digest:p.digest,simulation:false,confirmRemoteWrite:true});await service.whenIdle();
  assert.equal(count,1);const s=await service.getState();assert.equal(s.records.filter(j=>j.status==='CANCELLED').length,1);assert.equal((await service.preview()).jobs.length,1);
});
test('missing login blocks reservation; ambiguous receipt blocks retry',async t=>{
  const {service}=await fixture(t);let p=await service.preview();
  service.deps.assertAuth=async()=>{throw Error('登录失效');};
  await assert.rejects(service.start({digest:p.digest,simulation:false,confirmRemoteWrite:true}),/登录失效/);
  assert.equal((await service.getState()).records.length,0);
  service.deps.assertAuth=async()=>{};service.deps.openAccount=async()=>({prepare:async()=>{},publish:async()=>{throw Error('超时');},close:async()=>{}});
  p=await service.preview();await service.start({digest:p.digest,simulation:false,confirmRemoteWrite:true});await service.whenIdle();
  assert.equal((await service.getState()).records[0].status,'UNKNOWN');assert.equal((await service.preview()).jobs.length,0);
});
test('UI profile mutation invalidates preview',async t=>{
  const {service,config}=await fixture(t);const p=await service.preview();await writeFile(config.uiFile,'{"changed":true}');
  await assert.rejects(service.start({digest:p.digest,simulation:false,confirmRemoteWrite:true}),/变化/);
});
test('login is exclusive and stopping releases its wait and store lock',async t=>{
  const {service}=await fixture(t);
  service.deps.interactiveBrowser=async(c,a,mode,log,options)=>options.ask();
  await service.login({accountId:'a'});
  await assert.rejects(service.login({accountId:'a'}),/正在执行/);
  service.stop();await service.whenIdle();
  assert.equal((await service.getState()).run.busy,false);
  await service.preview();
});
test('mapped preview excludes other operators, disabled accounts and wrong KOC; shares a material once',async t=>{
  const {service,config}=await fixture(t);
  config.mappingEnabled=true;config.operatorId='op1';
  Object.assign(config.accounts[0],{operatorId:'op1',editor:'fzq',koc:'KOC1',enabled:true});
  const first=config.accounts[0];
  config.accounts.push({...first,id:'b',expectedIdentity:'456'},{...first,id:'c',expectedIdentity:'789',operatorId:'op2'},{...first,id:'d',expectedIdentity:'999',enabled:false});
  const p=await service.preview();assert.equal(p.jobs.length,1);assert.ok(['a','b'].includes(p.jobs[0].accountId));
  config.accounts[0].koc='KOC2';config.accounts[1].koc='KOC2';assert.equal((await service.preview()).jobs.length,0);
  await assert.rejects(service.login({accountId:'c'}),/不属于/);
});
test('save persists account mapping, adds accounts, rejects stale edits and keeps ledger untouched',async t=>{
  const {service,config}=await fixture(t);
  await copyFile(new URL('../tests/fixtures/copy-library.xlsx',import.meta.url),config.copyFile);
  const initial=await service.getState();
  const row={...initial.config.accounts[0],operatorId:'op1',editor:'fzq',koc:'KOC1',enabled:true};
  const input={revision:initial.config.revision,operatorId:'op1',copyFile:config.copyFile,accounts:[row,{...row,id:'',expectedIdentity:'456'}]};
  await service.saveConfig(input);const saved=JSON.parse(await readFile(service.file,'utf8'));
  assert.equal(saved.mappingEnabled,true);assert.equal(saved.accounts.length,2);assert.equal(saved.accounts[0].id,'a');assert.equal(saved.accounts[1].koc,'KOC1');
  await assert.rejects(service.saveConfig(input),/不能移除|已变化/);
  await assert.rejects(readFile(path.join(config.dataDir,'ledger.json')),/ENOENT/);
});
