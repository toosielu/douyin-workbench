import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runDemo } from '../src/demo.mjs';

test('offline demo exercises two accounts and refills explicit rejection beyond nine attempts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-demo-'));
  try {
    const report = await runDemo({ outputDir: dir, log() {} });
    assert.equal(report.simulation, true);
    assert.equal(report.accounts.length, 2);
    assert.equal(report.accounts[0].counts.PENDING_REVIEW, 9);
    assert.equal(report.accounts[0].counts.REJECTED, 3);
    assert.equal(report.accounts[1].counts.PENDING_REVIEW, 9);
    assert.equal(report.accounts[0].submittedTaskIds.length, 3);
    assert.equal(report.accounts[0].approvedTaskIds.length, 0);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')).simulation, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
