import path from 'node:path';
const component=/^[^<>:"/\\|?*\x00-\x1f]+$/u;
export function safeComponent(value){
 if(typeof value!=='string'||!component.test(value)||value!==value.trim()||/[. ]$/.test(value)||['.','..'].includes(value)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))throw Error('目录或名称包含无效字符');return value;
}
export function parseFilename(filename){
 const ext=path.extname(filename);if(!['.mp4','.mov','.m4v'].includes(ext.toLowerCase()))throw Error('不是支持的视频文件');
 const parts=path.basename(filename,ext).split('_');if(parts.length!==4||parts.some(x=>!x)||!/^\d+$/.test(parts[2]))throw Error('文件名需要：剪辑师_类型_序号_KOC');
 parts.forEach(safeComponent);return{editor:parts[0],type:parts[1],sequence:parts[2],koc:parts[3],tag:parts.slice(0,3).join('_')};
}
export function validateConfig(raw){
 const c=structuredClone(raw);if(!c||!['simulation','live'].includes(c.mode))throw Error('请选择 simulation 或 live 模式');
 safeComponent(c.operatorId);
 if(typeof c.root!=='string'||!path.isAbsolute(c.root)||/^[a-z]+:\/\//i.test(c.root)||/^\\\\[?.]\\/.test(c.root))throw Error('素材根目录必须是绝对文件路径');
 if(/^[\\/]{2}/.test(c.root)&&c.allowNetwork!==true)throw Error('共享目录连接尚未明确授权');
 c.root=path.resolve(c.root);c.minFileAgeSeconds??=60;
 if(!Number.isInteger(c.minFileAgeSeconds)||c.minFileAgeSeconds<0||c.minFileAgeSeconds>86400)throw Error('文件稳定时间无效');
 c.tagPrefix??='#';if(!['#',''].includes(c.tagPrefix))throw Error('标签前缀只支持 # 或空字符串');
 for(const kind of ['editors','accounts','copies','tasks'])if(!Array.isArray(c[kind]))throw Error(`缺少 ${kind} 数组`);
 const editors=new Set(),folders=new Set();for(const e of c.editors){safeComponent(e.id);safeComponent(e.folder);if(editors.has(e.id)||folders.has(e.folder.toLowerCase()))throw Error('剪辑师重复');editors.add(e.id);folders.add(e.folder.toLowerCase());}
 const ids=new Set(),identities=new Set();for(const a of c.accounts){
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(a.id??''))throw Error('账号代号无效');safeComponent(a.id);safeComponent(a.koc);safeComponent(a.operatorId);
  if(typeof a.expectedIdentity!=='string'||!a.expectedIdentity.trim()||a.expectedIdentity!==a.expectedIdentity.trim()||!editors.has(a.editor)||typeof a.enabled!=='boolean')throw Error('账号标识、剪辑师或启用状态无效');
  if(ids.has(a.id.toLowerCase())||identities.has(a.expectedIdentity))throw Error('账号代号或抖音号重复');ids.add(a.id.toLowerCase());identities.add(a.expectedIdentity);
 }
 for(const kind of ['copies','tasks']){const seen=new Set();for(const v of c[kind]){
  if(typeof v.id!=='string'||!v.id||seen.has(v.id)||typeof v.enabled!=='boolean')throw Error(`${kind} 标识重复或启用状态无效`);seen.add(v.id);
  const text=kind==='copies'?v.text:v.name;if(typeof text!=='string'||!text.trim()||text.length>1000)throw Error(`${kind} 文本不能为空或过长`);
  if(kind==='tasks'&&!/^[A-Za-z0-9_-]{1,100}$/.test(v.id))throw Error('任务 ID 无效');
 }}
 if(c.mode==='live')for(const key of ['authDataDir','uiFile'])if(typeof c[key]!=='string'||!path.isAbsolute(c[key])||/^[\\/]{2}/.test(c[key]))throw Error(`${key} 需为本机绝对路径`);
 return c;
}
function csv(text){
 const rows=[];let row=[],value='',quoted=false;
 for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else if(quoted)quoted=false;else if(value==='')quoted=true;else throw Error('CSV 引号格式错误');}
 else if(ch===','&&!quoted){row.push(value);value='';}else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(Boolean))rows.push(row);row=[];value='';}else value+=ch;}
 if(quoted)throw Error('CSV 引号未结束');row.push(value);if(row.some(Boolean))rows.push(row);
 const headers=rows.shift();if(!headers||new Set(headers).size!==headers.length||headers.some(h=>!h||['__proto__','prototype','constructor'].includes(h)))throw Error('CSV 表头无效');
 return rows.map(r=>{if(r.length!==headers.length)throw Error('CSV 列数不一致');return Object.fromEntries(headers.map((h,i)=>[h,r[i]]));});
}
export function parseImport(kind,format,text){
 if(!['accounts','tasks','copies'].includes(kind)||!['json','csv'].includes(format)||typeof text!=='string'||text.length>1000000)throw Error('不支持的导入格式');
 const rows=format==='json'?JSON.parse(text):csv(text.replace(/^\ufeff/,''));if(!Array.isArray(rows))throw Error('导入需为数组');
 const fields={accounts:['id','expectedIdentity','operatorId','koc','editor','enabled'],tasks:['id','name','enabled'],copies:['id','text','enabled']}[kind];
 return rows.map(row=>{if(!row||typeof row!=='object'||fields.some(k=>row[k]===undefined))throw Error(`缺少字段：${fields.join(',')}`);
 const result=Object.fromEntries(fields.map(k=>[k,row[k]]));if(format==='csv'){if(!['true','false'].includes(result.enabled))throw Error('enabled 必须为 true/false');result.enabled=result.enabled==='true';}return result;});
}
