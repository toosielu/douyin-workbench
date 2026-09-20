import {createHash} from 'node:crypto';

export function batchDigest(config, jobs, date, ui, accountId = null) {
  return createHash('sha256').update(JSON.stringify({config,ui,date,accountId,
    jobs:[...jobs].sort((a,b)=>a.id.localeCompare(b.id))
  }), 'utf8').digest('hex');
}
