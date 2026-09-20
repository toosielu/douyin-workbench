import { setTimeout as delay } from 'node:timers/promises';
import { transition } from './store.mjs';
import { businessDate } from './config.mjs';
import {archiveOrdinary} from './ordinary-archive.mjs';

export async function runJobs({ config, jobs, date, confirmed = false, save, openAccount,
  accountId, log = () => {}, getDate = businessDate, shouldStop = () => false }) {
  if (confirmed !== true) throw new Error('confirm remote write before upload');
  const outcomes = [];
  for (const account of config.accounts.filter(a => !accountId || a.id === accountId)) {
    if (shouldStop()) break;
    const accountJobs = jobs.filter(j => j.accountId === account.id);
    if (accountJobs.some(j => ['RUNNING', 'SUBMITTING', 'UNKNOWN'].includes(j.status) ||
      (j.date < date && ['PLANNED', 'PENDING_REVIEW'].includes(j.status)))) {
      outcomes.push({ accountId: account.id, status: 'BLOCKED', reason: '先核对未决投稿/旧计划' }); continue;
    }
    const queue = accountJobs.filter(j => j.date === date && j.status === 'PLANNED');
    if (!queue.length) continue;
    let session;
    try {
      try { session = await openAccount(account); }
      catch (e) { outcomes.push({ accountId: account.id, status: 'BLOCKED', reason: e.message }); continue; }
      for (const job of queue) {
        if (shouldStop()) break;
        if (getDate() !== date) {
          outcomes.push({ accountId: account.id, status: 'BLOCKED', reason: '日期已变化，请核对旧计划' }); break;
        }
        transition(job, 'RUNNING'); await save();
        log(`${account.id} / ${job.id}: 准备上传与任务绑定`);
        try { await session.prepare(job); }
        catch (e) {
          transition(job, 'FAILED_BEFORE_SUBMIT', { error: e.message }); await save();
          outcomes.push({ accountId: account.id, jobId: job.id, status: job.status }); break;
        }
        if (getDate() !== date) {
          transition(job, 'FAILED_BEFORE_SUBMIT', { error: '上传准备期间跨日，未点击发布，请核对后重新规划' }); await save();
          outcomes.push({ accountId: account.id, jobId: job.id, status: job.status }); break;
        }
        // Persist intent BEFORE the click. On restart SUBMITTING blocks any retry.
        transition(job, 'SUBMITTING'); await save();
        let result;
        try {
          result = await session.publish(job);
          if (result?.status !== 'PENDING_REVIEW' || !result.platformId) throw new Error('Missing unique submission receipt');
          if (jobs.some(other => other.id !== job.id && other.accountId === job.accountId && other.platformId === result.platformId)) {
            throw new Error('Duplicate submission receipt，先核对平台作品');
          }
        } catch (e) {
          transition(job, 'UNKNOWN', { error: e.message, ...(e.receiptFailure?{receiptFailure:e.receiptFailure}:{}) }); await save();
          outcomes.push({ accountId: account.id, jobId: job.id, status: job.status }); break;
        }
        transition(job, 'PENDING_REVIEW', { platformId: result.platformId,
          ...(result.receiptEvidence ? {receiptEvidence:result.receiptEvidence} : {}) }); await save();
        log(`${account.id} / ${job.id}: 已接收，待核对平台及任务审核`);
        if(config.archivePublished && account.mode==='ordinary'){
          try{await archiveOrdinary(account,job,save);log(`归档：${job.archive.archiveStatus} ${job.archive.archiveTarget??''}`);}
          catch(error){job.archiveFailure=error.message;await save();log(`已接收但归档失败，不会重发：${error.message}`);}
        }
        outcomes.push({ accountId: account.id, jobId: job.id, status: job.status });
        if (config.intervalSeconds > 0) await delay(config.intervalSeconds * 1000);
      }
    } finally { if (session) await session.close(); }
  }
  return outcomes;
}
