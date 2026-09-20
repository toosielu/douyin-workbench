import test from 'node:test';
import assert from 'node:assert/strict';
import { runJobs as execute } from '../src/runner.mjs';
const runJobs = options => execute({ getDate: () => '2026-09-16', ...options });

const jobs = () => ['a', 'a', 'b'].map((accountId, i) => ({ id: `j${i}`, accountId,
  date: '2026-09-16', taskId: 't1', hash: `${i}`, status: 'PLANNED' }));
const config = { intervalSeconds: 0, accounts: [{ id: 'a' }, { id: 'b' }] };
function rig(overrides = {}) {
  const events = [];
  return { events, openAccount: async account => ({
    prepare: async j => events.push(`prepare:${account.id}:${j.id}`),
    publish: async job => ({ platformId: job.id, status: 'PENDING_REVIEW' }),
    close: async () => events.push(`close:${account.id}`), ...overrides
  }) };
}
test('remote action requires explicit confirmation before opening browser', async () => {
  const r = rig();
  await assert.rejects(runJobs({ config, jobs: jobs(), save: async () => {},
    date: '2026-09-16', openAccount: r.openAccount }), /confirm/i);
  assert.equal(r.events.length, 0);
});
test('reused receipt is UNKNOWN and stops that account', async () => {
  const records = jobs(); const r = rig({ publish: async () => ({ platformId: '123', status: 'PENDING_REVIEW' }) });
  await runJobs({ config, jobs: records, date: '2026-09-16', confirmed: true, save: async () => {}, openAccount: r.openAccount });
  assert.deepEqual(records.map(j => j.status), ['PENDING_REVIEW', 'UNKNOWN', 'PENDING_REVIEW']);
});
test('crossing midnight stops new uploads under the old plan date', async () => {
  const records = jobs(); const r = rig();
  await runJobs({ config, jobs: records, date: '2026-09-16', getDate: () => '2026-09-17', confirmed: true,
    save: async () => {}, openAccount: r.openAccount });
  assert.equal(r.events.some(e => e.startsWith('prepare')), false);
});
test('upload crossing midnight is stopped before publishing', async () => {
  const records = jobs(); let date = '2026-09-16'; let clicks = 0;
  const r = rig({ prepare: async () => { date = '2026-09-17'; }, publish: async () => { clicks++; } });
  await runJobs({ config, jobs: records, date: '2026-09-16', getDate: () => date, confirmed: true,
    save: async () => {}, openAccount: r.openAccount });
  assert.equal(clicks, 0); assert.equal(records[0].status, 'FAILED_BEFORE_SUBMIT');
});
test('publish intent is durably saved first; separate sessions sequentially', async () => {
  const records = jobs(); const snapshots = []; const r = rig();
  await runJobs({ config, jobs: records, date: '2026-09-16', confirmed: true,
    save: async () => snapshots.push(records.map(j => j.status)), openAccount: r.openAccount });
  assert.equal(records.every(j => j.status === 'PENDING_REVIEW'), true);
  assert.equal(snapshots.some(s => s[0] === 'SUBMITTING'), true);
  assert.ok(r.events.indexOf('close:a') < r.events.indexOf('prepare:b:j2'));
});
test('uncertain click stops account and never retries while other account can proceed', async () => {
  const records = jobs(); let attempts = 0;
  const r = rig({ publish: async () => { attempts++; throw new Error('timeout'); } });
  await runJobs({ config, jobs: records, date: '2026-09-16', confirmed: true,
    save: async () => {}, openAccount: r.openAccount });
  assert.equal(attempts, 2);
  assert.deepEqual(records.map(j => j.status), ['UNKNOWN', 'PLANNED', 'UNKNOWN']);
  await runJobs({ config, jobs: records, date: '2026-09-16', confirmed: true,
    save: async () => {}, openAccount: r.openAccount });
  assert.equal(attempts, 2);
});
test('preparation error cannot trigger publish', async () => {
  const records = jobs(); let clicks = 0;
  const r = rig({ prepare: async () => { throw new Error('wrong account'); },
    publish: async () => { clicks++; } });
  await runJobs({ config, jobs: records, date: '2026-09-16', confirmed: true,
    save: async () => {}, openAccount: r.openAccount });
  assert.equal(clicks, 0); assert.equal(records[0].status, 'FAILED_BEFORE_SUBMIT');
});
test('failed journal write aborts instead of submitting or continuing another account', async () => {
  const r = rig(); let count = 0;
  await assert.rejects(runJobs({ config, jobs: jobs(), date: '2026-09-16', confirmed: true,
    save: async () => { if (++count === 2) throw new Error('disk full'); }, openAccount: r.openAccount }), /disk full/);
  assert.equal(r.events.some(e => e.startsWith('prepare:b')), false);
});
