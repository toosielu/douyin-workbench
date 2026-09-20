const suppliedToken=location.hash.slice(1);
let token='',tokenStored=false;
try{
  if(/^[a-f0-9]{64}$/.test(suppliedToken))sessionStorage.setItem('ordinary-workbench-token',suppliedToken);
  token=sessionStorage.getItem('ordinary-workbench-token')??'';
  tokenStored=Boolean(token);
}catch{token=suppliedToken;}
// Keep the link usable when browser storage is disabled.
if(tokenStored)history.replaceState(null,'',location.pathname);
const $=id=>document.getElementById(id);let state,initialized=false,working=false,draftRevision,lastPhase;
let importedAccounts=null;
const notice=(message,error=false)=>{$('notice').textContent=message;$('notice').classList.toggle('error',error);};
async function api(route,body){const r=await fetch(`/api/${route}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error);return value;}
function element(tag,text,className){const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el;}
function accountRow(a={}){
  const card=element('article','','account-row card');card.dataset.account=a.id??'';
  card.append(element('strong',a.id?`抖音号 ${a.expectedIdentity}`:'新增账号'),element('p',a.loginStatus??'保存资料后可扫码登录','meta account-login-status'));
  const grid=element('div','','form-grid');
  for(const [key,label,placeholder] of [['expectedIdentity','抖音号','填写真实抖音号'],['operatorId','负责运营','例如 运营甲'],['editor','剪辑师代号（文件名前缀）','例如 fzq'],['koc','KOC（文件名最后一段）','例如 KOC1'],['materialDir','素材目录（视频所在层）','例如 D:\\素材\\剪辑师\\2026-09-17']]){
    const field=element('label',label),input=document.createElement('input');input.type='text';input.dataset.field=key;input.value=a[key]??(key==='operatorId'?$('operator-id').value:'');input.placeholder=placeholder;if(key==='expectedIdentity'&&a.id)input.readOnly=true;field.append(input);grid.append(field);
  }
  const field=element('label','账号状态'),select=document.createElement('select');select.dataset.field='enabled';
  for(const [value,label] of [['true','启用'],['false','停用（保留历史）']]){const option=element('option',label);option.value=value;select.append(option);}select.value=a.enabled===false?'false':'true';field.append(select);grid.append(field);card.append(grid);
  if(!a.id){const remove=element('button','移除未保存账号');remove.type='button';remove.className='secondary';remove.onclick=()=>card.remove();card.append(remove);}
  $('accounts').append(card);
}
function render(s){state=s;
  if(lastPhase!==s.run.phase&&['DONE','ERROR'].includes(s.run.phase))notice(s.run.message,s.run.phase==='ERROR'||(s.run.outcomes??[]).some(o=>['UNKNOWN','BLOCKED','FAILED_BEFORE_SUBMIT'].includes(o.status)));
  lastPhase=s.run.phase;
  $('count-candidates').textContent=s.preview?.jobs?.length??0;
  $('count-done').textContent=s.records.filter(j=>j.platformId).length;
  $('count-unknown').textContent=s.records.filter(j=>j.status==='UNKNOWN').length;
  $('count-archive').textContent=s.records.filter(j=>j.platformId&&['PENDING_REVIEW','APPROVED'].includes(j.status)&&j.archive?.archiveStatus!=='DONE').length;
  $('phase').textContent=({IDLE:'等待执行',AI_PLANNING:'AI 正在生成计划',RUNNING:'正在发布',DONE:'本轮已结束',ERROR:'需要处理',LOGIN:'正在登录',WAITING_LOGIN:'等待扫码登录'})[s.run.phase]??s.run.phase;
  if(!initialized){draftRevision=s.config.revision;$('copy-path').value=s.config.copyFile??'';$('operator-id').value=s.config.operatorId??'';$('accounts').replaceChildren();$('login-account').replaceChildren();
    for(const a of s.config.accounts){accountRow(a);if(a.enabled!==false&&(!s.config.mappingEnabled||a.operatorId===s.config.operatorId)){const option=element('option',`${a.expectedIdentity}（${a.koc||a.id}）`);option.value=a.id;$('login-account').append(option);}}initialized=true;}
  $('mapping-status').textContent=s.config.mappingEnabled?'已启用映射：仅处理当前运营负责、已启用且剪辑师/KOC 匹配的素材。':'当前为旧版按目录分配。请补全运营、剪辑师和 KOC，保存后启用映射规则。';
  for(const row of document.querySelectorAll('.account-row')){const a=s.config.accounts.find(a=>a.id===row.dataset.account);if(a)row.querySelector('.account-login-status').textContent=a.loginStatus??'未登录';}
  $('copy-count').textContent=`当前文案库：${s.copyCount} 条启用文案`;
  const unresolved=s.records.filter(j=>j.status==='UNKNOWN');
  $('run').textContent=s.run.message+(unresolved.length?`；有 ${unresolved.length} 条投稿结果不明，请到执行记录核对`:'');$('notes').replaceChildren(...(s.run.notes??[]).map(n=>element('li',n)));
  const jobs=s.preview?.jobs??[];$('preview').replaceChildren();
  if(!jobs.length)$('preview').append(element('p','没有待发布的预览。已发文件会自动跳过。'));
  for(const j of jobs){const card=element('article','','card');card.append(element('strong',`抖音号 ${j.expectedIdentity}`),element('div',j.path,'meta'),element('div',j.description,'copy'),element('div',`文案编号 ${j.copyId}`,'meta'));if(j.aiReason)card.append(element('p',`AI 选择理由：${j.aiReason}`,'meta'));$('preview').append(card);}
  $('records').replaceChildren();
  const names={PENDING_REVIEW:'平台已接收 · 待核对审核',APPROVED:'已核对通过',UNKNOWN:'结果不明 · 请核对，禁止自动重发',SUBMITTING:'正在提交',RUNNING:'正在准备上传',PLANNED:'已预留',FAILED_BEFORE_SUBMIT:'发布前失败',CANCELLED:'未开始，已取消',REJECTED:'审核未通过'};
  for(const j of s.records){const card=element('article','','card');card.append(element('strong',`${j.path.split(/[\\/]/).pop()} · ${names[j.status]??j.status}`),element('div',`账号 ${j.expectedIdentity} · ${j.date} · 回执 ${j.platformId??'暂无'}`,'meta'));
    if(j.description)card.append(element('div',j.description,'copy'));
    const archive=j.archive;card.append(element('p',archive?.archiveStatus==='DONE'?`已归档：${archive.archiveTarget}`:j.archiveFailure??archive?.archiveError??'尚未归档'));
    if(j.error)card.append(element('p',j.error));
    if(j.platformId&&['PENDING_REVIEW','APPROVED'].includes(j.status)&&archive?.archiveStatus!=='DONE'){const b=element('button','补归档（不重发）');b.disabled=s.run.busy||working;b.onclick=()=>action(async()=>{await api('archive',{jobId:j.id});notice('补归档完成');});card.append(b);}
    $('records').append(card);
  }
  for(const id of ['save','scan','ai-preview','login','add-account','import-accounts'])$(id).disabled=s.run.busy||working;
  $('apply-accounts').disabled=s.run.busy||working||!importedAccounts;
  for(const b of document.querySelectorAll('.account-row button'))b.disabled=s.run.busy||working;
  $('publish').disabled=s.run.busy||working||!jobs.length;$('stop').disabled=s.run.phase!=='RUNNING';$('login-done').disabled=s.run.phase!=='WAITING_LOGIN';
  for(const input of document.querySelectorAll('input,select,textarea'))input.disabled=s.run.busy||working;
}
async function refresh(){render(await api('state'));}
async function action(fn){if(working)return;working=true;if(state)render(state);try{await fn();}catch(e){notice(e.message,true);}finally{working=false;await refresh().catch(e=>notice(e.message,true));}}
$('add-account').onclick=()=>accountRow();
function draftAccounts(){return [...document.querySelectorAll('[data-account]')].map(el=>{const row={id:el.dataset.account};for(const field of el.querySelectorAll('[data-field]'))row[field.dataset.field]=field.dataset.field==='enabled'?field.value==='true':field.value.trim();return row;});}
$('account-excel').onchange=()=>{importedAccounts=null;$('account-import-result').textContent='';$('apply-accounts').disabled=true;};
$('import-accounts').onclick=()=>action(async()=>{
  importedAccounts=null;const file=$('account-excel').files[0];if(!file||!file.name.toLowerCase().endsWith('.xlsx')||file.size>650*1024)throw Error('请选择 650 KB 以内的 .xlsx 账号表格');
  const text=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(file);});
  const result=await api('import-preview',{kind:'accounts',format:'xlsx',text});
  importedAccounts=result.accounts;
  const existing=draftAccounts();$('account-import-result').replaceChildren();
  for(const a of importedAccounts){const operation=existing.some(v=>v.expectedIdentity===a.expectedIdentity)?'更新':'新增';const card=element('div','','card');card.append(element('strong',`${operation} · ${a.expectedIdentity}`),element('p',`${a.operatorId} / ${a.editor} / ${a.koc} / ${a.enabled?'启用':'停用'}`),element('p',a.materialDir,'meta'));$('account-import-result').append(card);}
  notice(`已校验 ${importedAccounts.length} 条，请检查后应用到表单。尚未保存。`);
});
$('apply-accounts').onclick=()=>{
  if(!importedAccounts||working||state?.run.busy)return;
  const rows=draftAccounts().filter(row=>row.id||row.expectedIdentity||row.editor||row.koc||row.materialDir);const seen=new Set();for(const row of rows){if(row.expectedIdentity&&seen.has(row.expectedIdentity)){notice('当前表单抖音号重复，请先处理再应用导入',true);return;}seen.add(row.expectedIdentity);}
  for(const a of importedAccounts){const index=rows.findIndex(v=>v.expectedIdentity===a.expectedIdentity);if(index>=0)rows[index]={...rows[index],...a};else rows.push({...a,id:''});}
  if(rows.length>200){notice('账号总数不能超过 200',true);return;}
  $('accounts').replaceChildren();for(const row of rows)accountRow(row);
  importedAccounts=null;$('apply-accounts').disabled=true;$('account-import-result').textContent='已应用到表单，请点击“保存资料”生效。';notice('账号表单已更新，已有账号编号与登录状态会保留。请保存资料。');
};
$('save').onclick=()=>action(async()=>{const config={revision:draftRevision,operatorId:$('operator-id').value.trim(),copyFile:$('copy-path').value,accounts:[...document.querySelectorAll('[data-account]')].map(el=>{const row={id:el.dataset.account};for(const field of el.querySelectorAll('[data-field]'))row[field.dataset.field]=field.dataset.field==='enabled'?field.value==='true':field.value.trim();return row;})};const file=$('excel').files[0];if(file){if(file.size>650*1024)throw Error('请选择 650 KB 以内的 Excel');const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});config.excel={name:file.name,base64};}await api('config',{config});initialized=false;$('excel').value='';notice('已保存。请点击“扫描并预览”。');});
$('scan').onclick=()=>action(async()=>{await api('preview',{});notice('请核对账号、视频和完整文案，再发布本轮。');});
$('ai-preview').onclick=()=>action(async()=>{
 if(!$('ai-consent').checked)throw Error('请先勾选资料发送确认');
 notice('AI 正在生成预览，请稍候…');
 const result=await api('ai-preview',{instruction:$('ai-instruction').value.trim(),consent:true});
 notice(result.jobs.length?'AI 预览已生成，请核对账号、素材和完整文案。':'AI 未生成可发布项目，请查看下方说明。');
});
$('publish').onclick=()=>action(async()=>{const p=state.preview;if(!p?.jobs.length)return;if(!confirm(`将向抖音真实上传并发布这 ${p.jobs.length} 条视频，成功后移入已发目录。确认按页面预览的账号与文案执行？`))return;await api('start',{digest:p.digest,simulation:false,confirmRemoteWrite:true});notice('已开始真实发布。请保持终端和浏览器运行。');});
$('stop').onclick=()=>action(async()=>{await api('stop',{});notice('将完成当前条目后停止后续发布。');});
$('login').onclick=()=>action(()=>api('login',{accountId:$('login-account').value}));
$('login-done').onclick=()=>action(()=>api('login-continue',{}));
refresh().then(()=>notice(state.config.accounts.length?'资料已载入。已有登录态会直接复用。':'首次使用：请在基础资料中填写运营、添加账号并导入文案 Excel，然后保存资料。')).catch(e=>notice(e.message,true));
setInterval(()=>{if(!working)refresh().catch(e=>notice(e.message,true));},2500);
for(const link of document.querySelectorAll('nav a'))link.addEventListener('click',event=>{
  event.preventDefault();document.querySelector(link.getAttribute('href')).scrollIntoView({behavior:'smooth'});
  for(const item of document.querySelectorAll('nav a')){item.classList.toggle('selected',item===link);if(item===link)item.setAttribute('aria-current','location');else item.removeAttribute('aria-current');}
});
