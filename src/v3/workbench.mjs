import path from 'node:path';import {readFile,mkdir,lstat} from 'node:fs/promises';
import {randomInt,randomUUID,createHash} from 'node:crypto';
import {atomicJson,withStore} from '../store.mjs';import {businessDate} from '../config.mjs';
import {formatDescription} from '../copy-library.mjs';
import {validateConfig,parseImport} from './config.mjs';import {scanToday,inspect,archive,noLinks} from './materials.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const blocked=new Set(['RUNNING','SUBMITTING','UNKNOWN']);
const history=(job,status,detail={})=>{job.history??=[];job.history.push({at:new Date().toISOString(),from:job.status,to:status,...detail});Object.assign(job,detail,{status});};
export class Workbench{
 constructor(configFile,services={}){this.configFile=path.resolve(configFile);this.services=services;this.date=services.date??businessDate;this.run={active:false,phase:'IDLE',current:null,stopRequested:false};this.previewData=null;}
 async config(){return validateConfig(JSON.parse(await readFile(this.configFile,'utf8')));}
 async coordinator(c){await noLinks(c.root);const dir=path.join(c.root,c.mode==='simulation'?'.douyin-v3-simulation':'.douyin-v3');await mkdir(dir,{recursive:true});await noLinks(dir);for(const name of ['ledger.json','run.lock']){try{if((await lstat(path.join(dir,name))).isSymbolicLink())throw Error('台账不得为链接');}catch(e){if(e.code!=='ENOENT')throw e;}}return dir;}
 async readJobs(c){const dir=await this.coordinator(c);try{const s=JSON.parse(await readFile(path.join(dir,'ledger.json'),'utf8'));if(s.version!==1||!Array.isArray(s.jobs)||s.jobs.some(j=>!j.v3))throw Error('台账格式不兼容');return s.jobs;}catch(e){if(e.code==='ENOENT')return[];throw e;}}
 async getState(){const config=await this.config();const jobs=await this.readJobs(config);return{config,run:{...this.run},jobs:jobs.filter(j=>j.operatorId===config.operatorId),preview:this.previewData};}
 async saveConfig(raw){if(this.run.active)throw Error('执行期间不能修改配置');const config=validateConfig(raw);await atomicJson(this.configFile,config);this.previewData=null;return{config};}
 async importPreview({kind,format,text}){const config=await this.config();config[kind]=parseImport(kind,format,text);return{config:validateConfig(config),summary:`校验通过：${kind} ${config[kind].length} 条。保存后生效。`};}
 async preview(){
  if(this.run.active)throw Error('正在执行，不能重新扫描');const c=await this.config(),date=this.date(),existing=await this.readJobs(c);
  const {materials,skipped}=await scanToday(c,date);const used=new Set(existing.filter(j=>!['CANCELLED','SKIPPED'].includes(j.status)).map(j=>j.hash));
  const blockedAccounts=new Set(existing.filter(j=>blocked.has(j.status)).map(j=>j.expectedIdentity));
  const jobs=[];const copies=c.copies.filter(v=>v.enabled),taskCandidates=c.tasks.filter(t=>t.enabled).map(({id,name})=>({id,name}));
  for(const m of materials){let reason;const accounts=c.accounts.filter(a=>a.enabled&&a.operatorId===c.operatorId&&a.koc===m.koc&&a.editor===m.editor&&!blockedAccounts.has(a.expectedIdentity));
   if(used.has(m.hash))reason='DUPLICATE_CONTENT';else if(!accounts.length)reason='NO_OWNED_AVAILABLE_ACCOUNT';else if(!copies.length)reason='NO_ENABLED_COPY';else if(!taskCandidates.length)reason='NO_ENABLED_TASK';
   if(reason){skipped.push({path:m.path,reason});continue;}
   const a=accounts[randomInt(accounts.length)],copy=copies[randomInt(copies.length)],description=formatDescription(copy.text,m.tag);
   if(Array.from(description).length>1000){skipped.push({path:m.path,reason:'DESCRIPTION_TOO_LONG'});continue;}
   used.add(m.hash);jobs.push({...m,id:randomUUID(),v3:true,operatorId:c.operatorId,date,accountId:a.id,expectedIdentity:a.expectedIdentity,
    title:'',description,copyId:copy.id,taskCandidates,taskId:null,taskName:null,
    status:'READY',materialStatus:'RESERVED',archiveStatus:'NONE',simulation:c.mode==='simulation'});
  }
  this.previewConfig=digest(c);this.previewLedger=digest(existing);
  this.previewData={date,jobs,skipped,mode:c.mode,digest:digest({config:c,ledger:existing,date,jobs})};return this.previewData;
 }
 async start(options){
  if(this.run.active)throw Error('已有执行中的批次');this.run.active=true;this.run.phase='VALIDATING';
  try{return await this._start(options);}catch(error){this.run.active=false;this.run.phase='IDLE';throw error;}
 }
 async _start({digest:confirmed,simulation,confirmRemoteWrite}={}){
  const c=await this.config();const p=this.previewData;
  if(!p||p.digest!==confirmed||p.date!==this.date()||this.previewConfig!==digest(c))throw Error('预览已失效，请重新扫描确认');
  if(simulation!==(c.mode==='simulation'))throw Error('运行模式与预览不一致');if(!simulation&&confirmRemoteWrite!==true)throw Error('需要确认本轮真实上传及发布');
  if(!p.jobs.length)throw Error('没有可发布素材');
  // All live profile/auth prerequisites are checked before reserving or uploading anything.
  if(!simulation&&!this.services.adapterFactory){const {preflightLive}=await import('./live.mjs');await preflightLive(c,p.jobs);}
  this.run={active:true,phase:'RESERVING',current:null,stopRequested:false,error:null};
  this.pending=this.execute(c,structuredClone(p)).catch(error=>{this.run.error=error.message;}).finally(()=>{this.run.active=false;this.run.phase='FINISHED';this.run.current=null;this.previewData=null;});
  return{started:true};
 }
 whenIdle(){return this.pending??Promise.resolve();}
 async login({accountId}){
  if(this.run.active)throw Error('已有执行中的任务');this.run.active=true;this.run.phase='VALIDATING';
  try{return await this._login(accountId);}catch(error){this.run.active=false;this.run.phase='IDLE';throw error;}
 }
 async _login(accountId){
  const c=await this.config();if(c.mode!=='live')throw Error('模拟模式不登录真实账号');
  const a=c.accounts.find(a=>a.id===accountId&&a.operatorId===c.operatorId&&a.enabled);if(!a)throw Error('不是当前运营负责的启用账号');
  this.run={active:true,phase:'LOGIN',current:{accountId},stopRequested:false,error:null};
  this.pending=(async()=>{const{interactiveBrowser}=await import('../browser.mjs');await interactiveBrowser({dataDir:c.authDataDir,uiFile:c.uiFile,browser:{headless:false}},a,'login',()=>{},
    {ask:()=>new Promise(resolve=>{this.loginReady=resolve;this.run.phase='WAITING_LOGIN';})});})()
    .catch(error=>{this.run.error=error.message;}).finally(()=>{this.loginReady=null;this.run.active=false;this.run.phase='FINISHED';});return{started:true};
 }
 continueLogin(){if(!this.loginReady)throw Error('当前没有等待完成的登录');const resolve=this.loginReady;this.loginReady=null;this.run.phase='VERIFYING_IDENTITY';resolve('');return{verifying:true};}
 stop(){this.run.stopRequested=true;return{stopping:true};}
 async adapter(c,a){
  if(this.services.adapterFactory)return this.services.adapterFactory(c,a);
  if(c.mode==='simulation')return{prepare:async j=>j.taskCandidates[randomInt(j.taskCandidates.length)],publish:async()=>({platformId:'sim-'+randomUUID()}),close:async()=>{}};
  const{openLive}=await import('./live.mjs');return openLive(c,a,phase=>{this.run.phase=phase;});
 }
 async execute(c,p){
  const dir=await this.coordinator(c);
  await withStore(dir,async store=>{
   if(digest(store.state.jobs)!==this.previewLedger)throw Error('素材已被其他工作台领取，重新扫描');
   if(p.date!==this.date())throw Error('日期变化，重新扫描');
   store.state.jobs.push(...p.jobs);await store.save();const failedAccounts=new Set();
   for(const job of p.jobs){
    if(this.run.stopRequested||p.date!==this.date()||failedAccounts.has(job.expectedIdentity)){
     history(job,'CANCELLED',{materialStatus:'AVAILABLE',error:failedAccounts.has(job.expectedIdentity)?'账号前序投稿不明，停止后续':'停止后续或已跨日'});await store.save();continue;}
    this.run.current={id:job.id,filename:job.filename,accountId:job.accountId};this.run.phase='PREPARING';let adapter;
    try{
     if((await inspect(job.path,c.minFileAgeSeconds)).hash!==job.hash)throw Error('素材在预览后发生变化');
     const account=c.accounts.find(a=>a.id===job.accountId);history(job,'RUNNING');await store.save();adapter=await this.adapter(c,account);
     const task=await adapter.prepare(job);
     if(!task){history(job,'SKIPPED',{materialStatus:'AVAILABLE',error:'NO_AVAILABLE_TASK'});await store.save();continue;}
     if(!job.taskCandidates.some(t=>t.id===task.id&&t.name===task.name))throw Error('页面任务不在启用任务库');
     job.taskId=task.id;job.taskName=task.name;
     if(this.date()!==p.date)throw Error('准备期间跨日，未提交');
     this.run.phase='SUBMITTING';history(job,'SUBMITTING');await store.save();
     const receipt=await adapter.publish(job);
     if(!receipt?.platformId||(!job.simulation&&!/^\d{15,25}$/.test(receipt.platformId))||store.state.jobs.some(j=>j!==job&&j.expectedIdentity===job.expectedIdentity&&j.platformId===receipt.platformId))throw Error('缺少新的唯一作品编号');
     history(job,'ACCEPTED',{materialStatus:'USED',platformId:receipt.platformId,receiptEvidence:receipt.receiptEvidence??null,reviewStatus:'PENDING'});await store.save();
     this.run.phase='ARCHIVING';if(job.simulation){job.archiveStatus='SIMULATED';await store.save();}else await archive(c,job,store.save);
    }catch(error){
     if(job.status==='ACCEPTED'){job.archiveStatus='ERROR';job.archiveError=error.message;}
     else if(job.status==='SUBMITTING'){history(job,'UNKNOWN',{materialStatus:'UNKNOWN',error:error.message});failedAccounts.add(job.expectedIdentity);}
     else history(job,'FAILED',{materialStatus:'RESERVED',error:error.message});
     await store.save();
    }finally{if(adapter)try{await adapter.close();}catch(error){job.sessionError=error.message;await store.save();}}
   }
  });
 }
 async retryArchive(jobId){if(this.run.active)throw Error('运行中请等待');const c=await this.config();return withStore(await this.coordinator(c),async store=>{
  const j=store.state.jobs.find(j=>j.id===jobId&&j.operatorId===c.operatorId);if(!j)throw Error('找不到本运营记录');if(j.simulation)throw Error('模拟模式不移动素材');await archive(c,j,store.save);return{job:j};});}
 async reconcile({jobId,result,platformId,note}){
  if(this.run.active)throw Error('运行中不能核对');if(typeof note!=='string'||note.trim().length<4)throw Error('请填写核对依据');
  const c=await this.config();return withStore(await this.coordinator(c),async store=>{const j=store.state.jobs.find(j=>j.id===jobId&&j.operatorId===c.operatorId);
   if(!j||!['UNKNOWN','RUNNING','SUBMITTING','FAILED','SKIPPED','READY'].includes(j.status))throw Error('该记录无需人工核对');
   if(result==='accepted'){
    if(!/^\d{15,25}$/.test(platformId??'')||store.state.jobs.some(x=>x!==j&&x.expectedIdentity===j.expectedIdentity&&x.platformId===platformId))throw Error('需提供唯一真实作品编号');
    history(j,'ACCEPTED',{materialStatus:'USED',platformId,note,reviewStatus:'PENDING'});await store.save();if(!j.simulation)await archive(c,j,store.save);
   }else if(result==='not_submitted'){history(j,'CANCELLED',{materialStatus:'AVAILABLE',note});await store.save();}
   else throw Error('核对结果无效');this.previewData=null;return{job:j};});
 }
}
