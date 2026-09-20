import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, file); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

export async function withStore(directory, fn) {
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, 'run.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error('Store locked：已有进程正在运行；异常退出后请先核对进程和投稿状态，再移除 run.lock。');
    throw e;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
    await lock.sync();
    const file = path.join(directory, 'ledger.json');
    let state;
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') state = { version: 1, jobs: [] }; else throw e; }
    if (state?.version !== 1 || !Array.isArray(state.jobs)) throw new Error('Invalid ledger，禁止自动清空历史');
    const store = { state, save: () => atomicJson(file, state) };
    return await fn(store);
  } finally {
    await lock.close(); await unlink(lockPath);
  }
}

export function transition(job, status, detail = {}) {
  job.history ??= [];
  job.history.push({ from: job.status, to: status, at: new Date().toISOString(), ...detail });
  job.status = status; Object.assign(job, detail);
}
