import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';

export async function bootstrapDesktop(directory){
  await mkdir(directory,{recursive:true});
  const file=path.join(directory,'config.json');
  const config={setupPending:true,dataDir:path.join(directory,'data'),
    uiFile:path.join(directory,'profile.json'),dailyTarget:9,maxAttemptsPerDay:18,
    minFileAgeSeconds:60,intervalSeconds:10,archivePublished:true,scanRecursive:false,
    operatorId:'',mappingEnabled:true,accounts:[],browser:{headless:false}};
  // A bundled profile never includes developer account exemptions or sessions.
  const profile={evidence:'live_verified',uploadUrl:'https://creator.douyin.com/creator-micro/content/post/video',
    timeoutMs:60000,uploadTimeoutMs:1200000,
    identity:{url:'https://creator.douyin.com/creator-micro/home',selector:'div.unique_id-EuH8eA:visible',pattern:'^抖音号\\s*[:：]\\s*(\\S+)\\s*$'},
    uploadInput:'input[type="file"][accept*="video"]',uploadComplete:'div.text-JK4gL5:has-text("重新上传")',
    titleInput:'input[placeholder="填写作品标题，为作品获得更多流量"]',publishButton:'role=button[name="发布"s]',
    publication:{visibilityLabel:'公开',scheduleLabel:'立即发布',crossPostLabel:'不同时发布'},
    receipt:{kind:'network',url:'https://creator.douyin.com/web/api/media/aweme/create_v2/'},
    descriptionInput:'div.editor-kit-container[contenteditable="true"]'};
  for(const [target,value] of [[config.uiFile,profile],[file,config]]){
    try{await writeFile(target,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});}
    catch(e){if(e.code!=='EEXIST')throw e;}
  }
  return file;
}

export async function shutdownDesktop(service,host){
  await service?.stop();await service?.whenIdle();await host?.close();
}
