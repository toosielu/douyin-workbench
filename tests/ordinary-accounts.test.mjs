import test from 'node:test';
import assert from 'node:assert/strict';
import {configureAccounts,eligibleAccount,matchesMaterial} from '../src/ordinary-accounts.mjs';
const row={expectedIdentity:'12345',operatorId:'运营甲',editor:'fzq',koc:'KOC1',enabled:true,materialDir:process.cwd()};
test('create stable account, preserve identity, and disable instead of deleting',()=>{
  const first=configureAccounts([],[row],'运营甲');assert.match(first[0].id,/^account-/);
  const next=configureAccounts(first,[{...first[0],enabled:false}],'运营甲');assert.equal(next[0].id,first[0].id);assert.equal(next[0].enabled,false);
  assert.throws(()=>configureAccounts(first,[{...first[0],expectedIdentity:'999'}],'运营甲'),/不能更换/);
  assert.throws(()=>configureAccounts(first,[{...row,expectedIdentity:'888'}],'运营甲'),/不能移除/);
  assert.throws(()=>configureAccounts([],[row,row],'运营甲'),/重复/);
});
test('match current operator, exact KOC and editor, and enabled state',()=>{
  const config={mappingEnabled:true,operatorId:'运营甲'};
  assert.equal(matchesMaterial(row,'fzq_A_1_KOC1.mp4',config),true);
  assert.equal(matchesMaterial(row,'fzq_A_1_KOC2.mp4',config),false);
  assert.equal(matchesMaterial(row,'other_A_1_KOC1.mp4',config),false);
  assert.equal(eligibleAccount({...row,operatorId:'运营乙'},config),false);
  assert.equal(eligibleAccount({...row,enabled:false},config),false);
});
