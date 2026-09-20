import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeConfig, businessDate } from '../src/config.mjs';

const sample = () => ({ dataDir: './data', uiFile: './ui.json', dailyTarget: 9,
  maxAttemptsPerDay: 18, minFileAgeSeconds: 60, intervalSeconds: 30,
  accounts: [{ id: 'a', expectedIdentity: '抖音号：demo-a', materialDir: './clips',
    titleTemplate: '{filename}', tasks: [{ id: '11', name: '牙膏任务1' },
      { id: '12', name: '牙膏任务2' }, { id: '13', name: '牙膏任务3' }] }] });

test('paths resolve relative to config, never working directory', () => {
  const c = normalizeConfig(sample(), path.resolve('config'));
  assert.equal(c.accounts[0].materialDir, path.resolve('config/clips'));
  assert.equal(c.browser.headless, false);
});
test('reject duplicate identities and unsafe account path names', () => {
  const c = sample(); c.accounts.push({ ...c.accounts[0], id: 'b' });
  assert.throws(() => normalizeConfig(c), /identity/i);
  c.accounts.pop(); c.accounts[0].id = '../a';
  assert.throws(() => normalizeConfig(c), /account/i);
});
test('explicit quota and budget required; forbid shared network material paths in demo', () => {
  const c = sample(); delete c.dailyTarget;
  assert.throws(() => normalizeConfig(c), /dailyTarget/);
  c.dailyTarget = 9; c.accounts[0].materialDir = '\\\\server\\videos';
  assert.throws(() => normalizeConfig(c), /local|本地/i);
});
test('use Shanghai calendar date rather than UTC day', () => {
  assert.equal(businessDate(new Date('2026-09-16T17:00:00Z')), '2026-09-17');
});
test('Windows account file names cannot collide by case or use device names', () => {
  const c = sample(); c.accounts.push({ ...c.accounts[0], id: 'A', expectedIdentity: 'another' });
  assert.throws(() => normalizeConfig(c), /account/);
  c.accounts.pop(); c.accounts[0].id = 'CON';
  assert.throws(() => normalizeConfig(c), /account/);
});
test('identity whitespace normalization cannot disguise duplicate accounts', () => {
  const c = sample(); c.accounts[0].expectedIdentity = 'id  123';
  c.accounts.push({ ...c.accounts[0], id: 'b', expectedIdentity: 'id 123' });
  assert.throws(() => normalizeConfig(c), /identity/);
});
