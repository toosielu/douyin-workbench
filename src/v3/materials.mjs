import path from 'node:path';import {lstat,readdir,open,mkdir,copyFile,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';import {createHash} from 'node:crypto';
import {parseFilename} from './config.mjs';
export function inside(root,file){const r=path.relative(path.resolve(root),path.resolve(file));return !!r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);}
export async function noLinks(file){
 let current=path.parse(path.resolve(file)).root;for(const part of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await lstat(current);if(s.isSymbolicLink())throw Error('不读取或移动链接目录/文件');}
}
export async function inspect(file,minAge=60){
 await noLinks(file);const before=await lstat(file);if(!before.isFile()||before.size===0||Date.now()-before.mtimeMs<minAge*1000)throw Error('素材未完成写入或为空');
 const handle=await open(file,'r');try{const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
 const after=await lstat(file),opened=await handle.stat();for(const s of [after,opened])if(s.ino!==before.ino||s.size!==before.size||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs)throw Error('素材正在变化');
 return{path:file,hash:hash.digest('hex'),size:before.size};}finally{await handle.close();}
}
export async function scanToday(c,date){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('日期无效');await noLinks(c.root);
 const materials=[],skipped=[];
 for(const editor of c.editors){const day=path.join(c.root,editor.folder,date);let entries;
 try{await noLinks(day);entries=await readdir(day,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
 for(const entry of entries){if(entry.name.startsWith('已发_')||!entry.isFile())continue;
 if(!/\.(mp4|mov|m4v)$/i.test(entry.name))continue;
 const file=path.join(day,entry.name);try{const parsed=parseFilename(entry.name);if(parsed.editor!==editor.id)throw Error('文件剪辑师与目录映射不一致');materials.push({...await inspect(file,c.minFileAgeSeconds),...parsed,filename:entry.name,dayDir:day});}
 catch(error){skipped.push({path:file,reason:error.message});}}
 }
 materials.sort((a,b)=>a.path.localeCompare(b.path));return{materials,skipped};
}
export async function archive(c,job,save){
 if(job.materialStatus!=='USED'||job.status!=='ACCEPTED')throw Error('只有已核实接收的素材可以归档');
 const directory=path.join(job.dayDir,'已发_'+job.koc);const target=path.join(directory,job.filename);
 if(!inside(c.root,job.path)||!inside(c.root,target)||path.dirname(job.path)!==job.dayDir||path.basename(job.path)!==job.filename)throw Error('归档路径越界');
 try{
  await noLinks(job.dayDir);await mkdir(directory,{recursive:true});await noLinks(directory);
  // Persist the intended destination before copying, so recovery can finish deletion safely.
  const resuming=job.archiveTarget===target&&job.archiveStarted===true;
  if(!resuming){try{await lstat(target);throw Error('归档目标已存在，保留源文件等待处理');}catch(e){if(e.code!=='ENOENT')throw e;}}
  job.archiveTarget=target;job.archiveStarted=true;await save();
  let source;try{source=await inspect(job.path,0);if(source.hash!==job.hash)throw Error('源素材内容已变化');}catch(e){if(e.code!=='ENOENT')throw e;}
  let exists=false;try{const dst=await inspect(target,0);if(dst.hash!==job.hash)throw Error('归档目标冲突');exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!exists){if(!source)throw Error('源与归档文件都不存在');await copyFile(job.path,target,constants.COPYFILE_EXCL);if((await inspect(target,0)).hash!==job.hash)throw Error('归档校验失败');}
  if(source){if((await inspect(job.path,0)).hash!==job.hash)throw Error('源素材归档期间变化');await unlink(job.path);}
  job.archiveStatus='DONE';delete job.archiveError;
 }catch(error){job.archiveStatus='ERROR';job.archiveError=error.message;}
 await save();return job;
}
