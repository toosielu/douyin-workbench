import path from 'node:path';
import {readFile, mkdir, writeFile, unlink} from 'node:fs/promises';
import {createHash, randomUUID, randomInt} from 'node:crypto';
import {configureAccounts,eligibleAccount,matchesMaterial} from './ordinary-accounts.mjs';
import {readAccountExcel} from './account-excel.mjs';
import {loadConfig, normalizeConfig, businessDate, localPath} from './config.mjs';
import {loadCopyLibrary, chooseCopy} from './copy-library.mjs';
import {scanMaterials, verifyMaterial} from './materials.mjs';
import {withStore, atomicJson, transition} from './store.mjs';
import {preflight} from './preflight.mjs';
import {loadProfile, assertAuthFiles, openAccount, interactiveBrowser} from './browser.mjs';
import {runJobs} from './runner.mjs';
import {archiveOrdinary} from './ordinary-archive.mjs';
import {planWithModel,modelSettings} from './ai-planner.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reusable=new Set(['CANCELLED','FAILED_BEFORE_SUBMIT']);
export class OrdinaryWorkbench {
  constructor(file,dependencies={}) {
    this.file=path.resolve(file);
    this.templateFile=new URL('./ordinary-public/accounts-template.xlsx',import.meta.url);
    this.deps={loadConfig,loadProfile,assertAuth:assertAuthFiles,openAccount,interactiveBrowser,planWithModel,...dependencies};
    this.run={phase:'IDLE',message:'请保存资料并扫描预览'};
    this.busy=false; this.pending=null; this.stopped=false;
  }
  async config() {
    const c=await this.deps.loadConfig(this.file);
    if(c.accounts.some(a=>a.mode!=='ordinary')) throw Error('此工作台只支持普通账号');
    if(!c.copies?.length&&c.setupPending!==true) throw Error('请选择包含启用文案的 Excel');
    return {...c,copies:c.copies??[],archivePublished:true,scanRecursive:false};
  }
  async ledger(c) {
    try {const value=JSON.parse(await readFile(path.join(c.dataDir,'ledger.json'),'utf8'));if(value.version!==1||!Array.isArray(value.jobs))throw Error('历史记录格式无效');return value;}
    catch(e){if(e.code==='ENOENT')return {version:1,jobs:[]};throw e;}
  }
  // The web queue is material driven; legacy daily-target fields do not limit it.
  executionConfig(c,jobs,extra=0) {return {...c,dailyTarget:jobs.length+extra+1,maxAttemptsPerDay:jobs.length+extra+1};}
  async signature(c,ledger) {return hash([c,ledger,businessDate(),await readFile(c.uiFile,'utf8')]);}
  async getState() {
    const c=await this.config(); const ledger=await this.ledger(c);
    const accounts=await Promise.all(c.accounts.map(async a=>{
      let loginStatus='未登录';
      try{const auth=JSON.parse(await readFile(path.join(c.dataDir,'auth',`${a.id}.json`),'utf8'));loginStatus=auth.accountId===a.id&&auth.expectedIdentity===a.expectedIdentity&&auth.identityVerified===true?'已核对（本机记录，未在线验证）':'需重新核对';}catch(e){if(e.code!=='ENOENT')loginStatus='登录记录无法读取';}
      return {id:a.id,expectedIdentity:a.expectedIdentity,materialDir:a.materialDir,operatorId:a.operatorId??'',editor:a.editor??'',koc:a.koc??'',enabled:a.enabled!==false,loginStatus};
    }));
    return {config:{copyFile:c.copyFile,operatorId:c.operatorId??'',mappingEnabled:c.mappingEnabled===true,revision:hash(await readFile(this.file,'utf8')),accounts},copyCount:c.copies.length,run:{...this.run,busy:this.busy},preview:this.pending?{jobs:this.pending.jobs,digest:this.pending.digest}:null,records:ledger.jobs.filter(j=>c.accounts.some(a=>a.id===j.accountId)).slice().reverse()};
  }
  async exclusive(fn) {
    if(this.busy)throw Error('正在执行，请等待当前操作结束');this.busy=true;
    try{return await fn();}finally{this.busy=false;}
  }
  async importPreview({kind,format,text}){return this.exclusive(async()=>{
    if(kind!=='accounts'||format!=='xlsx'||typeof text!=='string'||text.length>900000||!text.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw Error('请选择 650 KB 以内的账号 .xlsx 表格');
    const c=await this.config(),directory=path.join(c.dataDir,'account-imports');await mkdir(directory,{recursive:true});
    const file=path.join(directory,`${randomUUID()}.xlsx`);
    try{await writeFile(file,Buffer.from(text,'base64'),{flag:'wx'});return {accounts:await readAccountExcel(file)};}
    finally{await unlink(file).catch(()=>{});}
  });}
  async saveConfig(input) {return this.exclusive(async()=>{
    const raw=JSON.parse(await readFile(this.file,'utf8')); let imported;
    try {
      if(input.excel) {
        if(typeof input.excel.name!=='string'||!input.excel.name.toLowerCase().endsWith('.xlsx')||typeof input.excel.base64!=='string'||input.excel.base64.length>900000||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.excel.base64))throw Error('请选择小于 650 KB 的 .xlsx 文件');
        const directory=path.join(localPath(raw.dataDir,path.dirname(this.file)),'copy-imports');await mkdir(directory,{recursive:true});
        imported=path.join(directory,`${randomUUID()}.xlsx`);await writeFile(imported,Buffer.from(input.excel.base64,'base64'),{flag:'wx'});raw.copyFile=imported;
      } else if(typeof input.copyFile==='string') raw.copyFile=localPath(input.copyFile);
      raw.accounts=configureAccounts(raw.accounts,input.accounts,input.operatorId);
      raw.operatorId=input.operatorId;raw.mappingEnabled=true;
      delete raw.setupPending;
      raw.archivePublished=true;raw.scanRecursive=false;
      const validated=normalizeConfig(raw,path.dirname(this.file));await loadCopyLibrary(validated.copyFile);
      await withStore(validated.dataDir,async store=>{
        if(input.revision!==hash(await readFile(this.file,'utf8')))throw Error('配置已变化，请刷新页面后重新编辑');
        preflight(this.executionConfig(validated,store.state.jobs),store.state.jobs,businessDate());
        await atomicJson(this.file,raw);
      });this.pending=null;this.run={phase:'IDLE',message:'资料已保存，请扫描预览'};
      return {ok:true};
    }catch(e){if(imported)await unlink(imported).catch(()=>{});throw e;}
  });}
  async aiPreview({instruction,consent}={}){
    if(consent!==true)throw Error('请先同意将本轮指令、文件名、剪辑师/KOC和文案发送给所配置的模型服务');
    if(typeof instruction!=='string'||!instruction.trim()||instruction.length>2000)throw Error('请输入 1～2000 字的指令');
    return this.preview({instruction});
  }
  async preview(aiRequest=null){return this.exclusive(async()=>{
    this.pending=null;
    try {
    const c=await this.config(),ledger=await this.ledger(c),date=businessDate();
    if(c.setupPending||!c.accounts.length||!c.copies.length)throw Error('请先配置账号并导入文案 Excel，保存资料后再扫描');
    preflight(this.executionConfig(c,ledger.jobs),ledger.jobs,date);
    let jobs=[];const notes=[];
    const used=new Set(ledger.jobs.filter(j=>!reusable.has(j.status)).map(j=>j.hash));
    const candidates=new Map();
    for(const a of c.accounts.filter(a=>eligibleAccount(a,c))){
      const history=ledger.jobs.filter(j=>j.accountId===a.id);
      if(history.some(j=>['PLANNED','RUNNING','SUBMITTING','UNKNOWN'].includes(j.status)||(j.date<date&&j.status==='PENDING_REVIEW'))){notes.push(`${a.expectedIdentity} 有未决投稿或旧计划，需先核对`);continue;}
      let materials;try{materials=await scanMaterials(a.materialDir,{minFileAgeSeconds:c.minFileAgeSeconds,recursive:false});}catch(e){notes.push(`${a.expectedIdentity} 素材目录无法读取：${e.message}`);continue;}
      for(const m of materials){
        if(used.has(m.hash)){notes.push(`${path.basename(m.path)} 已使用或已预留`);continue;}
        try{if(!matchesMaterial(a,m.path,c)){notes.push(`${path.basename(m.path)} 与账号 ${a.expectedIdentity} 的剪辑师/KOC 不匹配`);continue;}}catch(e){notes.push(`${path.basename(m.path)}：${e.message}`);continue;}
        if(!candidates.has(m.hash))candidates.set(m.hash,[]);candidates.get(m.hash).push({a,m});
      }
    }
    for(const options of candidates.values()){
      const {a,m}=options[randomInt(options.length)];
      let copy;try{copy=chooseCopy(c.copies,m.path);}catch(e){notes.push(`${path.basename(m.path)}：${e.message}`);continue;}
      jobs.push({id:randomUUID(),accountId:a.id,expectedIdentity:a.expectedIdentity,editor:a.editor,koc:a.koc,date,mode:'ordinary',taskId:null,taskName:null,path:m.path,hash:m.hash,title:'',...copy,status:'PLANNED'});
    }
    if(aiRequest&&jobs.length){
      const before=await this.signature(c,ledger);
      this.run={phase:'AI_PLANNING',message:'AI 正在选择候选素材和文案，请稍候'};
      const planned=await this.deps.planWithModel({instruction:aiRequest.instruction,jobs,copies:c.copies,settings:modelSettings()});
      if(await this.signature(await this.config(),await this.ledger(c))!==before)throw Error('配置、日期或记录已变化，请重新生成 AI 预览');
      jobs=planned.jobs;notes.push(`AI：${planned.summary}`);
    }
    const signature=await this.signature(c,ledger),digest=hash([signature,jobs]);
    this.pending={jobs,signature,digest,date};this.run={phase:'IDLE',message:jobs.length?`预览 ${jobs.length} 条。点击发布前请核对完整文案。`:'没有未发素材；已发子目录不会扫描。',notes};
    return {jobs,digest,notes};
    }catch(error){this.pending=null;this.run={phase:'ERROR',message:error.message};throw error;}
  });}
  async start({digest,confirmRemoteWrite,simulation}) {
    if(confirmRemoteWrite!==true||simulation!==false)throw Error('请明确确认真实发布');
    if(this.busy)throw Error('已有操作正在执行');
    const p=this.pending;if(!p||p.digest!==digest||!p.jobs.length)throw Error('请重新扫描预览');
    this.busy=true;this.stopped=false;
    // Handshake returns only after all checks and reservations are persisted.
    let readyResolve,readyReject;
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    this.task=(async()=>{
      try{
        const c=await this.config();
        await withStore(c.dataDir,async store=>{
          if(await this.signature(c,store.state)!==p.signature)throw Error('配置、日期或历史已变化，请重新预览');
          const execution=this.executionConfig(c,store.state.jobs,p.jobs.length);
          preflight(execution,[...store.state.jobs,...p.jobs],p.date);
          for(const job of p.jobs){const a=c.accounts.find(a=>a.id===job.accountId);await verifyMaterial(job,a.materialDir,{minFileAgeSeconds:c.minFileAgeSeconds});}
          const ui=await this.deps.loadProfile(c,{mode:'ordinary'});
          await this.deps.assertAuth(c,c.accounts.filter(a=>p.jobs.some(j=>j.accountId===a.id)));
          store.state.jobs.push(...structuredClone(p.jobs));await store.save();
          this.pending=null;this.run={phase:'RUNNING',message:'正在发布本轮素材'};readyResolve({ok:true});
          try{
            const selected={...execution,accounts:execution.accounts.filter(a=>p.jobs.some(j=>j.accountId===a.id))};
            const outcomes=await runJobs({config:selected,jobs:store.state.jobs,date:p.date,confirmed:true,save:store.save,openAccount:a=>this.deps.openAccount(c,ui,a),shouldStop:()=>this.stopped,log:message=>{this.run.message=message;}});
            this.run={phase:'DONE',message:this.stopped?'已停止后续发布':outcomes.some(o=>['BLOCKED','UNKNOWN','FAILED_BEFORE_SUBMIT'].includes(o.status))?'本轮结束，有记录需要核对':'本轮发布结束，请查看回执与归档',outcomes};
          }finally{
            // Unstarted reservations can be previewed again, uncertain submissions cannot.
            for(const j of store.state.jobs)if(p.jobs.some(v=>v.id===j.id)&&j.status==='PLANNED')transition(j,'CANCELLED',{note:'本轮未开始上传'});
            await store.save();
          }
        });
      }catch(e){this.run={phase:'ERROR',message:e.message};readyReject(e);}
      finally{this.busy=false;}
    })();
    return ready;
  }
  stop(){this.stopped=true;this.loginReject?.(new Error('已取消登录'));return {ok:true};}
  async whenIdle(){
    await this.task;
    while(this.busy)await new Promise(resolve=>setTimeout(resolve,25));
  }
  async retryArchive(id){return this.exclusive(async()=>{
    const c=await this.config();return withStore(c.dataDir,async store=>{
      const j=store.state.jobs.find(j=>j.id===id),a=c.accounts.find(a=>a.id===j?.accountId);if(!a)throw Error('记录不存在');
      await archiveOrdinary(a,j,store.save);delete j.archiveFailure;await store.save();return {ok:true};
    });
  });}
  async login({accountId}){
    if(this.busy)throw Error('已有操作正在执行');this.busy=true;
    let c,a;try{c=await this.config();a=c.accounts.find(a=>a.id===accountId&&eligibleAccount(a,c));if(!a)throw Error('账号未启用或不属于当前运营');}catch(e){this.busy=false;throw e;}
    this.run={phase:'LOGIN',message:'正在打开登录浏览器'};
    this.stopped=false;
    this.task=withStore(c.dataDir,()=>this.deps.interactiveBrowser(c,a,'login',message=>{this.run.message=message;},{ask:()=>new Promise((resolve,reject)=>{this.loginResolve=resolve;this.loginReject=reject;this.run.phase='WAITING_LOGIN';if(this.stopped)reject(new Error('已取消登录'));})})).then(()=>{this.run={phase:'DONE',message:'身份核对完成，登录态已保存'};}).catch(e=>{this.run={phase:'ERROR',message:e.message};}).finally(()=>{this.loginResolve=null;this.loginReject=null;this.busy=false;});
    return {ok:true};
  }
  continueLogin(){if(!this.loginResolve)throw Error('请先打开账号登录');this.loginResolve('');this.loginResolve=null;this.run.phase='LOGIN';return {ok:true};}
}
