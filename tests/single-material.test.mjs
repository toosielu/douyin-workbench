import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { inspectMaterial } from '../src/materials.mjs';

test('inspect exact file and reject unready input, without enumerating directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-single-'));
  try {
    const video = path.join(dir, 'test1.mp4'); await writeFile(video, 'fixture', 'utf8');
    const found = await inspectMaterial(video, { minFileAgeSeconds: 0, now: Date.now() + 1000 });
    assert.equal(found.path, video); assert.match(found.hash, /^[a-f0-9]{64}$/);
    await assert.rejects(inspectMaterial(video, { minFileAgeSeconds: 86400 }), /ready|就绪/);
    await assert.rejects(inspectMaterial(path.join(dir, 'missing.mp4')), /ready|就绪/);
    await assert.rejects(inspectMaterial(path.join(dir, 'not-a-video.txt')), /video|视频/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
