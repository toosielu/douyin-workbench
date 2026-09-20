import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {loadCopyLibrary} from './copy-library.mjs';

export function localPath(value, base = process.cwd()) {
  if (typeof value !== 'string' || !value.trim() || /^[\\/]{2}/.test(value) || /^[a-z]+:\/\//i.test(value)) {
    throw new Error('Demo 只接受本地 local 文件路径，请先复制测试素材到本机。');
  }
  return path.resolve(base, value);
}

export function normalizeConfig(raw, base = process.cwd()) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid config');
  const c = structuredClone(raw);
  for (const [key, min, max] of [['dailyTarget', 1, 100], ['maxAttemptsPerDay', 1, 1000],
    ['minFileAgeSeconds', 0, 86400], ['intervalSeconds', 0, 3600]]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`Invalid ${key}`);
  }
  if (c.maxAttemptsPerDay < c.dailyTarget) throw new Error('maxAttemptsPerDay must be >= dailyTarget');
  c.dataDir = localPath(c.dataDir, base); c.uiFile = localPath(c.uiFile, base);
  if(c.copyFile !== undefined) c.copyFile = localPath(c.copyFile, base);
  for(const key of ['archivePublished','scanRecursive'])if(c[key]!==undefined&&typeof c[key]!=='boolean')throw Error(`Invalid ${key}`);
  if (!Array.isArray(c.accounts) || (c.accounts.length < 1 && c.setupPending !== true)) throw new Error('No accounts');
  const ids = new Set(); const identities = new Set();
  for (const a of c.accounts) {
    if (!a || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id ?? '') || ids.has(a.id.toLowerCase()) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(a.id)) throw new Error('Invalid/duplicate account id');
    ids.add(a.id.toLowerCase());
    if (typeof a.expectedIdentity === 'string') a.expectedIdentity = a.expectedIdentity.replace(/\s+/g, ' ').trim();
    if (typeof a.expectedIdentity !== 'string' || !a.expectedIdentity || identities.has(a.expectedIdentity)) {
      throw new Error('Invalid/duplicate account identity');
    }
    a.expectedIdentity = a.expectedIdentity.trim(); identities.add(a.expectedIdentity);
    a.mode = a.mode === undefined ? 'task' : a.mode;
    if (!['ordinary', 'task'].includes(a.mode)) throw new Error(`Invalid account mode: ${a.id}`);
    a.materialDir = localPath(a.materialDir, base);
    if (a.materialFile !== undefined) {
      a.materialFile = localPath(a.materialFile, base);
      const relative = path.relative(a.materialDir, a.materialFile);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`materialFile must remain within materialDir: ${a.id}`);
      }
    }
    if (typeof a.titleTemplate !== 'string' || !a.titleTemplate.trim()) throw new Error(`Missing titleTemplate: ${a.id}`);
    if (a.mode === 'ordinary') {
      if (a.tasks !== undefined && (!Array.isArray(a.tasks) || a.tasks.length !== 0)) throw new Error(`Invalid ordinary tasks: ${a.id}`);
      a.tasks = [];
    } else if (!Array.isArray(a.tasks) || a.tasks.length < 1 || a.tasks.length > c.dailyTarget) {
      throw new Error(`Invalid tasks: ${a.id}`);
    }
    const tasks = new Set();
    for (const t of a.tasks) {
      if (!t || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(t.id) || typeof t.name !== 'string' || !t.name.trim() || tasks.has(t.id)) {
        throw new Error(`Invalid/duplicate task: ${a.id}`);
      }
      tasks.add(t.id);
    }
  }
  c.browser = { headless: false, ...(c.browser ?? {}) };
  if (typeof c.browser.headless !== 'boolean' || (c.browser.channel && !['chrome', 'msedge'].includes(c.browser.channel))) {
    throw new Error('Invalid browser settings');
  }
  return c;
}

export async function loadConfig(file) {
  const absolute = localPath(file);
  const config=normalizeConfig(JSON.parse(await readFile(absolute, 'utf8')), path.dirname(absolute));
  if(config.copyFile) config.copies=await loadCopyLibrary(config.copyFile);
  return config;
}

export function businessDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
