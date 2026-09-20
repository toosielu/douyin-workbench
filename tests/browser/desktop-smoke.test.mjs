import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {_electron} from 'playwright';
import electronPath from 'electron';

test('desktop has isolated empty onboarding, survives refresh, and rejects a second instance',async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'douyin-desktop-smoke-'));
  const env={...process.env,DOUYIN_DESKTOP_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.DESKTOP_EXECUTABLE||electronPath;
  const args=process.env.DESKTOP_EXECUTABLE?[]:['.'];
  const app=await _electron.launch({executablePath,args,env});
  try{
    const page=await app.firstWindow();
    await page.waitForFunction(()=>document.querySelector('#copy-count')?.textContent.includes('0 条'));
    assert.equal(await page.locator('.account-row').count(),0);
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#copy-count')?.textContent.includes('0 条'));
    assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
    const second=spawn(executablePath,args,{env,windowsHide:true,stdio:'ignore'});
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{second.kill();reject(Error('Second instance did not exit'));},15000);second.on('error',reject);second.on('exit',c=>{clearTimeout(timer);resolve(c);});});
    assert.equal(code,0);assert.equal(app.windows().length,1);
    await page.screenshot({path:'demo-output/desktop-first-run.png'});
  }finally{await app.close();await rm(home,{recursive:true,force:true});}
});
