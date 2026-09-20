import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { buildPlan } from '../src/planner.mjs';
import { preflight } from '../src/preflight.mjs';
import { makeReport } from '../src/report.mjs';

const date = '2026-09-17';
const account = (overrides = {}) => ({ id: 'a', expectedIdentity: 'demo-a',
  materialDir: './clips', titleTemplate: '{filename}',
  tasks: [{ id: 'task-1', name: 'Task 1' }], ...overrides });
const rawConfig = (accounts = [account()]) => ({ dataDir: './data', uiFile: './ui.json',
  dailyTarget: 2, maxAttemptsPerDay: 4, minFileAgeSeconds: 0, intervalSeconds: 0, accounts });
const ordinaryAccount = (overrides = {}) => account({ mode: 'ordinary', tasks: [], ...overrides });
const material = (n = 1) => ({ path: path.resolve('clips', `clip-${n}.mp4`),
  hash: String(n).repeat(64), size: 10, mtimeMs: 1 });
const job = (overrides = {}) => ({ id: 'j1', accountId: 'a', expectedIdentity: 'demo-a', date,
  mode: 'task', taskId: 'task-1', taskName: 'Task 1', path: material().path,
  hash: material().hash, title: 'Clip 1', status: 'PLANNED', ...overrides });
const ordinaryJob = (overrides = {}) => job({ mode: 'ordinary', taskId: null, taskName: null, ...overrides });
const plan = (config, jobs = [], materialsByAccount = { a: [material(), material(2)] }) =>
  buildPlan({ config, date, jobs, materialsByAccount });

test('missing mode defaults to task and preserves its required task list', () => {
  const c = normalizeConfig(rawConfig());
  assert.equal(c.accounts[0].mode, 'task');
  assert.equal(plan(c).jobs[0].mode, 'task');
  assert.throws(() => normalizeConfig(rawConfig([account({ tasks: [] })])), /tasks/i);
  const missing = account(); delete missing.tasks;
  assert.throws(() => normalizeConfig(rawConfig([missing])), /tasks/i);
});

test('ordinary configuration accepts absent or empty tasks without mutating input', () => {
  for (const tasks of [undefined, []]) {
    const input = rawConfig([ordinaryAccount({ tasks })]);
    const snapshot = structuredClone(input);
    const c = normalizeConfig(input);
    assert.equal(c.accounts[0].mode, 'ordinary');
    assert.deepEqual(c.accounts[0].tasks, []);
    assert.deepEqual(input, snapshot);
  }
});

test('ordinary configuration rejects task associations and invalid task containers', () => {
  for (const tasks of [[{ id: 'x', name: 'Task X' }], null, {}, '']) {
    assert.throws(() => normalizeConfig(rawConfig([ordinaryAccount({ tasks })])), /tasks/i);
  }
});

test('configuration rejects unknown or null account modes', () => {
  for (const mode of ['normal', '', null, 1]) {
    assert.throws(() => normalizeConfig(rawConfig([account({ mode })])), /mode/i);
  }
});

test('materialFile resolves relative to config base and stays strictly within materialDir', () => {
  const base = path.resolve('fixture-config');
  const c = normalizeConfig(rawConfig([account({ materialFile: './clips/nested/../selected.mp4' })]), base);
  assert.equal(c.accounts[0].materialFile, path.join(base, 'clips', 'selected.mp4'));
  for (const materialFile of ['./outside.mp4', './clips/../outside.mp4', './clips', './clips-copy/file.mp4']) {
    assert.throws(() => normalizeConfig(rawConfig([account({ materialFile })]), base), /within|materialFile|directory/i);
  }
});

test('materialFile rejects network paths and invalid values', () => {
  for (const materialFile of ['\\\\server\\share\\clip.mp4', '//server/share/clip.mp4',
    'https://example.com/clip.mp4', '', null]) {
    assert.throws(() => normalizeConfig(rawConfig([account({ materialFile })])), /local|本地|materialFile/i);
  }
});

test('materialFile containment uses Windows path case semantics', { skip: process.platform !== 'win32' }, () => {
  const c = normalizeConfig(rawConfig([account({ materialDir: 'C:\\Demo\\Clips',
    materialFile: 'c:\\demo\\clips\\selected.mp4' })]));
  assert.equal(c.accounts[0].materialFile, path.resolve('c:\\demo\\clips\\selected.mp4'));
  assert.throws(() => normalizeConfig(rawConfig([account({ materialDir: 'C:\\Demo\\Clips',
    materialFile: 'D:\\Demo\\Clips\\selected.mp4' })])), /within|materialFile|directory/i);
});

test('ordinary plans persist mode and null task fields with empty coverage', () => {
  const c = normalizeConfig(rawConfig([ordinaryAccount()]));
  const result = plan(c);
  assert.equal(result.jobs.length, 2);
  for (const j of result.jobs) {
    assert.equal(j.mode, 'ordinary');
    assert.equal(j.taskId, null);
    assert.equal(j.taskName, null);
    assert.equal(j.expectedIdentity, 'demo-a');
  }
  assert.deepEqual(result.summaries[0].missingTaskIds, []);
  assert.equal(result.summaries[0].reason, 'TARGET_RESERVED');
  assert.doesNotThrow(() => preflight(c, result.jobs, date));
});

test('ordinary material shortage never creates missing task coverage', () => {
  const c = rawConfig([ordinaryAccount()]);
  const result = plan(c, [], { a: [] });
  assert.deepEqual(result.jobs, []);
  assert.deepEqual(result.summaries[0].missingTaskIds, []);
  assert.equal(result.summaries[0].reason, 'MATERIAL_SHORTAGE');
});

test('mixed account plans retain ordinary and task semantics independently', () => {
  const c = normalizeConfig(rawConfig([ordinaryAccount(), account({ id: 'b', expectedIdentity: 'demo-b' })]));
  const result = plan(c, [], { a: [material()], b: [material()] });
  assert.equal(result.jobs.length, 2);
  assert.deepEqual(result.jobs.map(({ accountId, mode, taskId }) => ({ accountId, mode, taskId })), [
    { accountId: 'a', mode: 'ordinary', taskId: null }, { accountId: 'b', mode: 'task', taskId: 'task-1' },
  ]);
  assert.doesNotThrow(() => preflight(c, result.jobs, date));
});

test('preflight accepts legacy task jobs without rewriting their mode', () => {
  const legacy = job(); delete legacy.mode;
  assert.doesNotThrow(() => preflight(rawConfig(), [legacy], date));
  assert.equal(Object.hasOwn(legacy, 'mode'), false);
});

test('preflight rejects unknown persisted modes and task fields on ordinary jobs', () => {
  const c = rawConfig([ordinaryAccount()]);
  for (const mode of ['invalid', '', null]) {
    assert.throws(() => preflight(rawConfig(), [job({ mode })], date), /record|mode/i);
  }
  for (const fields of [{ taskId: 'task-1' }, { taskName: 'Task 1' }, { taskId: undefined }, { taskName: undefined }]) {
    assert.throws(() => preflight(c, [ordinaryJob(fields)], date), /record|task/i);
  }
});

test('planned jobs require cancel and replan after either account mode change', () => {
  assert.throws(() => preflight(rawConfig([ordinaryAccount()]), [job()], date), /mode.*cancel.*replan/i);
  assert.throws(() => preflight(rawConfig(), [ordinaryJob()], date), /mode.*cancel.*replan/i);
});

test('planned jobs require cancel and replan when the selected material file changes', () => {
  for (const [configuredAccount, plannedJob] of [
    [ordinaryAccount({ materialFile: material(2).path }), ordinaryJob()],
    [account({ materialFile: material(2).path }), job()],
  ]) {
    const c = normalizeConfig(rawConfig([configuredAccount]));
    assert.throws(() => preflight(c, [plannedJob], date), /material.*cancel.*replan/i);
    assert.doesNotThrow(() => preflight(c, [{ ...plannedJob, path: material(2).path }], date));
    assert.doesNotThrow(() => preflight(c, [{ ...plannedJob, status: 'APPROVED' }], date));
  }
});

test('selected material comparison follows normalized Windows path semantics', { skip: process.platform !== 'win32' }, () => {
  const c = normalizeConfig(rawConfig([ordinaryAccount({ materialDir: 'C:\\Demo\\Clips',
    materialFile: 'C:\\Demo\\Clips\\selected.mp4' })]));
  assert.doesNotThrow(() => preflight(c, [ordinaryJob({ path: 'c:\\demo\\clips\\nested\\..\\selected.mp4' })], date));
  assert.throws(() => preflight(c, [ordinaryJob({ path: 'C:\\Other\\Clips\\selected.mp4' })], date), /material.*cancel.*replan/i);
});

test('historical jobs retain their original modes after an account mode change', () => {
  assert.doesNotThrow(() => preflight(rawConfig([ordinaryAccount()]), [job({ status: 'APPROVED' })], date));
  assert.doesNotThrow(() => preflight(rawConfig(), [ordinaryJob({ status: 'APPROVED' })], date));
  const changed = rawConfig([ordinaryAccount({ id: 'renamed' })]);
  assert.throws(() => preflight(changed, [job({ status: 'APPROVED' })], date), /mapping|identity/i);
});

test('same account material hash stays reserved across ordinary and task modes', () => {
  for (const [c, historical] of [
    [rawConfig([ordinaryAccount()]), job({ status: 'REJECTED', date: '2026-09-16' })],
    [rawConfig(), ordinaryJob({ status: 'REJECTED', date: '2026-09-16' })],
  ]) {
    const result = plan(c, [historical]);
    assert.deepEqual(result.jobs.map(j => j.hash), [material(2).hash]);
  }
  assert.throws(() => preflight(rawConfig([ordinaryAccount()]), [job({ status: 'APPROVED' }),
    ordinaryJob({ id: 'j2' })], date), /duplicate material/i);
});

test('report rows expose modes and ordinary jobs do not create null task coverage', () => {
  const legacy = job({ id: 'legacy', status: 'APPROVED', hash: material(3).hash }); delete legacy.mode;
  const jobs = [ordinaryJob({ status: 'APPROVED' }),
    ordinaryJob({ id: 'pending', status: 'PENDING_REVIEW', hash: material(2).hash }), legacy];
  const result = makeReport(rawConfig([ordinaryAccount()]), jobs, date);
  assert.deepEqual(result.jobs.map(j => j.mode), ['ordinary', 'ordinary', 'task']);
  assert.deepEqual(result.accounts[0].submittedTaskIds, ['task-1']);
  assert.deepEqual(result.accounts[0].approvedTaskIds, ['task-1']);
  const ordinaryOnly = makeReport(rawConfig([ordinaryAccount()]), jobs.slice(0, 2), date);
  assert.deepEqual(ordinaryOnly.accounts[0].submittedTaskIds, []);
  assert.deepEqual(ordinaryOnly.accounts[0].approvedTaskIds, []);
});
