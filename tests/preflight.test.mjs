import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../src/preflight.mjs';
const date = '2026-09-16';
const config = { dailyTarget: 3, maxAttemptsPerDay: 6, accounts: [{ id: 'a', expectedIdentity: 'dy123', tasks: [{ id: '1', name: 'task1' }] }] };
const job = () => ({ id: 'j1', accountId: 'a', expectedIdentity: 'dy123', date, taskId: '1', taskName: 'task1',
  hash: 'a'.repeat(64), path: 'C:/clips/1.mp4', title: '标题', status: 'PLANNED' });
test('run rejects modified account or tasks and lowered capacity', () => {
  const j = job(); preflight(config, [j], date);
  assert.throws(() => preflight(config, [{ ...j, expectedIdentity: 'dy999' }], date), /identity/);
  assert.throws(() => preflight(config, [{ ...j, taskId: 'changed' }], date), /task/);
  assert.throws(() => preflight({ ...config, dailyTarget: 1 }, [j, { ...j, id: 'j2', hash: 'b'.repeat(64) }], date), /target/i);
});
test('corrupt records and duplicate account material reservations fail closed', () => {
  const j = job();
  assert.throws(() => preflight(config, [{ ...j, status: 'nonsense' }], date), /record/i);
  assert.throws(() => preflight(config, [j, { ...j, id: 'j2' }], date), /duplicate material/i);
  assert.throws(() => preflight(config, [j, { ...j, id: 'j1' }], date), /duplicate record/i);
});
test('renaming account alias cannot bypass lifetime material history', () => {
  const c = structuredClone(config); c.accounts[0].id = 'renamed';
  assert.throws(() => preflight(c, [{ ...job(), status: 'APPROVED' }], date), /mapping|identity/);
});

test('explicit single ordinary repost preserves original and requires matching authorization', () => {
  const original = {...job(),mode:'ordinary',taskId:null,taskName:null,status:'APPROVED',platformId:'7686179798686731572'};
  const c={...config,accounts:[{...config.accounts[0],mode:'ordinary',tasks:[]}]};
  const repeat={...original,id:'repeat-1',status:'PLANNED',platformId:undefined,
    repeatAuthorization:{sourceJobId:original.id,confirmedAt:'2026-09-17T00:00:00Z',note:'User explicitly requested one repeat publication'}};
  assert.doesNotThrow(()=>preflight(c,[original,repeat],date));
  assert.doesNotThrow(()=>preflight(c,[repeat,original],date));
  for (const patch of [{repeatAuthorization:undefined},{repeatAuthorization:{...repeat.repeatAuthorization,note:''}},
    {repeatAuthorization:{...repeat.repeatAuthorization,sourceJobId:'missing'}}, {path:'C:/other.mp4'}]) {
    assert.throws(()=>preflight(c,[original,{...repeat,...patch}],date));
  }
  assert.throws(()=>preflight(c,[{...original,status:'UNKNOWN'},repeat],date));
  assert.throws(()=>preflight(c,[original,repeat,{...repeat,id:'repeat-2'}],date));
});

test('a subsequent explicit repeat binds its new path and title to the last approved post', () => {
  const original={...job(),mode:'ordinary',taskId:null,taskName:null,status:'APPROVED',platformId:'123'};
  const prior={...original,id:'prior',repeatAuthorization:{sourceJobId:original.id,confirmedAt:'2026-09-17',note:'explicit first repeat'}};
  const next={...original,id:'next',status:'PLANNED',path:'C:/clips/KOC1.mp4',title:'KOC1',
    repeatAuthorization:{sourceJobId:prior.id,confirmedAt:'2026-09-17',note:'explicit second repeat',materialPath:'C:/clips/KOC1.mp4',title:'KOC1'}};
  const c={...config,accounts:[{...config.accounts[0],mode:'ordinary',tasks:[]}]};
  assert.doesNotThrow(()=>preflight(c,[original,prior,next],date));
  assert.throws(()=>preflight(c,[original,prior,{...next,title:'changed'}],date));
  assert.throws(()=>preflight(c,[original,prior,{...next,path:'C:/other.mp4'}],date));
  assert.throws(()=>preflight(c,[original,{...prior,status:'PENDING_REVIEW'},next],date));
  const cycle={...next,status:'APPROVED'};
  const loopingPrior={...prior,repeatAuthorization:{...prior.repeatAuthorization,sourceJobId:next.id,materialPath:prior.path,title:prior.title}};
  assert.throws(()=>preflight(c,[original,loopingPrior,cycle],date));
});
