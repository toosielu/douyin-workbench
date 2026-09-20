import {parseArgs} from 'node:util';
import {OrdinaryWorkbench} from './ordinary-workbench.mjs';
import {startServer} from './v3/server.mjs';
const {values}=parseArgs({options:{config:{type:'string',default:'config/ordinary-excel.local.json'},port:{type:'string',default:'0'}}});
const service=new OrdinaryWorkbench(values.config);
try{
  await service.getState();
  const host=await startServer(service,{port:Number(values.port),assetDirectory:new URL('./ordinary-public/',import.meta.url)});
  console.log(`普通账号发布工作台（仅本机）\n${host.url}\n保持终端运行。页面确认发布后才会上传。按 Ctrl+C 停止。`);
  process.once('SIGINT',async()=>{service.stop();console.log('等待当前操作结束后退出。');await service.whenIdle();await host.close();});
}catch(e){console.error(e.message);process.exitCode=1;}
