import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { interactiveBrowser, assertAuthFiles } from '../src/browser.mjs';

test('connect saves unverified state without selecting a file and real run refuses it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-connect-'));
  let closed = false; const visits = []; let promptCount = 0;
  try {
    const config = { dataDir: dir, browser: { headless: false }, uiFile: path.join(dir, 'ui.json') };
    await writeFile(config.uiFile, JSON.stringify({ uploadUrl: 'https://creator.douyin.com/creator-micro/content/post/video' }), 'utf8');
    const account = { id: 'ordinary-test', expectedIdentity: 'dy-test', mode: 'ordinary' };
    const page = { goto: async url => visits.push(url), url: () => visits.at(-1),
      screenshot: async () => {}, evaluate: async () => ({ controls: [], identityLabels: [] }) };
    const context = { newPage: async () => page, storageState: async () => ({ cookies: [], origins: [] }) };
    const launch = async () => ({ newContext: async () => context, close: async () => { closed = true; } });
    const result = await interactiveBrowser(config, account, 'connect', () => {}, {
      launch, ask: async () => { promptCount++; }
    });
    assert.equal(result.status, 'CONNECTED_UNVERIFIED'); assert.equal(promptCount, 1); assert.equal(closed, true);
    const saved = JSON.parse(await readFile(path.join(dir, 'auth/ordinary-test.json'), 'utf8'));
    assert.equal(saved.identityVerified, false);
    await assert.rejects(assertAuthFiles(config, [account]), /核对|verified/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verify checks existing session read-only and saves verified identity without prompting', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'douyin-verify-'));
  const account={id:'a',expectedIdentity:'123',mode:'ordinary'};
  const config={dataDir:dir,browser:{headless:true},uiFile:path.join(dir,'ui.json')};
  const visits=[];let prompted=false;let routeHandler;
  try {
    const {mkdir}=await import('node:fs/promises'); await mkdir(path.join(dir,'auth'));
    await writeFile(path.join(dir,'auth/a.json'),JSON.stringify({accountId:'a',expectedIdentity:'123',identityVerified:false,storageState:{cookies:[],origins:[]}}));
    await writeFile(config.uiFile,JSON.stringify({uploadUrl:'https://creator.douyin.com/creator-micro/content/post/video',identity:{url:'https://creator.douyin.com/creator-micro/home',selector:'#id',pattern:'^抖音号：(.+)$'}}));
    const loc={waitFor:async()=>{},count:async()=>1,innerText:async()=> '抖音号：123'};
    let context;
    const page={context:()=>context,goto:async url=>visits.push(url),url:()=>visits.at(-1),locator:()=>loc,close:async()=>{}};
    context={newPage:async()=>page,route:async(pattern,handler)=>{routeHandler=handler;},storageState:async()=>({cookies:[],origins:[]})};
    const result=await interactiveBrowser(config,account,'verify',()=>{},{launch:async()=>({newContext:async()=>context,close:async()=>{}}),ask:async()=>{prompted=true;}});
    assert.equal(result.status,'IDENTITY_VERIFIED');assert.equal(prompted,false);
    assert.deepEqual(visits,['https://creator.douyin.com/creator-micro/home']);
    let aborted=false;await routeHandler({request:()=>({method:()=> 'POST'}),abort:()=>{aborted=true;},continue:()=>{throw new Error('Unexpected write');}});
    assert.equal(aborted,true);
    assert.equal(JSON.parse(await readFile(path.join(dir,'auth/a.json'),'utf8')).identityVerified,true);
  } finally {await rm(dir,{recursive:true,force:true});}
});
