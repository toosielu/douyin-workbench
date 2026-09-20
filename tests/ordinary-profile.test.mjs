import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProfile } from '../src/douyin-page.mjs';
import { fixtureProfile } from './fixtures/upload-page.mjs';
test('ordinary schema validates without task selectors but legacy task schema stays strict', () => {
  const ui = fixtureProfile();
  for (const key of ['taskOpen', 'taskDialog', 'taskSearch', 'taskRow', 'taskSelect', 'taskConfirm', 'taskIdentity', 'selectedTask']) delete ui[key];
  assert.doesNotThrow(() => validateProfile(ui, { fixture: true, mode: 'ordinary' }));
  assert.throws(() => validateProfile(ui, { fixture: true }), /task/);
  assert.throws(() => validateProfile(ui, { fixture: true, mode: 'unknown' }), /mode/);
});

test('network receipt uses observed endpoint and requires publication settings', () => {
  const ui = fixtureProfile();
  ui.receipt = {kind:'network',url:'https://creator.douyin.com/web/api/media/aweme/create_v2/'};
  ui.identity.url = 'https://creator.douyin.com/creator-micro/home';
  ui.publication = {visibilityLabel:'公开',scheduleLabel:'立即发布',crossPostLabel:'不同时发布'};
  delete ui.success;
  assert.doesNotThrow(() => validateProfile(ui,{fixture:true,mode:'ordinary'}));
  assert.throws(() => validateProfile({...ui,publication:undefined},{fixture:true,mode:'ordinary'}),/publication/);
  assert.throws(() => validateProfile({...ui,identity:{...ui.identity,url:'https://other.example/'}},{fixture:true,mode:'ordinary'}),/identity/);
  assert.throws(() => validateProfile({...ui,receipt:{kind:'network',url:'https://other.example/create'}},{fixture:true,mode:'ordinary'}),/receipt/);
});
