import path from 'node:path';import {readFile,mkdir} from 'node:fs/promises';import {randomInt} from 'node:crypto';
import {chromium} from 'playwright';import {DouyinPage,validateProfile} from '../douyin-page.mjs';
import {observeTrustedPublishClick,submitWithReceipt,extractSubmissionId} from '../submission-receipt.mjs';
import {atomicJson} from '../store.mjs';
import {verifiedContinuation,settleWithin} from './verification.mjs';
const normal=v=>String(v).replace(/\s+/g,' ').trim();
export async function preflightLive(c,jobs){
 const ui=JSON.parse(await readFile(c.uiFile,'utf8'));validateProfile(ui,{mode:'task'});
 if(!ui.descriptionInput||/REPLACE_|^(body|html|\*)$/.test(ui.descriptionInput)||!ui.publication||ui.receipt?.kind!=='network')throw Error('v3 真实任务发布需校准描述区、发布设置及网络回执；当前不能发布');
 for(const id of new Set(jobs.map(j=>j.accountId))){const a=c.accounts.find(a=>a.id===id);const auth=JSON.parse(await readFile(path.join(c.authDataDir,'auth',id+'.json'),'utf8'));
  if(!auth.identityVerified||auth.accountId!==id||auth.expectedIdentity!==a.expectedIdentity||!auth.storageState)throw Error(`账号 ${id} 需要登录并核对身份`);}
 return ui;
}
export async function openLive(c,account,onPhase=()=>{},services={}){
 const ui=await preflightLive(c,[{accountId:account.id}]);const auth=JSON.parse(await readFile(path.join(c.authDataDir,'auth',account.id+'.json'),'utf8'));
 const browser=await (services.launch??(options=>chromium.launch(options)))({headless:false,channel:'chromium'});let keepOpen=false;
 try{
 const context=await browser.newContext({storageState:auth.storageState,locale:'zh-CN',serviceWorkers:'block',viewport:{width:1440,height:1000}});
 const page=await context.newPage();const adapter=new DouyinPage(page,ui,{...account,mode:'task'});let selectedJob;
 async function screenshot(job,label){const dir=path.join(c.authDataDir,'v3-evidence');await mkdir(dir,{recursive:true});await page.screenshot({path:path.join(dir,job.id+'-'+label+'.png'),fullPage:true}).catch(()=>{});}
 async function form(job){await adapter.verifyForm({...job,mode:'task'});const field=await adapter.unique(page,ui.descriptionInput);const value=await field.evaluate(el=>'value'in el?el.value:el.innerText);if(normal(value)!==normal(job.description))throw Error('文案与标签回读不一致');}
 return{
  async prepare(job){selectedJob=job;await page.goto(ui.uploadUrl,{waitUntil:'domcontentloaded'});await adapter.verifyIdentity();
   if(await page.locator(ui.uploadComplete).isVisible())throw Error('投稿页已有素材，需人工清理');
   await(await adapter.unique(page,ui.uploadInput,{state:'attached'})).setInputFiles(job.path);
   await adapter.unique(page,ui.uploadComplete,{timeout:ui.uploadTimeoutMs});
   await(await adapter.unique(page,ui.titleInput)).fill(job.title);await adapter.fillDescription(job.description);
   await(await adapter.unique(page,ui.taskOpen)).click();const dialog=await adapter.unique(page,ui.taskDialog),available=[];
   for(const task of job.taskCandidates){await(await adapter.unique(dialog,ui.taskSearch)).fill(task.id);
    const row=dialog.locator(ui.taskRow.replaceAll('{taskId}',task.id));
    try{await row.waitFor({state:'visible',timeout:Math.min(ui.timeoutMs,5000)});}catch{continue;}
    if(await row.count()!==1||await adapter.read(row,ui.taskIdentity)!==task.id)continue;
    const control=row.locator(ui.taskSelect);if(await control.count()===1&&await control.isEnabled())available.push(task);
   }
   if(!available.length)return null;const task=available[randomInt(available.length)];
   await(await adapter.unique(dialog,ui.taskSearch)).fill(task.id);const row=await adapter.unique(dialog,ui.taskRow.replaceAll('{taskId}',task.id));
   if(await adapter.read(row,ui.taskIdentity)!==task.id)throw Error('选中任务身份变化');const control=await adapter.unique(row,ui.taskSelect);await control.click();
   if(!await control.evaluate(el=>el.matches(':checked')||el.getAttribute('aria-checked')==='true'))throw Error('任务未选中');
   await(await adapter.unique(dialog,ui.taskConfirm)).click();await dialog.waitFor({state:'hidden'});
   await form({...job,taskId:task.id,taskName:task.name});await screenshot(job,'ready');return task;
  },
  async publish(job){await form(job);const button=await adapter.unique(page,ui.publishButton);const observation=await observeTrustedPublishClick(page,button);
   // Empty response + identity challenge must not cause a second publish click.
   // Observe late successful page-generated responses during the manual-verification grace period.
   const receipts=[],requests=new Set(),pending=[];let verificationSeen=false;
   const requestListener=r=>{try{if(r.method()==='POST'&&r.frame()===page.mainFrame()&&new URL(r.url()).origin===new URL(ui.receipt.url).origin&&new URL(r.url()).pathname===new URL(ui.receipt.url).pathname)requests.add(r);}catch{}};
   const listener=response=>{const r=response.request();if(r.method()!=='POST'||r.frame()!==page.mainFrame()||new URL(response.url()).origin!==new URL(ui.receipt.url).origin||new URL(response.url()).pathname!==new URL(ui.receipt.url).pathname)return;
    pending.push((async()=>{try{const clickAt=await observation.time;if(r.timing().startTime<clickAt||!Number.isFinite(clickAt))return;const body=await response.json();if(response.status()===200)receipts.push({platformId:extractSubmissionId(body),receiptEvidence:{source:'page-network-after-verification',at:new Date().toISOString()}});}catch{}})());};
   page.on('request',requestListener);
   page.on('response',listener);
   try{return await submitWithReceipt(page,ui.receipt,()=>button.click({timeout:ui.timeoutMs}),{timeoutMs:ui.timeoutMs,clickTime:observation.time});}
   catch(error){onPhase('WAITING_VERIFICATION');keepOpen=true;await screenshot(job,'verification');
    const deadline=Date.now()+120000;while(Date.now()<deadline&&!page.isClosed()){
     verificationSeen ||= /为确保是本人|短信验证码|使用原设备扫码/.test(await page.locator('body').innerText().catch(()=>''));
     if(!await settleWithin([...pending],500))continue;const receipt=verifiedContinuation({error:error.message,verificationSeen,requestCount:requests.size,receipts});
     if(receipt){keepOpen=false;return receipt;}await new Promise(r=>setTimeout(r,1000));}
    throw Error('结果待核实，已保留浏览器；核对作品编号后在工作台登记。'+error.message);
   }finally{page.off('request',requestListener);page.off('response',listener);await observation.dispose();await screenshot(job,'result');}
  },
  async close(){if(!keepOpen)await browser.close();else{onPhase('MANUAL_RECONCILIATION');const dir=path.join(c.authDataDir,'v3-evidence');await mkdir(dir,{recursive:true});await atomicJson(path.join(dir,selectedJob.id+'-manual.json'),{accountId:account.id,jobId:selectedJob.id,note:'Browser retained for manual verification; no second click performed.'});}}
 };
 }catch(error){await browser.close();throw error;}
}
