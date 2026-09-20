import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {safeComponent} from './v3/config.mjs';
import {localPath} from './config.mjs';
export function normalizeAccountRows(rows){
  const headers=['抖音号','负责运营','剪辑师代号','KOC','素材目录','是否启用'];
  if(JSON.stringify(rows?.[0])!==JSON.stringify(headers))throw Error(`Excel 前六列表头必须为：${headers.join('、')}`);
  const seen=new Set(),result=[];
  for(const [index,row] of rows.slice(1).entries()){
    if(row.every(v=>!String(v).trim()))continue;
    try{
      const [expectedIdentity,operatorId,editor,koc,materialDir,enabled]=row.map(v=>String(v).trim());
      if(!expectedIdentity||expectedIdentity.length>100||/\s/.test(expectedIdentity))throw Error('抖音号无效');
      if(seen.has(expectedIdentity))throw Error('抖音号重复');seen.add(expectedIdentity);
      for(const value of [operatorId,editor,koc])safeComponent(value);
      if(!['是','否'].includes(enabled))throw Error('是否启用必须填是或否');
      result.push({expectedIdentity,operatorId,editor,koc,materialDir:localPath(materialDir),enabled:enabled==='是'});
    }catch(e){throw Error(`第 ${index+2} 行：${e.message}`);}
  }
  if(!result.length||result.length>200)throw Error('请提供 1–200 条账号记录');return result;
}
export async function readAccountExcel(file){
  try{const {stdout}=await promisify(execFile)(process.env.DOUYIN_PYTHON??'python',[fileURLToPath(new URL('./read-copy-xlsx.py',import.meta.url)),file,'accounts'],{encoding:'utf8',timeout:15000,maxBuffer:4000000,windowsHide:true});return normalizeAccountRows(JSON.parse(stdout));}
  catch(e){throw Error(e.stderr?.trim()||e.message);}
}
