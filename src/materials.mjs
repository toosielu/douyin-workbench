import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

const extensions = new Set(['.mp4', '.mov', '.m4v']);
const ignorable = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EBUSY']);

function resolveLocalPath(value) {
  if (typeof value !== 'string' || !value.trim()
    || /^[\\/]{2}/.test(value) || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    throw new Error('Materials must use a local directory; UNC, device, and remote paths are not allowed.');
  }
  return path.resolve(value);
}

function checkReadinessOptions(minFileAgeSeconds, now) {
  if (!Number.isFinite(minFileAgeSeconds) || minFileAgeSeconds < 0 || !Number.isFinite(now)) {
    throw new Error('Readiness requires a nonnegative minFileAgeSeconds and a finite local clock.');
  }
}

async function assertLocalDirectory(root) {
  // Inspect ancestors from the drive root downward so a junction cannot route
  // traversal outside the requested local directory before it is detected.
  let current = path.parse(root).root;
  const components = root.slice(current.length).split(path.sep).filter(Boolean);
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Materials must be a local directory, not a symbolic link.');
  }
}

function sameFile(a, b) {
  return a.isFile() && b.isFile()
    && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function hashReadyFile(filename, { minFileAgeSeconds, now }) {
  let handle;
  try {
    const before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size === 0
      || now - before.mtimeMs < minFileAgeSeconds * 1000) return null;

    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!sameFile(before, await handle.stat())) return null;
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const afterHandle = await handle.stat();
    const afterPath = await lstat(filename);
    if (!sameFile(before, afterHandle) || !sameFile(before, afterPath) || afterPath.isSymbolicLink()) return null;
    return { path: filename, hash: hash.digest('hex'), size: before.size, mtimeMs: before.mtimeMs };
  } catch (error) {
    if (ignorable.has(error.code)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Scan local regular files only, ignoring links, recent/empty/changing files. */
export async function inspectMaterial(file, { minFileAgeSeconds = 60, now = Date.now() } = {}) {
  const filename = resolveLocalPath(file);
  checkReadinessOptions(minFileAgeSeconds, now);
  if (!extensions.has(path.extname(filename).toLowerCase())) throw new Error('Unsupported video 文件类型');
  await assertLocalDirectory(path.dirname(filename));
  const material = await hashReadyFile(filename, { minFileAgeSeconds, now });
  if (!material) throw new Error('Material is not ready: missing, linked, empty or still changing');
  return material;
}

/** Scan a directory only when the caller has requested a whole directory. */
export async function scanMaterials(directory, { minFileAgeSeconds = 60, now = Date.now(), recursive = true } = {}) {
  const root = resolveLocalPath(directory);
  checkReadinessOptions(minFileAgeSeconds, now);
  await assertLocalDirectory(root);
  const results = [];

  async function visit(folder) {
    let entries;
    try {
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (ignorable.has(error.code)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) { if(recursive && !entry.name.startsWith('已发_')) await visit(filename); }
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        const material = await hashReadyFile(filename, { minFileAgeSeconds, now });
        if (material) results.push(material);
      }
    }
  }

  await visit(root);
  return results.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Recheck exactly one planned file before upload; never enumerate its siblings. */
export async function verifyMaterial(material, directory, { minFileAgeSeconds = 60, now = Date.now() } = {}) {
  const root = resolveLocalPath(directory);
  const filename = resolveLocalPath(material?.path);
  checkReadinessOptions(minFileAgeSeconds, now);
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Planned material must remain within its configured directory.');
  }
  if (typeof material.hash !== 'string' || !material.hash || !extensions.has(path.extname(filename).toLowerCase())) {
    throw new Error('Planned material must include a content hash and a supported video path.');
  }
  await assertLocalDirectory(path.dirname(filename));
  const fresh = await hashReadyFile(filename, { minFileAgeSeconds, now });
  if (!fresh) throw new Error('Planned material is missing, linked, changing, empty, or not ready.');
  if (fresh.hash !== material.hash) throw new Error('Planned material content hash has changed.');
  return fresh;
}
