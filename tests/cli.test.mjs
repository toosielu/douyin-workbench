import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { main } from '../src/cli.mjs';

test('plan and run default are offline; rerun preserves reservations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-cli-'));
  try {
    await mkdir(path.join(dir, 'clips'));
    for (let i = 1; i <= 4; i++) await writeFile(path.join(dir, `clips/${i}.mp4`), `fixture${i}`, 'utf8');
    const config = { dataDir: './data', uiFile: './missing-ui.json', dailyTarget: 3,
      maxAttemptsPerDay: 6, intervalSeconds: 0, minFileAgeSeconds: 0,
      accounts: ['a', 'b'].map(id => ({ id, expectedIdentity: id, materialDir: './clips',
        titleTemplate: '{filename}', tasks: ['1', '2', '3'].map(id => ({ id, name: id })) })) };
    const file = path.join(dir, 'config.json'); await writeFile(file, JSON.stringify(config), 'utf8');
    const log = () => {};
    const first = await main(['plan', '--config', file], { log });
    assert.equal(first.jobs.length, 6);
    const second = await main(['run', '--config', file], { log });
    assert.equal(second.jobs.length, 0);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'data/ledger.json'), 'utf8')).jobs.length, 6);
    await assert.rejects(main(['run', '--publish', '--config', file], { log }), /confirm-remote-write/);
    const report = await main(['report', '--config', file], { log });
    assert.equal(report.accounts.length, 2);
    const ledger = JSON.parse(await readFile(path.join(dir, 'data/ledger.json'), 'utf8'));
    ledger.jobs[0].status = 'UNKNOWN';
    await writeFile(path.join(dir, 'data/ledger.json'), JSON.stringify(ledger), 'utf8');
    await assert.rejects(main(['mark', '--config', file, '--job', ledger.jobs[0].id, '--status', 'PENDING_REVIEW',
      '--platform-id', '   ', '--note', '已经核对平台'], { log }), /platform-id/);
    const marked = await main(['mark', '--config', file, '--job', ledger.jobs[0].id, '--status', 'PENDING_REVIEW',
      '--platform-id', ' 90001 ', '--note', '已经核对平台'], { log });
    assert.equal(marked.platformId, '90001');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unknown flags/commands cannot silently cause a run', async () => {
  await assert.rejects(main(['run', '--publsih'], { log() {} }));
  await assert.rejects(main(['rn'], { log() {} }), /command|命令/);
});
