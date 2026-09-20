import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {DouyinPage} from '../../src/douyin-page.mjs';
const origin='https://creator.douyin.com';
const createPath='/web/api/media/aweme/create_v2/';
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,channel:'chromium'});});
test.after(async()=>{await browser?.close();});
async function setup(t,options={}) {
  const context=await browser.newContext();t.after(()=>context.close());
  let identity='123';let requests=0;
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin)return route.abort();
    if(url.pathname==='/creator-micro/home') return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><div id="identity">抖音号：${identity}</div>`});
    if(url.pathname===createPath){requests++;return route.fulfill({contentType:'application/json',body:JSON.stringify(options.badReceipt?{status_code:0}:{status_code:0,data:{item_id:'7686179798686731572'}})});}
    if(url.pathname!=='/creator-micro/content/post/video')return route.abort();
    return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8">
      <input id="upload" type="file"><span id="complete" hidden>重新上传</span><input id="title">
      <label><input type="checkbox" ${options.private?'':'checked'}>公开 </label>
      <label><input type="checkbox" checked>立即发布 </label>
      ${options.noCrossPost?'':'<label><input type="checkbox" checked>不同时发布 </label>'}
      <button id="publish">发布</button>
      <script>window.clicks=0;document.querySelector('#upload').onchange=()=>document.querySelector('#complete').hidden=false;
      document.querySelector('#publish').onclick=async()=>{window.clicks++;await fetch('${createPath}',{method:'POST',body:'fixture-only'});};</script>`});
  });
  const ui={evidence:'fixture',uploadUrl:origin+'/creator-micro/content/post/video',timeoutMs:1500,uploadTimeoutMs:1500,
    identity:{url:origin+'/creator-micro/home',selector:'#identity',pattern:'^抖音号：(.+)$'},uploadInput:'#upload',uploadComplete:'#complete',titleInput:'#title',publishButton:'#publish',
    publication:{visibilityLabel:'公开',scheduleLabel:'立即发布',crossPostLabel:'不同时发布'},receipt:{kind:'network',url:origin+createPath}};
  const page=await context.newPage();await page.goto(ui.uploadUrl);
  if(options.allowAbsent) ui.crossPostUnavailableAccounts=['123'];
  const adapter=new DouyinPage(page,ui,{id:'a',expectedIdentity:'123',mode:'ordinary'},{fixture:true});
  return {page,context,adapter,setIdentity:value=>{identity=value;},requests:()=>requests};
}
const job={id:'j',mode:'ordinary',taskId:null,taskName:null,title:'test1',path:{name:'test1.mp4',mimeType:'video/mp4',buffer:Buffer.from('fixture video')}};
test('network ordinary flow preserves editor, handles label whitespace and clicks once',async t=>{
  const {page,context,adapter,requests}=await setup(t);
  await adapter.prepare(job);
  const result=await adapter.publish(job);
  assert.equal(result.platformId,'7686179798686731572');assert.equal(result.status,'PENDING_REVIEW');
  assert.equal(await page.locator('#title').inputValue(),'test1');assert.equal(await page.evaluate(()=>window.clicks),1);
  assert.equal(context.pages().length,1);assert.equal(requests(),1);
});
test('account switch between prepare and publish stops before creation',async t=>{
  const {adapter,page,setIdentity,requests}=await setup(t);await adapter.prepare(job);setIdentity('456');
  await assert.rejects(adapter.publish(job),/identity/);
  assert.equal(await page.evaluate(()=>window.clicks),0);assert.equal(requests(),0);
});
test('wrong visibility and missing creation ID never become successful publication',async t=>{
  const privateCase=await setup(t,{private:true});await assert.rejects(privateCase.adapter.prepare(job),/发布设置/);assert.equal(privateCase.requests(),0);
  const noId=await setup(t,{badReceipt:true});await noId.adapter.prepare(job);await assert.rejects(noId.adapter.publish(job),/receipt|回执/);assert.equal(noId.requests(),1);
});

test('observed account without cross-post controls is supported only when explicitly scoped',async t=>{
  const allowed=await setup(t,{noCrossPost:true,allowAbsent:true});await allowed.adapter.prepare(job);
  assert.equal((await allowed.adapter.publish(job)).status,'PENDING_REVIEW');
  const denied=await setup(t,{noCrossPost:true});await assert.rejects(denied.adapter.prepare(job),/发布设置/);
  const changed=await setup(t,{noCrossPost:true,allowAbsent:true});
  await changed.page.locator('body').evaluate(el=>el.insertAdjacentHTML('beforeend','<label><input type="checkbox" checked>同时发布到其他平台</label>'));
  await assert.rejects(changed.adapter.prepare(job),/发布设置/);
});
