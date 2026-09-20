import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline/promises';
import {loadConfig, businessDate} from './config.mjs';
import {withStore} from './store.mjs';
import {preflight} from './preflight.mjs';
import {loadProfile} from './browser.mjs';
import {batchDigest} from './batch.mjs';
import {main as cli} from './cli.mjs';

export async function runOrdinary(configFile = 'config/ordinary-account.local.json', services = {}) {
  const log = services.log ?? console.log;
  const execute = services.execute ?? (args=>cli(args,{log:args[0] === 'plan' ? ()=>{} : log}));
  const ask = services.ask ?? (async message=>{
    const prompt=createInterface({input:process.stdin,output:process.stdout});
    try {return await prompt.question(message);} finally {prompt.close();}
  });
  const config = await loadConfig(configFile);
  if (config.accounts.some(account=>account.mode !== 'ordinary')) throw new Error('此入口仅支持普通账号，请使用对应任务配置');
  await execute(['plan','--config',configFile]);
  const date = businessDate();
  const preview = await withStore(config.dataDir,async store=>{
    preflight(config,store.state.jobs,date);
    const pending=store.state.jobs.filter(job=>job.date===date&&job.status==='PLANNED');
    if (!pending.length) return {pending};
    const ui=await loadProfile(config,{mode:'ordinary'});
    return {pending,ui,digest:batchDigest(config,store.state.jobs,date,ui)};
  });
  if (!preview.pending.length) {
    log('没有待发布视频。已发布素材会跳过；待审核、素材不足或未决记录请查看 report。');
    return {status:'EMPTY'};
  }
  const settings=preview.ui.publication;
  if (!settings) throw new Error('普通入口需要 publication 发布设置');
  log(`本批次 ${preview.pending.length} 条：${settings.visibilityLabel}，${settings.scheduleLabel}，${settings.crossPostLabel}`);
  for (const job of preview.pending) log(`账号 ${job.accountId}（${job.expectedIdentity}）｜标题 ${job.title}｜${job.path}`);
  for (const job of preview.pending) if(job.description) log(`完整正文（文案 ${job.copyId}）：\n${job.description}`);
  const phrase=`PUBLISH ${preview.pending.length}`;
  const answer=await ask(`确认上传并发布以上批次请输入 ${phrase}，其他输入取消：`);
  if (answer.trim() !== phrase) {log('已取消，本批次没有上传或发布。');return {status:'CANCELLED'};}
  return execute(['run','--config',configFile,'--publish','--confirm-remote-write','--plan-digest',preview.digest]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const {values}=parseArgs({strict:true,options:{config:{type:'string',default:'config/ordinary-account.local.json'}}});
  runOrdinary(values.config).catch(error=>{console.error(error.message);process.exitCode=1;});
}
