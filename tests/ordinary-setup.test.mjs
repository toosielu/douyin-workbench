import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setupOrdinary } from '../src/ordinary-login.mjs';
import { main } from '../src/cli.mjs';

test('single-video setup writes ordinary config and cannot silently replace account binding', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-ordinary-'));
  try {
    const materialDir = path.join(dir, 'clips'); await mkdir(materialDir);
    const file = path.join(materialDir, 'test1.mp4'); await writeFile(file, 'fixture', 'utf8');
    // Windows filesystem timestamps can be finer than Date.now(); this fixture is ready material.
    const readyAt = new Date(Date.now() - 5000); await utimes(file, readyAt, readyAt);
    await writeFile(path.join(materialDir, 'another.mp4'), 'unrelated', 'utf8');
    const result = await setupOrdinary({ projectDir: dir, file, douyinId: 'dy123', minFileAgeSeconds: 0,
      uiTemplate: { uploadUrl: 'https://creator.douyin.com/creator-micro/content/post/video' } });
    const c = JSON.parse(await readFile(result.configFile, 'utf8'));
    assert.equal(c.accounts[0].mode, 'ordinary'); assert.deepEqual(c.accounts[0].tasks, []);
    assert.equal(c.accounts[0].materialFile, file); assert.equal(c.dailyTarget, 1);
    const plan = await main(['plan', '--config', result.configFile], { log() {} });
    assert.equal(plan.jobs.length, 1); assert.equal(plan.jobs[0].path, file); assert.equal(plan.jobs[0].taskId, null);
    await assert.rejects(setupOrdinary({ projectDir: dir, file, douyinId: 'other', minFileAgeSeconds: 0, uiTemplate: {} }), /已有|existing/);
    assert.equal(JSON.parse(await readFile(result.configFile, 'utf8')).accounts[0].expectedIdentity, 'dy123');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
