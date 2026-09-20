import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccountIdentity } from '../src/identity.mjs';

function harness({text='抖音号：123',count=1,fail=false}={}) {
  const calls=[];
  const loc={waitFor:async()=>{if(fail)throw new Error('login expired');},count:async()=>count,innerText:async()=>text};
  const temporary={goto:async url=>calls.push(['goto',url]),url:()=> 'https://creator.douyin.com/creator-micro/home',locator:()=>loc,close:async()=>calls.push(['close'])};
  const editor={context:()=>({newPage:async()=>{calls.push(['newPage']);return temporary;}}),locator:()=>loc,goto:()=>{throw new Error('Editor must never navigate');}};
  return {editor,calls};
}
const spec={url:'https://creator.douyin.com/creator-micro/home',selector:'.identity:visible',pattern:'^抖音号：([A-Za-z0-9]+)$'};
test('identity reads a fresh separate page and preserves editor',async()=>{
  const {editor,calls}=harness();
  assert.equal(await verifyAccountIdentity(editor,spec,'123'), '123');
  assert.deepEqual(calls.map(c=>c[0]),['newPage','goto','close']);
});
test('identity mismatch, duplicate nodes and expired login close temporary page',async()=>{
  for(const options of [{text:'抖音号：456'},{count:2},{fail:true}]) {
    const {editor,calls}=harness(options);
    await assert.rejects(verifyAccountIdentity(editor,spec,'123'));
    assert.equal(calls.at(-1)[0],'close');
  }
});
test('cross-site identity URL is rejected before any navigation',async()=>{
  const {editor,calls}=harness();
  await assert.rejects(verifyAccountIdentity(editor,{...spec,url:'https://evil.example/home'},'123'));
  assert.equal(calls.length,0);
});
test('legacy identity stays on the current page',async()=>{
  const {editor,calls}=harness({text:'抖音号：123'});
  assert.equal(await verifyAccountIdentity(editor,{selector:'#identity'},'抖音号：123'),'抖音号：123');
  assert.equal(calls.length,0);
});
