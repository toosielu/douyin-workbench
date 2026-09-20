import path from 'node:path';

const known = new Set(['PLANNED', 'RUNNING', 'SUBMITTING', 'UNKNOWN', 'PENDING_REVIEW', 'APPROVED',
  'REJECTED', 'FAILED_BEFORE_SUBMIT', 'CANCELLED']);
const occupied = new Set(['PLANNED', 'RUNNING', 'SUBMITTING', 'UNKNOWN', 'PENDING_REVIEW', 'APPROVED']);

export function preflight(config, jobs, date) {
  if (!Array.isArray(jobs)) throw new Error('Invalid ledger records');
  const ids = new Set(); const materials = new Set(); const repeatSources = new Set();
  for (const j of jobs) {
    const mode = j?.mode === undefined ? 'task' : j.mode;
    const validTaskFields = mode === 'ordinary'
      ? j.taskId === null && j.taskName === null
      : typeof j?.taskId === 'string' && typeof j?.taskName === 'string';
    if (!j || typeof j.id !== 'string' || !j.id || typeof j.accountId !== 'string' || !j.accountId ||
      typeof j.expectedIdentity !== 'string' || !j.expectedIdentity || !['ordinary', 'task'].includes(mode) ||
      !validTaskFields || typeof j.path !== 'string' || !j.path ||
      typeof j.title !== 'string' || (!j.title.trim() && !(typeof j.description==='string' && j.description.trim())) || Array.from(j.title).length > 30 ||
      !/^[a-f0-9]{64}$/.test(j.hash ?? '') || !known.has(j.status) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(j.date ?? '') || Number.isNaN(Date.parse(j.date)) ||
      new Date(j.date).toISOString().slice(0, 10) !== j.date) throw new Error('Invalid ledger record，请核对历史文件');
    if (ids.has(j.id)) throw new Error('Duplicate record ID'); ids.add(j.id);
    let key = `${j.accountId}\0${j.hash}`;
    if (j.repeatAuthorization !== undefined) {
      const authorization = j.repeatAuthorization;
      const source = jobs.find(other => other.id === authorization?.sourceJobId);
      const explicitlyBound = authorization?.materialPath === j.path && authorization?.title === j.title;
      if (mode !== 'ordinary' || !source || source === j ||
        (source.repeatAuthorization !== undefined && !explicitlyBound) ||
        source.status !== 'APPROVED' || !source.platformId || source.accountId !== j.accountId ||
        source.expectedIdentity !== j.expectedIdentity || source.hash !== j.hash ||
        (source.path !== j.path && !explicitlyBound) ||
        (authorization.materialPath !== undefined && !explicitlyBound) ||
        typeof authorization.note !== 'string' || authorization.note.trim().length < 4 ||
        typeof authorization.confirmedAt !== 'string' || !Number.isFinite(Date.parse(authorization.confirmedAt)) ||
        repeatSources.has(source.id)) throw new Error('Invalid single-repeat authorization');
      repeatSources.add(source.id);
      const ancestors = new Set([j.id]);
      let ancestor = source;
      while (ancestor) {
        if (ancestors.has(ancestor.id)) throw new Error('Cyclic repeat authorization');
        ancestors.add(ancestor.id);
        ancestor = jobs.find(other => other.id === ancestor.repeatAuthorization?.sourceJobId);
      }
      key += `\0authorized-repeat:${j.id}`;
    }
    if (!['CANCELLED', 'FAILED_BEFORE_SUBMIT'].includes(j.status)) {
      if (materials.has(key)) throw new Error('Duplicate material reservation'); materials.add(key);
    }
    const account = config.accounts.find(a => a.id === j.accountId);
    const sameIdentity = config.accounts.find(a => a.expectedIdentity.replace(/\s+/g, ' ').trim() === j.expectedIdentity.replace(/\s+/g, ' ').trim());
    if (sameIdentity && sameIdentity.id !== j.accountId) throw new Error('Account identity mapping changed: preserve stable account IDs');
    if (account && account.expectedIdentity !== j.expectedIdentity) throw new Error('Account identity changed: use the original mapping');
    if (j.status === 'PLANNED') {
      if(config.copyFile && (typeof j.description!=='string'||!j.description.trim()||!j.copyId))throw Error('已启用Excel文案库，但旧计划缺少正文，请取消旧计划后重新规划');
      if (!account) throw new Error('Planned account removed from config');
      const configuredMode = account.mode === undefined ? 'task' : account.mode;
      if (configuredMode !== mode) throw new Error('Planned account mode changed: cancel and replan');
      if (account.materialFile !== undefined && path.relative(path.resolve(account.materialFile), path.resolve(j.path)) !== '') {
        throw new Error('Planned material file changed: cancel and replan');
      }
      if (mode === 'task' && !account.tasks.some(t => t.id === j.taskId && t.name === j.taskName)) {
        throw new Error('Planned task changed: cancel and replan');
      }
    }
  }
  for (const account of config.accounts) {
    const current = jobs.filter(j => j.accountId === account.id && j.date === date);
    if (current.filter(j => occupied.has(j.status)).length > config.dailyTarget) throw new Error('Planned occupancy exceeds dailyTarget');
    if (current.filter(j => j.status !== 'CANCELLED').length > config.maxAttemptsPerDay) throw new Error('Planned attempts exceed maxAttemptsPerDay');
  }
}
