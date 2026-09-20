import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,utimes,access} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {validateConfig,parseFilename,parseImport} from '../../src/v3/config.mjs';
import {scanToday} from '../../src/v3/materials.mjs';
import {Workbench} from '../../src/v3/workbench.mjs';
const date='2026-09-17';
async function setup(){
 const root=await mkdtemp(path.join(os.tmpdir(),'douyin-v3-'));
 const config={mode:'simulation',operatorId:'op1',root,allowNetwork:false,minFileAgeSeconds:0,tagPrefix:'#',
 editors:[{id:'fzq',folder:'editor'}],accounts:[{id:'a',expectedIdentity:'123',operatorId:'op1',koc:'佳佳',editor:'fzq',enabled:true},
 {id:'b',expectedIdentity:'456',operatorId:'op1',koc:'佳佳',editor:'fzq',enabled:true}],
 copies:[{id:'c',text:'今天的好物',enabled:true}],tasks:[{id:'t1',name:'任务1',enabled:true},{id:'disabled',name:'禁用',enabled:false}]};
 const day=path.join(root,'editor',date);await mkdir(day,{recursive:true});
 const file=path.join(day,'fzq_TYPE_3_佳佳.mp4');await writeFile(file,'video-content');await utimes(file,1,1);
 const fileConfig=path.join(root,'config.json');await writeFile(fileConfig,JSON.stringify(config));
 return {root,config,day,file,fileConfig};
}
test('filename, scope and imports reject ambiguous or malformed input',()=>{
 assert.equal(parseFilename('fzq_TYPE_3_佳佳.mp4').tag,'fzq_TYPE_3');
 assert.throws(()=>parseFilename('fzq_C_3_佳_佳.mp4'));
 assert.throws(()=>parseImport('tasks','csv','id,name,enabled\nt1,A,maybe'));
 assert.equal(parseImport('copies','csv','id,text,enabled\nc,"第一行\n第二行",true')[0].text,'第一行\n第二行');
});
test('today only, archive exclusion, global content dedup and operator scope',async()=>{
 const f=await setup();await mkdir(path.join(f.day,'已发_佳佳'));await writeFile(path.join(f.day,'已发_佳佳','fzq_C_4_佳佳.mp4'),'archived');
 await writeFile(path.join(f.day,'fzq_C_4_佳佳.mp4'),'video-content');await utimes(path.join(f.day,'fzq_C_4_佳佳.mp4'),1,1);
 const yesterday=path.join(f.root,'editor','2026-09-16');await mkdir(yesterday);await writeFile(path.join(yesterday,'fzq_C_9_佳佳.mp4'),'old');
 const scan=await scanToday(validateConfig(f.config),date);assert.equal(scan.materials.length,2);
 const w=new Workbench(f.fileConfig,{date:()=>date});const p=await w.preview();assert.equal(p.jobs.length,1);
 assert.match(p.jobs[0].description,/\nfzq_[^\n]+$/);assert.equal(p.jobs[0].title,'');assert.equal(p.jobs[0].taskId,null);
 assert.deepEqual(p.jobs[0].taskCandidates.map(t=>t.id),['t1']);
 assert.ok(p.skipped.some(x=>x.reason==='DUPLICATE_CONTENT'));
});
test('accepted material is used globally and archived; second operator cannot claim again',async()=>{
 const f=await setup();Object.assign(f.config,{mode:'live',authDataDir:f.root,uiFile:path.join(f.root,'ui.json')});await writeFile(f.fileConfig,JSON.stringify(f.config));
 const w=new Workbench(f.fileConfig,{date:()=>date,adapterFactory:async()=>({prepare:async j=>j.taskCandidates[0],publish:async()=>({platformId:'7686206594555727139'}),close:async()=>{}})});const p=await w.preview();
 await w.start({digest:p.digest,simulation:false,confirmRemoteWrite:true});await w.whenIdle();
 const state=await w.getState();assert.equal(state.jobs[0].status,'ACCEPTED');assert.equal(state.jobs[0].archiveStatus,'DONE');
 await assert.rejects(access(f.file));assert.equal(await readFile(path.join(f.day,'已发_佳佳',path.basename(f.file)),'utf8'),'video-content');
 await writeFile(path.join(f.day,'fzq_C_8_佳佳.mp4'),'video-content');await utimes(path.join(f.day,'fzq_C_8_佳佳.mp4'),1,1);
 assert.equal((await w.preview()).jobs.length,0);
});
test('unknown receipt isolates account and cannot be retried or archived',async()=>{
 const f=await setup();f.config.accounts=f.config.accounts.slice(0,1);await writeFile(f.fileConfig,JSON.stringify(f.config));
 await writeFile(path.join(f.day,'fzq_C_4_佳佳.mp4'),'another');await utimes(path.join(f.day,'fzq_C_4_佳佳.mp4'),1,1);
 let publishes=0;const adapterFactory=async()=>({prepare:async j=>j.taskCandidates[0],publish:async()=>{publishes++;throw Error('timeout');},close:async()=>{}});
 const w=new Workbench(f.fileConfig,{date:()=>date,adapterFactory});const p=await w.preview();await w.start({digest:p.digest,simulation:true});await w.whenIdle();
 assert.equal(publishes,1);const s=await w.getState();assert.equal(s.jobs[0].status,'UNKNOWN');
 assert.equal((await w.preview()).jobs.length,0);await assert.rejects(w.retryArchive(s.jobs[0].id));await access(f.file);
});
test('archive conflict does not restore publish eligibility; retry only moves',async()=>{
 const f=await setup();await mkdir(path.join(f.day,'已发_佳佳'));await writeFile(path.join(f.day,'已发_佳佳',path.basename(f.file)),'different');
 Object.assign(f.config,{mode:'live',authDataDir:f.root,uiFile:path.join(f.root,'ui.json')});await writeFile(f.fileConfig,JSON.stringify(f.config));
 let publishes=0;const w=new Workbench(f.fileConfig,{date:()=>date,adapterFactory:async()=>({prepare:async j=>j.taskCandidates[0],publish:async()=>{publishes++;return {platformId:'7686206594555727139'};},close:async()=>{}})});
 const p=await w.preview();await w.start({digest:p.digest,simulation:false,confirmRemoteWrite:true});await w.whenIdle();const s=await w.getState();
 assert.equal(s.jobs[0].materialStatus,'USED');assert.equal(s.jobs[0].archiveStatus,'ERROR');
 assert.equal((await w.preview()).jobs.length,0);await w.retryArchive(s.jobs[0].id);assert.equal(publishes,1);
 assert.equal(await readFile(path.join(f.day,'已发_佳佳',path.basename(f.file)),'utf8'),'different');
});
test('stop finishes current post and stops later jobs; stale digest cannot run',async()=>{
 const f=await setup();await writeFile(path.join(f.day,'fzq_C_4_佳佳.mp4'),'second');await utimes(path.join(f.day,'fzq_C_4_佳佳.mp4'),1,1);
 let w;w=new Workbench(f.fileConfig,{date:()=>date,adapterFactory:async()=>({prepare:async j=>j.taskCandidates[0],publish:async()=>{w.stop();return{platformId:'7686206594555727139'};},close:async()=>{}})});
 const p=await w.preview();await assert.rejects(w.start({digest:'wrong',simulation:true}));
 await w.start({digest:p.digest,simulation:true});await w.whenIdle();const s=await w.getState();assert.equal(s.jobs.filter(j=>j.status==='ACCEPTED').length,1);
 assert.equal((await w.preview()).jobs.length,1);
});

test('concurrent start cannot reset active run and simulation never moves sources',async()=>{
 const f=await setup();let release;const gate=new Promise(r=>release=r);
 const w=new Workbench(f.fileConfig,{date:()=>date,adapterFactory:async()=>({prepare:async j=>{await gate;return j.taskCandidates[0];},publish:async()=>({platformId:'sim-test'}),close:async()=>{}})});
 const p=await w.preview();const first=w.start({digest:p.digest,simulation:true});const second=w.start({digest:p.digest,simulation:true});
 const results=await Promise.allSettled([first,second]);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(w.run.active,true);
 release();await w.whenIdle();await access(f.file);assert.equal((await w.getState()).jobs[0].archiveStatus,'SIMULATED');
});
test('unknown blocks the actual identity even after alias changes, skips release for a future batch',async()=>{
 const f=await setup();f.config.accounts=f.config.accounts.slice(0,1);await writeFile(f.fileConfig,JSON.stringify(f.config));
 let fail=false;const w=new Workbench(f.fileConfig,{date:()=>date,adapterFactory:async()=>({prepare:async j=>fail?j.taskCandidates[0]:null,publish:async()=>{throw Error('unknown');},close:async()=>{}})});
 let p=await w.preview();await w.start({digest:p.digest,simulation:true});await w.whenIdle();p=await w.preview();assert.equal(p.jobs.length,1);
 fail=true;await w.start({digest:p.digest,simulation:true});await w.whenIdle();
 f.config.accounts[0].id='renamed';await w.saveConfig(f.config);
 await writeFile(path.join(f.day,'fzq_C_9_佳佳.mp4'),'new-content');await utimes(path.join(f.day,'fzq_C_9_佳佳.mp4'),1,1);
 assert.equal((await w.preview()).jobs.length,0);
});

test('login claims operation guard before asynchronous config read',async()=>{
 const f=await setup();const w=new Workbench(f.fileConfig,{date:()=>date});let release;
 w.config=()=>new Promise(r=>{release=()=>r(f.config);});
 const login=w.login({accountId:'a'});await assert.rejects(w.start({simulation:true}),/已有/);assert.equal(w.run.active,true);
 release();await assert.rejects(login,/模拟/);assert.equal(w.run.active,false);
});

test('two operators sharing root cannot both reserve the same content',async()=>{
 const f=await setup();const c2=structuredClone(f.config);c2.operatorId='op2';c2.accounts.forEach(a=>{a.operatorId='op2';});
 const secondFile=path.join(f.root,'second.json');await writeFile(secondFile,JSON.stringify(c2));
 let release,publishes=0;const gate=new Promise(r=>release=r);
 const w1=new Workbench(f.fileConfig,{date:()=>date,adapterFactory:async()=>({prepare:async j=>{await gate;return j.taskCandidates[0];},publish:async()=>{publishes++;return{platformId:'sim-one'};},close:async()=>{}})});
 const w2=new Workbench(secondFile,{date:()=>date});const p1=await w1.preview(),p2=await w2.preview();
 await w1.start({digest:p1.digest,simulation:true});await w2.start({digest:p2.digest,simulation:true});
 release();await Promise.all([w1.whenIdle(),w2.whenIdle()]);
 const records=(await w1.readJobs(f.config));assert.equal(records.length,1);assert.equal(records[0].status,'ACCEPTED');
 assert.equal((await w2.preview()).jobs.length,0);
});

test('receipt saved before crash remains used and archive recovery completes existing verified copy',async()=>{
 const f=await setup();Object.assign(f.config,{mode:'live',authDataDir:f.root,uiFile:path.join(f.root,'ui.json')});await writeFile(f.fileConfig,JSON.stringify(f.config));
 const w=new Workbench(f.fileConfig,{date:()=>date});const p=await w.preview();const job=p.jobs[0];
 Object.assign(job,{status:'ACCEPTED',materialStatus:'USED',platformId:'7686206594555727139',archiveStarted:true,archiveTarget:path.join(f.day,'已发_佳佳',job.filename)});
 await mkdir(path.dirname(job.archiveTarget));await writeFile(job.archiveTarget,'video-content');
 await writeFile(path.join(f.root,'.douyin-v3','ledger.json'),JSON.stringify({version:1,jobs:[job]}));
 assert.equal((await w.preview()).jobs.length,0);await w.retryArchive(job.id);
 const result=(await w.getState()).jobs[0];assert.equal(result.archiveStatus,'DONE');await assert.rejects(access(f.file));
 assert.equal(await readFile(job.archiveTarget,'utf8'),'video-content');
});
