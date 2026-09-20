import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPlan } from '../src/planner.mjs';

const date = '2026-09-16';
const tasks = [1, 2, 3].map((n) => ({ id: `task-${n}`, name: `Task ${n}` }));
const account = (id = 'alpha') => ({ id, materialDir: path.resolve('fixture', id), titleTemplate: '{filename}', tasks });
const config = (accounts = [account()]) => ({ dailyTarget: 9, maxAttemptsPerDay: 18, accounts });
const materials = (n = 30) => Array.from({ length: n }, (_, i) => ({ path: path.resolve('fixture', `clip-${String(i).padStart(2, '0')}.mp4`), hash: `hash-${i}`, size: 10, mtimeMs: 1 }));
const existing = (n, status, overrides = {}) => Array.from({ length: n }, (_, i) => ({ id: `job-${i}`, accountId: 'alpha', date, taskId: tasks[i % 3].id, taskName: tasks[i % 3].name, path: `old-${i}.mp4`, hash: `used-${i}`, title: `Old ${i}`, status, ...overrides }));
const plan = (jobs = [], extra = {}) => buildPlan({ config: config(), date, jobs, materialsByAccount: { alpha: materials() }, ...extra });

test('reserves nine jobs with every task covered and complete job records', () => {
  const result = plan();
  assert.equal(result.jobs.length, 9);
  assert.equal(new Set(result.jobs.map((job) => job.id)).size, 9);
  assert.deepEqual(new Set(result.jobs.map((job) => job.taskId)), new Set(tasks.map((task) => task.id)));
  assert.ok(result.jobs.every((job) => job.accountId === 'alpha' && job.date === date && job.status === 'PLANNED' && job.title === path.basename(job.path, '.mp4')));
  assert.deepEqual(result.summaries[0], { accountId: 'alpha', occupied: 9, attempts: 0, approved: 0, missingTaskIds: [], newJobs: 9, reason: 'TARGET_RESERVED' });
});

test('restarting preserves existing plans and creates only unfilled slots', () => {
  const first = plan();
  const snapshot = structuredClone(first.jobs);
  assert.equal(plan(first.jobs).jobs.length, 0);
  assert.deepEqual(first.jobs, snapshot);
  assert.equal(plan(first.jobs.slice(0, 4)).jobs.length, 5);
});

test('pending review reserves slots and rejected jobs permit attempts beyond nine', () => {
  const jobs = [...existing(8, 'REJECTED'), ...existing(5, 'PENDING_REVIEW', { hash: 'pending' })];
  const result = plan(jobs);
  assert.equal(result.jobs.length, 4);
  assert.equal(result.summaries[0].attempts, 13);
  assert.equal(result.summaries[0].occupied, 9);
});

test('existing plans reserve attempt budget and budget cap stops replacements', () => {
  const result = plan([...existing(15, 'REJECTED'), ...existing(2, 'PLANNED', { hash: 'reserved' })]);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.summaries[0].attempts, 15);
  assert.equal(result.summaries[0].reason, 'ATTEMPT_LIMIT');
  assert.equal(plan(existing(18, 'REJECTED')).jobs.length, 0);
});

for (const status of ['RUNNING', 'SUBMITTING', 'UNKNOWN']) {
  test(`${status} from any date blocks new work`, () => {
    const result = plan(existing(1, status, { date: '2026-09-15' }));
    assert.equal(result.jobs.length, 0);
    assert.equal(result.summaries[0].reason, 'UNRESOLVED_EXECUTION');
  });
}

for (const status of ['PLANNED', 'PENDING_REVIEW']) {
  test(`older ${status} blocks the next date conservatively`, () => {
    const result = plan(existing(1, status, { date: '2026-09-15' }));
    assert.equal(result.jobs.length, 0);
    assert.equal(result.summaries[0].reason, 'UNRESOLVED_PREVIOUS_DATE');
  });
}

test('content hashes prevent reuse after rename, including rejected jobs on earlier dates', () => {
  const pool = materials(4);
  pool.push({ ...pool[2], path: path.resolve('fixture', 'renamed-copy.mp4') });
  const result = plan(existing(1, 'REJECTED', { date: '2026-09-15', hash: pool[0].hash, path: 'old-name.mp4' }), { materialsByAccount: { alpha: pool } });
  assert.equal(result.jobs.length, 3);
  assert.equal(new Set(result.jobs.map((job) => job.hash)).size, 3);
  assert.ok(result.jobs.every((job) => job.hash !== pool[0].hash));
});

test('cancelled and known pre-submit failures allow safe material reuse', () => {
  for (const status of ['CANCELLED', 'FAILED_BEFORE_SUBMIT']) {
    const result = plan(existing(1, status, { hash: 'hash-0' }), { materialsByAccount: { alpha: materials(1) } });
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].hash, 'hash-0');
    assert.equal(result.summaries[0].attempts, status === 'CANCELLED' ? 0 : 1);
  }
});

test('same material may be used by independent accounts', () => {
  const result = plan(existing(1, 'APPROVED', { hash: 'hash-0' }), {
    config: config([account(), account('beta')]),
    materialsByAccount: { alpha: materials(1), beta: materials(1) },
  });
  assert.deepEqual(result.jobs.map((job) => job.accountId), ['beta']);
});

test('missing tasks take priority over random assignments when only two slots remain', () => {
  const result = plan(existing(7, 'APPROVED', { taskId: 'task-1', taskName: 'Task 1' }));
  assert.deepEqual(result.jobs.map((job) => job.taskId), ['task-2', 'task-3']);
  assert.equal(result.summaries[0].approved, 7);
});

test('reports insufficient coverage capacity while allocating missing tasks first', () => {
  const result = plan(existing(8, 'APPROVED', { taskId: 'task-1' }));
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].taskId, 'task-2');
  assert.deepEqual(result.summaries[0].missingTaskIds, ['task-3']);
  assert.equal(result.summaries[0].reason, 'TASK_COVERAGE_SHORTAGE');
});

test('reports insufficient materials without repeating covered tasks', () => {
  const result = plan([], { materialsByAccount: { alpha: materials(2) } });
  assert.deepEqual(result.jobs.map((job) => job.taskId), ['task-1', 'task-2']);
  assert.deepEqual(result.summaries[0].missingTaskIds, ['task-3']);
  assert.equal(result.summaries[0].reason, 'TASK_COVERAGE_SHORTAGE');
});

test('task choices are stable independently of material input order and inputs stay unchanged', () => {
  const pool = materials();
  const input = { config: config(), date, jobs: [], materialsByAccount: { alpha: pool } };
  const snapshot = structuredClone(input);
  const result = buildPlan(input);
  const shuffled = plan([], { materialsByAccount: { alpha: [...pool].reverse() } });
  assert.deepEqual(result.jobs.map(({ hash, taskId }) => ({ hash, taskId })), shuffled.jobs.map(({ hash, taskId }) => ({ hash, taskId })));
  assert.deepEqual(input, snapshot);
});

test('filename substitutions fit 30 Unicode code points while retaining template literals', () => {
  const unicodeAccount = { ...account(), titleTemplate: '前缀 {filename} 后缀' };
  const pool = [{ ...materials(1)[0], path: path.resolve('fixture', `${'😀'.repeat(40)}.MP4`) }];
  const result = plan([], { config: config([unicodeAccount]), materialsByAccount: { alpha: pool } });
  assert.equal(Array.from(result.jobs[0].title).length, 30);
  assert.ok(result.jobs[0].title.startsWith('前缀 ') && result.jobs[0].title.endsWith(' 后缀'));
  assert.ok(!result.jobs[0].title.includes('\uFFFD'));
});

test('unrepresentable literal titles fail clearly', () => {
  assert.throws(() => plan([], { config: config([{ ...account(), titleTemplate: '字'.repeat(31) }]) }), /30/);
});

test('new jobs retain the expected account identity at planning time', () => {
  const namedAccount = { ...account(), expectedIdentity: 'Demo account A' };
  const result = plan([], { config: config([namedAccount]) });
  namedAccount.expectedIdentity = 'Different account';
  assert.ok(result.jobs.every((job) => job.expectedIdentity === 'Demo account A'));
});
