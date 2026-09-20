import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {chooseCopy} from './copy-library.mjs';

const occupying = new Set(['PLANNED', 'RUNNING', 'SUBMITTING', 'UNKNOWN', 'PENDING_REVIEW', 'APPROVED']);
const unresolved = new Set(['RUNNING', 'SUBMITTING', 'UNKNOWN']);
const reusable = new Set(['CANCELLED', 'FAILED_BEFORE_SUBMIT']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function makeTitle(template, filename) {
  const parts = template.split('{filename}');
  const literalLength = Array.from(parts.join('')).length;
  if (literalLength > 30) throw new Error('Title template literal text exceeds 30 Unicode code points.');
  if (parts.length === 1) return template;
  const substitutionLimit = Math.floor((30 - literalLength) / (parts.length - 1));
  const basename = path.basename(filename, path.extname(filename));
  return parts.join(Array.from(basename).slice(0, substitutionLimit).join(''));
}

function chooseTask(account, date, material, slot) {
  const seed = JSON.stringify([account.id, date, material.hash, slot]);
  const index = createHash('sha256').update(seed).digest().readUInt32BE(0) % account.tasks.length;
  return account.tasks[index];
}

/**
 * Create additional reservations only; input jobs/materials remain unchanged.
 * Summary occupancy and missing tasks include new reservations. Attempts counts
 * started work; existing/new PLANNED jobs additionally reserve the attempt cap.
 * Titles preserve template literals and truncate each filename substitution by
 * Unicode code point to fit 30 characters. Oversized literal templates throw.
 */
export function buildPlan({ config, date, jobs, materialsByAccount }) {
  const created = [];
  const summaries = [];

  for (const account of config.accounts) {
    const mode = account.mode === undefined ? 'task' : account.mode;
    const tasks = mode === 'ordinary' ? [] : account.tasks;
    const history = jobs.filter((job) => job.accountId === account.id);
    const today = history.filter((job) => job.date === date);
    const active = today.filter((job) => occupying.has(job.status));
    const attempts = today.filter((job) => job.status !== 'PLANNED' && job.status !== 'CANCELLED').length;
    const planned = today.filter((job) => job.status === 'PLANNED').length;
    const covered = new Set(active.filter((job) => job.mode !== 'ordinary' && job.taskId != null).map((job) => job.taskId));
    const summary = {
      accountId: account.id,
      occupied: active.length,
      attempts,
      approved: today.filter((job) => job.status === 'APPROVED').length,
      missingTaskIds: tasks.filter((task) => !covered.has(task.id)).map((task) => task.id),
      newJobs: 0,
      reason: '',
    };
    summaries.push(summary);

    if (history.some((job) => unresolved.has(job.status))) {
      summary.reason = 'UNRESOLVED_EXECUTION';
      continue;
    }
    if (history.some((job) => job.date !== date && ['PLANNED', 'PENDING_REVIEW'].includes(job.status))) {
      summary.reason = 'UNRESOLVED_PREVIOUS_DATE';
      continue;
    }

    const usedHashes = new Set(history.filter((job) => !reusable.has(job.status)).map((job) => job.hash));
    const available = [...(materialsByAccount[account.id] ?? [])]
      .sort((a, b) => compare(a.path, b.path) || compare(a.hash, b.hash))
      .filter((material) => {
        if (usedHashes.has(material.hash)) return false;
        usedHashes.add(material.hash);
        return true;
      });
    const slots = Math.max(0, config.dailyTarget - active.length);
    const attemptRoom = Math.max(0, config.maxAttemptsPerDay - attempts - planned);
    const count = Math.min(slots, attemptRoom, available.length);
    const missing = tasks.filter((task) => !covered.has(task.id));

    for (let i = 0; i < count; i += 1) {
      const material = available[i];
      const task = mode === 'ordinary' ? null : missing[i] ?? chooseTask(account, date, material, active.length + i);
      created.push({
        id: randomUUID(),
        accountId: account.id,
        expectedIdentity: account.expectedIdentity,
        date,
        mode,
        taskId: task?.id ?? null,
        taskName: task?.name ?? null,
        path: material.path,
        hash: material.hash,
        title: config.copies ? '' : makeTitle(account.titleTemplate, material.path),
        ...(config.copies ? chooseCopy(config.copies,material.path) : {}),
        status: 'PLANNED',
      });
      if (task) covered.add(task.id);
    }

    summary.newJobs = count;
    summary.occupied += count;
    summary.missingTaskIds = tasks.filter((task) => !covered.has(task.id)).map((task) => task.id);
    if (summary.missingTaskIds.length) summary.reason = 'TASK_COVERAGE_SHORTAGE';
    else if (summary.occupied >= config.dailyTarget) summary.reason = 'TARGET_RESERVED';
    else if (count === attemptRoom) summary.reason = 'ATTEMPT_LIMIT';
    else summary.reason = 'MATERIAL_SHORTAGE';
  }

  return { jobs: created, summaries };
}
