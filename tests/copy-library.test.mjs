import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan} from '../src/planner.mjs';
import {normalizeCopies,loadCopyLibrary} from '../src/copy-library.mjs';
test('validates enabled copies, preserving hashtags and rejecting ambiguous IDs',()=>{
  assert.deepEqual(normalizeCopies([['文案编号','文案内容','是否启用'],['001','正文 #牙膏 #生活','是'],['002','','否']]),[{id:'001',text:'正文 #牙膏 #生活',enabled:true}]);
  assert.throws(()=>normalizeCopies([['文案编号','文案内容','是否启用'],['1','','是']]),/文案/);
  assert.throws(()=>normalizeCopies([['文案编号','文案内容','是否启用'],['1','a','是'],['1','b','是']]),/编号/);
  assert.throws(()=>normalizeCopies([['文案编号','文案内容','是否启用'],['1','a','也许']]),/启用/);
});
test('reads actual twenty-row workbook and preserves all 3–5 hashtags',async()=>{
 const rows=await loadCopyLibrary('tests/fixtures/copy-library.xlsx');
 assert.equal(rows.length,20);assert.ok(rows.every(r=>{const n=r.text.match(/#[^\s#]+/g).length;return n>=3&&n<=5;}));
});
test('planning fixes selected copy and tag without mutating earlier jobs',()=>{
 const a={id:'a',mode:'ordinary',expectedIdentity:'123',titleTemplate:'{filename}',tasks:[]};
 const config={accounts:[a],dailyTarget:1,maxAttemptsPerDay:1,copies:[{id:'c1',text:'完整文案 #牙膏',enabled:true}]};
 const args={config,date:'2026-09-17',jobs:[],materialsByAccount:{a:[{path:'fzq_A_2_KOC1.mp4',hash:'new'}]}};
 const jobs=buildPlan(args).jobs;assert.equal(jobs[0].description,'完整文案\n#牙膏\nfzq_A_2');assert.equal(jobs[0].copyId,'c1');assert.equal(jobs[0].title,'');
 const snapshot=structuredClone(jobs);assert.equal(buildPlan({...args,jobs}).jobs.length,0);assert.deepEqual(jobs,snapshot);
});
test('topics are contiguous and internal marker is plain final line',async()=>{
 const {chooseCopy}=await import('../src/copy-library.mjs');
 assert.equal(chooseCopy([{id:'1',enabled:true,text:'这一段先替你录下来，有空的时候一起听听。\n#牙膏 #生活碎片 #好好生活'}],'fzq_A_3_KOC1.mp4').description,'这一段先替你录下来，有空的时候一起听听。\n#牙膏#生活碎片#好好生活\nfzq_A_3');
});
