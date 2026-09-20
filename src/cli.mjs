import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfig, businessDate } from './config.mjs';
import { withStore, atomicJson, transition } from './store.mjs';
import { scanMaterials, inspectMaterial } from './materials.mjs';
import { buildPlan } from './planner.mjs';
import { preflight } from './preflight.mjs';
import { runJobs } from './runner.mjs';
import { makeReport } from './report.mjs';
import { batchDigest } from './batch.mjs';

const help = `抖音多账号任务投稿 Demo — 默认离线，Node.js 24+
  node src/cli.mjs plan [--config config/accounts.local.json]
  node src/cli.mjs login --account account-a
  node src/cli.mjs connect --account account-a
  node src/cli.mjs verify --account account-a
  node src/cli.mjs inspect --account account-a
  node src/cli.mjs run --publish --confirm-remote-write [--account account-a]
  node src/cli.mjs report
  node src/cli.mjs mark --job ID --status REJECTED --note "已在平台核对驳回"

run 不带 --publish 等同离线 plan。真实执行需要事先保存的当日计划及校准后的 UI 配置。
--confirm-remote-write 确认本批次上传、关联任务和发布；选择文件即可能上传。
审核结果须人工核对后 mark；当前 Demo 不自动读取审核结果。`;

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    config: { type: 'string', default: 'config/accounts.local.json' }, account: { type: 'string' },
    publish: { type: 'boolean' }, 'confirm-remote-write': { type: 'boolean' },
    help: { type: 'boolean' }, job: { type: 'string' }, status: { type: 'string' },
    note: { type: 'string' }, 'platform-id': { type: 'string' }, 'plan-digest': { type:'string' }
  } });
  const command = positionals[0];
  if (values.help || !command) { log(help); return; }
  if (positionals.length !== 1 || !['plan', 'run', 'login', 'connect', 'verify', 'inspect', 'report', 'mark'].includes(command)) throw new Error('Unknown command / 命令');
  if (command === 'run' && values.publish && !values['confirm-remote-write']) throw new Error('真实上传前必须显式提供 --confirm-remote-write');
  const config = await loadConfig(values.config);
  const account = config.accounts.find(a => a.id === values.account);
  if (values.account && !account) throw new Error('Unknown account');
  if (['login', 'connect', 'verify', 'inspect'].includes(command)) {
    if (!account) throw new Error('需要 --account');
    const { interactiveBrowser } = await import('./browser.mjs');
    return withStore(config.dataDir, () => interactiveBrowser(config, account, command, log));
  }
  const date = businessDate();
  return withStore(config.dataDir, async store => {
    const jobs = store.state.jobs;
    if (command === 'mark') {
      const job = jobs.find(j => j.id === values.job);
      if (!job || !values.note?.trim() || values.note.trim().length < 4) throw new Error('mark 需要有效 --job 和核对依据 --note');
      const allowed = {
        PLANNED: ['CANCELLED'], RUNNING: ['FAILED_BEFORE_SUBMIT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'],
        SUBMITTING: ['FAILED_BEFORE_SUBMIT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'],
        UNKNOWN: ['FAILED_BEFORE_SUBMIT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'],
        PENDING_REVIEW: ['APPROVED', 'REJECTED'], APPROVED: ['REJECTED']
      };
      if (!allowed[job.status]?.includes(values.status)) throw new Error(`不允许 ${job.status} → ${values.status}`);
      const platformId = (values['platform-id'] ?? job.platformId ?? '').trim();
      if (['PENDING_REVIEW', 'APPROVED', 'REJECTED'].includes(values.status) && !platformId) throw new Error('核对投稿需提供 --platform-id');
      if (platformId && jobs.some(other => other.id !== job.id && other.accountId === job.accountId && other.platformId === platformId)) {
        throw new Error('该平台回执已属于另一条记录');
      }
      transition(job, values.status, { note: values.note.trim(), ...(platformId ? { platformId } : {}) });
      await store.save(); log(JSON.stringify({ id: job.id, status: job.status }, null, 2)); return job;
    }
    if (command === 'report') {
      const report = makeReport(config, jobs, date); log(JSON.stringify(report, null, 2)); return report;
    }
    preflight(config, jobs, date);
    if (command === 'plan' || !values.publish) {
      const chosen = values.account ? { ...config, accounts: [account] } : config;
      const materialsByAccount = {};
      for (const a of chosen.accounts) {
        const options = { minFileAgeSeconds: config.minFileAgeSeconds, recursive: config.scanRecursive === true };
        materialsByAccount[a.id] = a.materialFile ? [await inspectMaterial(a.materialFile, options)] : await scanMaterials(a.materialDir, options);
      }
      const plan = buildPlan({ config: chosen, date, jobs, materialsByAccount });
      jobs.push(...plan.jobs); preflight(config, jobs, date); await store.save();
      const preview = { date, remoteWrites: false, ...plan, plannedJobs: jobs.filter(j => j.date === date && j.status === 'PLANNED' && (!values.account || j.accountId === values.account)) };
      await atomicJson(path.join(config.dataDir, 'plan-preview.json'), preview);
      log(JSON.stringify(preview, null, 2)); return plan;
    }
    const { loadProfile, openAccount } = await import('./browser.mjs');
    const ui = await loadProfile(config, { live: false });
    if (values['plan-digest'] && batchDigest(config,jobs,date,ui,values.account ?? null) !== values['plan-digest']) throw new Error('确认后的批次或设置已变化，请重新预览并确认（digest 不匹配）');
    const selected = config.accounts.filter(a => (!values.account || a.id === values.account) && jobs.some(j => j.accountId === a.id && j.date === date && j.status === 'PLANNED'));
    const { validateProfile } = await import('./douyin-page.mjs');
    for (const a of selected) validateProfile(ui, { mode: a.mode ?? 'task' });
    log(`执行已保存计划：${selected.map(a => a.id).join(', ')}。登录失效或结果不明时暂停该账号。`);
    const outcomes = await runJobs({ config, jobs, date, confirmed: true, save: store.save,
      openAccount: a => openAccount(config, ui, a), accountId: values.account, log });
    const report = { ...makeReport(config, jobs, date), outcomes };
    await atomicJson(path.join(config.dataDir, 'last-report.json'), report);
    log(JSON.stringify(report, null, 2));
    if (outcomes.some(o => ['BLOCKED', 'UNKNOWN', 'FAILED_BEFORE_SUBMIT'].includes(o.status))) {
      throw new Error('部分投稿暂停/待核对，详见 data/last-report.json');
    }
    return report;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
