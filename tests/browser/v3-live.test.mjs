import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {chromium} from 'playwright';import {openLive,preflightLive} from '../../src/v3/live.mjs';
const origin='https://creator.douyin.com';
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'v3-live-'));await mkdir(path.join(root,'auth'));
 await writeFile(path.join(root,'auth','a.json'),JSON.stringify({accountId:'a',expectedIdentity:'123',identityVerified:true,storageState:{cookies:[],origins:[]}}));
 const ui={evidence:'live_verified',uploadUrl:origin+'/upload',timeoutMs:300,uploadTimeoutMs:2000,
 identity:{url:origin+'/home',selector:'#identity'},uploadInput:'#upload',uploadComplete:'#complete',titleInput:'#title',descriptionInput:'#description',
 taskOpen:'#open',taskDialog:'#dialog',taskSearch:'#search',taskRow:'[data-task="{taskId}"]',taskIdentity:{selector:'.id'},taskSelect:'input',taskConfirm:'#confirm',selectedTask:{selector:'#bound'},
 publishButton:'#publish',publication:{visibilityLabel:'公开',scheduleLabel:'立即发布',crossPostLabel:'不同时发布'},receipt:{kind:'network',url:origin+'/create'}};
 const file=path.join(root,'clip.mp4');await writeFile(file,'local fixture');const uiFile=path.join(root,'ui.json');await writeFile(uiFile,JSON.stringify(ui));
 const account={id:'a',expectedIdentity:'123',mode:'task'},c={authDataDir:root,uiFile,accounts:[account]};let publishes=0,description;
 const browser=await chromium.launch({headless:true,channel:'chromium'});t.after(()=>browser.close());
 const wrapper={newContext:async options=>{const context=await browser.newContext(options);
  await context.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();
   if(u.pathname==='/home')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<div id="identity">123</div>'});
   if(u.pathname==='/create'){publishes++;return route.fulfill({contentType:'application/json',body:JSON.stringify({status_code:0,data:{item_id:'7686206594555727139'}})});}
   if(u.pathname!=='/upload')return route.abort();
   return route.fulfill({contentType:'text/html; charset=utf-8',body:`<input type="file" id="upload"><span id="complete" hidden>完成</span><input id="title"><textarea id="description"></textarea>
    <button id="open">任务</button><div id="dialog" hidden><input id="search"><div data-task="t2"><span class="id">t2</span><input type="radio"></div><button id="confirm">确认</button></div><span id="bound"></span>
    <label><input type="checkbox" checked>公开</label><label><input type="checkbox" checked>立即发布</label><label><input type="checkbox" checked>不同时发布</label><button id="publish">发布</button>
    <script>document.querySelector('#upload').onchange=()=>document.querySelector('#complete').hidden=false;
    document.querySelector('#open').onclick=()=>document.querySelector('#dialog').hidden=false;
    document.querySelector('#confirm').onclick=()=>{document.querySelector('#bound').textContent='t2';document.querySelector('#dialog').hidden=true;};
    document.querySelector('#publish').onclick=()=>fetch('/create',{method:'POST'});</script>`});});
  context.on('page',page=>page.on('request',async request=>{if(new URL(request.url()).pathname==='/create')description=await page.locator('#description').inputValue();}));
  return context;},close:()=>browser.close()};
 return{c,account,job:{id:'fixture',path:file,title:'短标题',description:'完整文案\n#fzq_C_3',taskCandidates:[{id:'t1',name:'不可选'},{id:'t2',name:'任务二'}]},services:{launch:async()=>wrapper},publishes:()=>publishes,description:()=>description};
}
test('v3 live adapter chooses only page-available enabled candidates and preserves description',async t=>{
 const f=await fixture(t);const adapter=await openLive(f.c,f.account,()=>{},f.services);const task=await adapter.prepare(f.job);
 assert.equal(task.id,'t2');const result=await adapter.publish({...f.job,taskId:task.id,taskName:task.name});assert.equal(result.platformId,'7686206594555727139');assert.equal(f.publishes(),1);assert.equal(f.description(),f.job.description);await adapter.close();
});
test('v3 profile without calibrated description is blocked before upload',async t=>{
 const f=await fixture(t);await writeFile(f.c.uiFile,JSON.stringify({evidence:'reference_candidates_not_live_verified',uploadUrl:origin+'/upload'}));
 await assert.rejects(preflightLive(f.c,[{accountId:'a'}]),/PROFILE/);assert.equal(f.publishes(),0);
});
