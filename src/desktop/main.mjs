import {app,BrowserWindow,dialog,Menu} from 'electron';
import path from 'node:path';
import {bootstrapDesktop,shutdownDesktop} from './bootstrap.mjs';

// Each Windows user owns a single desktop instance and a separate data store.
if(process.env.DOUYIN_DESKTOP_TEST_HOME)app.setPath('userData',path.resolve(process.env.DOUYIN_DESKTOP_TEST_HOME));
let window,service,host,closing=false,finished=false;
if(!app.requestSingleInstanceLock())app.quit();
else{
  const focus=()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}};
  app.on('second-instance',focus);
  app.on('activate',focus);
  app.on('before-quit',event=>{if(!finished){event.preventDefault();void close();}});
  app.whenReady().then(async()=>{
    Menu.setApplicationMenu(null);
    if(app.isPackaged){
      process.env.DOUYIN_PYTHON=path.join(process.resourcesPath,'runtime','python','python.exe');
      process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(process.resourcesPath,'runtime','browsers');
    }
    const {OrdinaryWorkbench}=await import('../ordinary-workbench.mjs');
    const {startServer}=await import('../v3/server.mjs');
    service=new OrdinaryWorkbench(await bootstrapDesktop(app.getPath('userData')));
    await service.getState();
    host=await startServer(service,{assetDirectory:new URL('../ordinary-public/',import.meta.url)});
    window=new BrowserWindow({width:1440,height:960,minWidth:860,minHeight:620,title:'抖音发布工作台 · 单运营试点',
      webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false}});
    const origin=new URL(host.url).origin;
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
    window.webContents.on('will-attach-webview',event=>event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
    window.on('close',event=>{if(!finished){event.preventDefault();void close();}});
    await window.loadURL(host.url);
  }).catch(async error=>{dialog.showErrorBox('工作台启动失败',error.message);await close();});
}

async function close(){
  if(closing)return;
  closing=true;
  if(service?.busy){
    const result=await dialog.showMessageBox(window,{type:'question',buttons:['继续运行','完成当前操作后退出'],defaultId:0,cancelId:0,message:'当前正在执行。退出会停止后续条目，并等待当前操作结束。'});
    if(result.response!==1){closing=false;return;}
  }
  if(window)window.setTitle('正在等待当前操作结束，请勿强制关闭');
  try{await shutdownDesktop(service,host);finished=true;app.quit();}
  catch(error){closing=false;dialog.showErrorBox('暂未退出',error.message);}
}
