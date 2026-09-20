import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, utimes, symlink, rm, stat } from 'node:fs/promises';
import { scanMaterials, verifyMaterial } from '../src/materials.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'douyin-materials-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('douyin-materials-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function oldFile(directory, name, bytes = 'video fixture') {
  const filename = path.join(directory, name);
  await writeFile(filename, bytes);
  const then = new Date(Date.now() - 120_000);
  await utimes(filename, then, then);
  return filename;
}

test('recursively returns only ready video files with SHA-256 and stable sorted paths', async (t) => {
  const root = await fixture(t);
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  const videos = [await oldFile(root, 'z.MP4', 'video z'), await oldFile(nested, 'a.mov', 'video a'), await oldFile(root, 'b.m4v', 'video b')];
  await oldFile(root, 'notes.txt');
  const result = await scanMaterials(root);
  assert.deepEqual(result.map((file) => file.path), videos.sort());
  assert.equal(result.find((file) => file.path.endsWith('z.MP4')).hash, createHash('sha256').update('video z').digest('hex'));
  assert.ok(result.every((file) => path.isAbsolute(file.path) && file.size > 0 && Number.isFinite(file.mtimeMs)));
});

test('skips zero-byte files and files younger than the configured readiness age', async (t) => {
  const root = await fixture(t);
  await oldFile(root, 'empty.mp4', '');
  await writeFile(path.join(root, 'recent.mp4'), 'recent');
  const ready = await oldFile(root, 'ready.mp4');
  const result = await scanMaterials(root);
  assert.deepEqual(result.map((file) => file.path), [ready]);
  const allNonempty = await scanMaterials(root, { minFileAgeSeconds: 0 });
  assert.equal(allNonempty.length, 2);
});

test('readiness uses the supplied clock deterministically', async (t) => {
  const root = await fixture(t);
  const file = await oldFile(root, 'clip.mp4');
  const info = await stat(file);
  assert.equal((await scanMaterials(root, { now: info.mtimeMs + 59_999 })).length, 0);
  assert.equal((await scanMaterials(root, { now: info.mtimeMs + 60_000 })).length, 1);
});

test('does not follow directory symlinks or junctions', async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, 'outside');
  const inside = path.join(root, 'inside');
  await mkdir(outside);
  await mkdir(inside);
  await oldFile(outside, 'not-scanned.mp4');
  const local = await oldFile(inside, 'local.mp4');
  await symlink(outside, path.join(inside, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual((await scanMaterials(inside)).map((file) => file.path), [local]);
  await assert.rejects(scanMaterials(path.join(inside, 'linked')), /symlink|symbolic|local directory/i);
});

test('refuses remote and device path forms before touching filesystem', async () => {
  for (const directory of ['\\\\server\\share\\video', '//server/share/video', 'https://server/video', 'file://server/share', '\\\\?\\C:\\video']) {
    await assert.rejects(scanMaterials(directory), /local|UNC|remote/i);
  }
});

test('rejects a material directory reached through a symbolic-link ancestor', async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, 'outside');
  const nested = path.join(outside, 'nested');
  await mkdir(nested, { recursive: true });
  await oldFile(nested, 'not-scanned.mp4');
  const linked = path.join(root, 'linked');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(scanMaterials(path.join(linked, 'nested')), /symlink|symbolic|local directory/i);
});

test('skips a file whose metadata changes while its content is being hashed', async (t) => {
  const root = await fixture(t);
  const file = await oldFile(root, 'changing.mp4', Buffer.alloc(32 * 1024 * 1024, 65));
  const now = Date.now();
  let touches = 0;
  const pendingTouches = [];
  const timer = setInterval(() => {
    touches += 1;
    const changed = new Date(now - 120_000 + touches * 1000);
    pendingTouches.push(utimes(file, changed, changed));
  }, 2);
  let result;
  try {
    result = await scanMaterials(root, { now: now + 600_000 });
  } finally {
    clearInterval(timer);
    await Promise.all(pendingTouches);
  }
  assert.ok(touches > 0, 'fixture must change during scan');
  assert.equal(result.length, 0);
});

test('verifies one planned file and returns its current metadata', async (t) => {
  const root = await fixture(t);
  await oldFile(root, 'planned.mp4', 'original video');
  const [planned] = await scanMaterials(root);
  const verified = await verifyMaterial(planned, root);
  assert.deepEqual(verified, planned);
});

test('verification rejects replaced and missing planned material', async (t) => {
  const root = await fixture(t);
  const file = await oldFile(root, 'planned.mp4', 'original video');
  const [planned] = await scanMaterials(root);
  await oldFile(root, 'planned.mp4', 'replacement content');
  await assert.rejects(verifyMaterial(planned, root), /changed|hash|material/i);
  await rm(file);
  await assert.rejects(verifyMaterial(planned, root), /missing|material|ready/i);
});

test('verification rejects material outside its configured directory', async (t) => {
  const root = await fixture(t);
  const allowed = path.join(root, 'allowed');
  const other = path.join(root, 'allowed-other');
  await mkdir(allowed);
  await mkdir(other);
  await oldFile(other, 'elsewhere.mp4');
  const [planned] = await scanMaterials(other);
  await assert.rejects(verifyMaterial(planned, allowed), /outside|within|directory/i);
});

test('verification rejects newly rewritten material even when content is unchanged', async (t) => {
  const root = await fixture(t);
  const file = await oldFile(root, 'planned.mp4', 'original video');
  const [planned] = await scanMaterials(root);
  await writeFile(file, 'original video');
  await assert.rejects(verifyMaterial(planned, root), /recent|ready|material/i);
});

test('verification rejects a planned path rerouted through a junction', async (t) => {
  const root = await fixture(t);
  const original = path.join(root, 'original');
  const linked = path.join(root, 'linked');
  await mkdir(original);
  await oldFile(original, 'planned.mp4');
  const [planned] = await scanMaterials(original);
  await symlink(original, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyMaterial({ ...planned, path: path.join(linked, 'planned.mp4') }, root), /link|local directory/i);
});
