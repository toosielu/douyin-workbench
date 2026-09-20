import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {bootstrapDesktop,shutdownDesktop} from '../src/desktop/bootstrap.mjs';
import {OrdinaryWorkbench} from '../src/ordinary-workbench.mjs';

test('fresh desktop opens empty onboarding without customer data or Python',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'desktop-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=await bootstrapDesktop(root);
  const raw=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(raw.accounts,[]);assert.equal(raw.copyFile,undefined);
  assert.ok(raw.dataDir.startsWith(root));
  const service=new OrdinaryWorkbench(file);
  const state=await service.getState();assert.equal(state.copyCount,0);assert.deepEqual(state.records,[]);
  await assert.rejects(service.preview(),/配置|文案/);
  raw.operatorId='我的运营';await writeFile(file,JSON.stringify(raw));
  assert.equal(await bootstrapDesktop(root),file);
  assert.equal(JSON.parse(await readFile(file,'utf8')).operatorId,'我的运营');
});

test('desktop shutdown stops future jobs then waits before closing server',async()=>{
  const calls=[];let idle;
  const service={stop:()=>calls.push('stop'),whenIdle:()=>new Promise(r=>{idle=r;})};
  const pending=shutdownDesktop(service,{close:async()=>calls.push('close')});
  await Promise.resolve();assert.deepEqual(calls,['stop']);
  idle();await pending;assert.deepEqual(calls,['stop','close']);
});
