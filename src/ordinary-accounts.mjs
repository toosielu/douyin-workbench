import {randomUUID} from 'node:crypto';
import {localPath} from './config.mjs';
import {safeComponent,parseFilename} from './v3/config.mjs';

export function configureAccounts(previous,input,operatorId){
  safeComponent(operatorId);
  if(!Array.isArray(input)||!input.length||input.length>200)throw Error('请配置 1–200 个账号');
  const ids=new Set(),identities=new Set();
  const result=input.map(row=>{
    const old=previous.find(a=>a.id===row.id);
    if(row.id&&!old)throw Error('已有账号编号不存在，请刷新页面');
    const identity=String(row.expectedIdentity??'').trim();
    if(!identity||identity.length>100||/\s/.test(identity))throw Error('请填写有效抖音号');
    if(old&&old.expectedIdentity!==identity)throw Error('已有账号的抖音号不能更换，请新增账号');
    const id=old?.id??`account-${randomUUID()}`;
    if(ids.has(id)||identities.has(identity))throw Error('账号或抖音号重复');ids.add(id);identities.add(identity);
    for(const key of ['operatorId','editor','koc'])safeComponent(row[key]);
    if(typeof row.enabled!=='boolean')throw Error('请选择账号启用状态');
    const a={...old,id,expectedIdentity:identity,operatorId:row.operatorId,editor:row.editor,koc:row.koc,enabled:row.enabled,materialDir:localPath(row.materialDir),mode:'ordinary',tasks:[],titleTemplate:'{filename}'};
    delete a.materialFile;return a;
  });
  if(previous.some(a=>!ids.has(a.id)))throw Error('已有账号不能移除，请停用以保留历史与登录状态');
  return result;
}
export function eligibleAccount(account,config){
  return account.enabled!==false&&(!config.mappingEnabled||account.operatorId===config.operatorId);
}
export function matchesMaterial(account,filename,config){
  if(!eligibleAccount(account,config))return false;
  if(!config.mappingEnabled)return true;
  const parsed=parseFilename(filename);
  return parsed.editor===account.editor&&parsed.koc===account.koc;
}
