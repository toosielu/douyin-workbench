import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withStore } from '../src/store.mjs';

test('state survives restart and overlapping runs cannot acquire lock', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-store-'));
  try {
    await withStore(dir, async s => {
      await assert.rejects(withStore(dir, () => {}), /locked|正在运行/i);
      s.state.jobs.push({ id: 'j1', status: 'PLANNED' }); await s.save();
    });
    await withStore(dir, s => assert.equal(s.state.jobs[0].id, 'j1'));
    const bytes = await readFile(path.join(dir, 'ledger.json'));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('corrupt ledger fails closed without replacing it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-corrupt-'));
  try {
    await writeFile(path.join(dir, 'ledger.json'), '{broken', 'utf8');
    await assert.rejects(withStore(dir, () => {}), /ledger|JSON/i);
    assert.equal(await readFile(path.join(dir, 'ledger.json'), 'utf8'), '{broken');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
