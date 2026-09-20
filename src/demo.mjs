import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { businessDate } from './config.mjs';
import { buildPlan } from './planner.mjs';
import { runJobs } from './runner.mjs';
import { makeReport } from './report.mjs';
import { atomicJson, transition } from './store.mjs';

export async function runDemo({ outputDir = path.resolve('demo-output'), log = console.log } = {}) {
  log('【纯本地模拟】不会打开抖音，不读取真实素材，不会上传或发布。');
  const date = businessDate();
  const config = { dailyTarget: 9, maxAttemptsPerDay: 18, intervalSeconds: 0,
    accounts: ['demo-a', 'demo-b'].map(id => ({ id, expectedIdentity: `模拟账号 ${id}`, titleTemplate: '{filename}',
      tasks: ['101', '102', '103'].map(id => ({ id, name: `模拟牙膏任务 ${id}` })) })) };
  const materials = Array.from({ length: 12 }, (_, i) => ({ path: `DEMO_ONLY/素材${String(i + 1).padStart(2, '0')}.mp4`,
    hash: createHash('sha256').update(`synthetic-material-${i}`).digest('hex'), size: 1, mtimeMs: 0 }));
  const materialsByAccount = Object.fromEntries(config.accounts.map(a => [a.id, materials]));
  const first = buildPlan({ config, date, jobs: [], materialsByAccount });
  const jobs = first.jobs;
  const openAccount = async account => ({
    prepare: async job => log(`[模拟] ${account.id} → ${job.title} → ${job.taskName}`),
    publish: async job => ({ status: 'PENDING_REVIEW', platformId: `SIMULATED-${job.id}` }), close: async () => {}
  });
  await runJobs({ config, date, jobs, confirmed: true, save: async () => {}, openAccount, getDate: () => date });
  log('【模拟驳回】账号 demo-a 的前三条被明确驳回，重新规划新素材补位。');
  for (const job of jobs.filter(j => j.accountId === 'demo-a').slice(0, 3)) transition(job, 'REJECTED', { note: 'SIMULATED_REJECTION' });
  const refill = buildPlan({ config, date, jobs, materialsByAccount });
  jobs.push(...refill.jobs);
  await runJobs({ config, date, jobs, confirmed: true, save: async () => {}, openAccount, getDate: () => date });
  const report = { simulation: true, explanation: '模拟接收不代表真实投稿或审核通过', ...makeReport(config, jobs, date) };
  await atomicJson(path.join(outputDir, 'plan.json'), { simulation: true, initial: first.summaries, refill: refill.summaries });
  await atomicJson(path.join(outputDir, 'report.json'), report);
  for (const a of report.accounts) log(`${a.accountId}: 模拟待审 ${a.counts.PENDING_REVIEW ?? 0}，驳回 ${a.counts.REJECTED ?? 0}，覆盖任务 ${a.submittedTaskIds.join(', ')}`);
  log(`模拟结果：${path.join(outputDir, 'report.json')}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDemo().catch(error => { console.error(error.message); process.exitCode = 1; });
}
