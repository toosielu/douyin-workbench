import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {stat} from 'node:fs/promises';
import {randomInt} from 'node:crypto';
import path from 'node:path';
export function normalizeCopies(rows){
 if(!Array.isArray(rows)||JSON.stringify(rows[0])!==JSON.stringify(['文案编号','文案内容','是否启用']))throw Error('Excel 前三列表头必须为：文案编号、文案内容、是否启用');
 const ids=new Set(),result=[];
 for(const [index,row] of rows.slice(1).entries()){
  if(row.every(v=>!String(v).trim()))continue;
  const [id,text,enabled]=row.map(v=>String(v).trim());
  if(!id||ids.has(id))throw Error(`第${index+2}行文案编号为空或重复`);ids.add(id);
  if(!['是','否'].includes(enabled))throw Error(`第${index+2}行是否启用必须填是或否`);
  if(enabled==='否')continue;
  if(!text||Array.from(text).length>900)throw Error(`第${index+2}行文案为空或超过900字`);
  result.push({id,text,enabled:true});
 }
 if(!result.length)throw Error('没有启用的非空文案');return result;
}
export async function loadCopyLibrary(file,{python=process.env.DOUYIN_PYTHON??'python'}={}){
 if(path.extname(file).toLowerCase()!=='.xlsx'||/^[\\/]{2}/.test(file))throw Error('文案只接受本地 .xlsx 文件');
 if((await stat(file)).size>10_000_000)throw Error('Excel 文件不能超过10MB');
 try{const {stdout}=await promisify(execFile)(python,[fileURLToPath(new URL('./read-copy-xlsx.py',import.meta.url)),path.resolve(file)],{encoding:'utf8',timeout:15000,maxBuffer:4_000_000,windowsHide:true});return normalizeCopies(JSON.parse(stdout));}
 catch(e){throw Error(`读取文案Excel失败：${e.stderr?.trim()||e.message}`);}
}
export function chooseCopy(copies,filename){
 const enabled=copies.filter(c=>c.enabled===true&&typeof c.text==='string'&&c.text.trim());
 if(!enabled.length)throw Error('没有启用的非空文案');
 const parts=path.basename(filename,path.extname(filename)).split('_');
 if(parts.length!==4||parts.some(p=>!p.trim())||!/^\d+$/.test(parts[2]))throw Error('追加素材标签需要文件名：剪辑师_类型_序号_KOC');
 const copy=enabled[randomInt(enabled.length)],tag=parts.slice(0,3).join('_');
 const description=formatDescription(copy.text,tag);
 return {copyId:copy.id,description};
}
export function formatDescription(text,marker){
 const cleaned=text.trim().replace(/^[ \t]*\*+(?=#)/gm,'');
 const topics=[...cleaned.matchAll(/#[^\s#*]+/gu)].map(m=>m[0]).filter(t=>t!=='#'+marker);
 const body=cleaned.replace(/#[^\s#*]+/gu,'').split(/\r?\n/).filter(line=>line.trim()!==marker).join('\n').trim();
 return [body,topics.join(''),marker].filter(Boolean).join('\n');
}
