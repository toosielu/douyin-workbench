import test from 'node:test';
import assert from 'node:assert/strict';
import {planWithModel, validateSelection} from '../src/ai-planner.mjs';
const jobs=[{id:'j1',path:'D:/private/fzq_A_1_KOC1.mp4',accountId:'secret-account',expectedIdentity:'123456',description:'old'}];
const copies=[{id:'c1',text:'今天的记录 #生活',enabled:true}];
test('valid selection rebuilds description and preserves trusted account',()=>{
 const result=validateSelection({summary:'已选择',selections:[{jobId:'j1',copyId:'c1',reason:'符合要求'}]},jobs,copies);
 assert.equal(result.jobs[0].accountId,'secret-account');assert.equal(result.jobs[0].description,'今天的记录\n#生活\nfzq_A_1');
});
test('rejects unknown, duplicate, disabled selections and injected fields',()=>{
 for(const selections of [[{jobId:'bad',copyId:'c1'}],[{jobId:'j1',copyId:'bad'}],[{jobId:'j1',copyId:'c1'},{jobId:'j1',copyId:'c1'}],[{jobId:'j1',copyId:'c1',accountId:'other'}]])assert.throws(()=>validateSelection({summary:'x',selections:selections.map(r=>({...r,reason:'test'}))},jobs,copies));
 assert.throws(()=>validateSelection({summary:'x',selections:[{jobId:'j1',copyId:'c1',reason:'test'}]},jobs,[{...copies[0],enabled:false}]));
});
test('model receives minimized context and never secrets or paths',async()=>{
 let body;const result=await planWithModel({instruction:'选生活文案',jobs,copies,settings:{url:'https://example.com/v1/chat/completions',model:'test',key:'secret'},fetchImpl:async(url,opts)=>{body=opts.body;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'完成',selections:[{jobId:'j1',copyId:'c1',reason:'生活'}]})}}]}));}});
 assert.equal(result.jobs.length,1);for(const value of ['D:/private','secret-account','123456','secret'])assert.equal(body.includes(value),false);
});
test('missing settings and redirects are rejected',async()=>{
 await assert.rejects(()=>planWithModel({instruction:'x',jobs,copies,settings:{}}),/配置/);
 await assert.rejects(()=>planWithModel({instruction:'x',jobs,copies,settings:{url:'http://example.com/api',model:'test',key:'x'}}),/HTTPS/);
 await assert.rejects(()=>planWithModel({instruction:'x',jobs,copies,settings:{url:'https://example.com/api',model:'test',key:'x'},fetchImpl:async()=>new Response('',{status:302})}),/302/);
});
