import path from 'node:path';import {fileURLToPath} from 'node:url';import {parseArgs} from 'node:util';
import {mkdir,writeFile,access,utimes} from 'node:fs/promises';
import {atomicJson} from '../store.mjs';import {businessDate} from '../config.mjs';
import {Workbench} from './workbench.mjs';import {startServer} from './server.mjs';
const{values}=parseArgs({options:{config:{type:'string'},demo:{type:'boolean'},port:{type:'string'}}});
if(!values.demo&&!values.config)throw Error('请指定 --demo 或 --config 配置文件');
if(values.demo&&values.config)throw Error('demo 与 config 不能同时使用');
let configFile=values.config;
if(values.demo){
 const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../data/v3-demo');const root=path.join(base,'materials'),date=businessDate();
 const day=path.join(root,'剪辑师一',date);await mkdir(day,{recursive:true});configFile=path.join(base,'config.json');
 try{await access(configFile);}catch{
  await atomicJson(configFile,{mode:'simulation',operatorId:'operator-a',root,allowNetwork:false,minFileAgeSeconds:0,tagPrefix:'#',
   editors:[{id:'fzq',folder:'剪辑师一'}],accounts:[
    {id:'koc-a-1',expectedIdentity:'demo-001',operatorId:'operator-a',koc:'佳佳',editor:'fzq',enabled:true},
    {id:'koc-a-2',expectedIdentity:'demo-002',operatorId:'operator-a',koc:'佳佳',editor:'fzq',enabled:true},
    {id:'other-owner',expectedIdentity:'demo-003',operatorId:'operator-b',koc:'小林',editor:'fzq',enabled:true}],
   copies:[{id:'copy-1',text:'把日常的小美好分享给你',enabled:true},{id:'copy-2',text:'今天也认真记录生活',enabled:true}],
   tasks:[{id:'101',name:'示例任务一',enabled:true},{id:'102',name:'示例任务二',enabled:true},{id:'103',name:'禁用任务',enabled:false}]});
 }
 for(const[name,text]of [['fzq_C_1_佳佳.mp4','sample1'],['fzq_LONG_2_佳佳.mp4','sample2'],['fzq_C_3_小林.mp4','other-operator'],['名称不规范.mp4','bad-name']]){
  const file=path.join(day,name);try{await writeFile(file,`SIMULATION ONLY ${date} ${text}`,{flag:'wx',encoding:'utf8'});await utimes(file,1,1);}catch(e){if(e.code!=='EEXIST')throw e;}
 }
}
const port=values.port===undefined?0:Number(values.port);if(!Number.isInteger(port)||port<0||port>65535)throw Error('端口无效');
const service=new Workbench(configFile);await service.getState();const app=await startServer(service,{port});
console.log(`本地工作台：${app.url}`);console.log(`配置：${path.resolve(configFile)}`);
console.log(values.demo?'模拟模式：示例不是可发布视频；不会上传或移动原素材。':'运行模式取决于配置；真实发布需在工作台预览确认。');
process.on('SIGINT',()=>{service.stop();if(service.run.active){console.log('正在完成当前操作，请等待；不会开始下一条。');service.whenIdle().finally(()=>app.close());}else app.close();});
