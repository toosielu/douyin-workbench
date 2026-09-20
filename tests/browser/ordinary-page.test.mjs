import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { DouyinPage, validateProfile } from '../../src/douyin-page.mjs';
import { fixtureHtml, fixtureProfile } from '../fixtures/upload-page.mjs';

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, channel: 'chromium' }); });
test.after(async () => { await browser?.close(); });
function ordinaryProfile() {
  const ui = fixtureProfile();
  for (const key of ['taskOpen', 'taskDialog', 'taskSearch', 'taskRow', 'taskSelect', 'taskConfirm', 'taskIdentity', 'selectedTask']) delete ui[key];
  return ui;
}
const job = { id: 'j1', mode: 'ordinary', taskId: null, taskName: null, title: '普通账号测试',
  path: { name: 'demo.mp4', mimeType: 'video/mp4', buffer: Buffer.from('local fixture') } };
async function setup(t) {
  const context = await browser.newContext(); t.after(() => context.close());
  await context.route('**/*', route => route.abort());
  const page = await context.newPage(); await page.setContent(fixtureHtml());
  await page.locator('#open, #dialog, #bound').evaluateAll(nodes => nodes.forEach(node => node.remove()));
  const adapter = new DouyinPage(page, ordinaryProfile(), { id: 'a', mode: 'ordinary', expectedIdentity: '抖音号：123456' }, { fixture: true });
  return { page, adapter };
}
test('ordinary profile needs no task selectors; task profile still does', () => {
  assert.doesNotThrow(() => validateProfile(ordinaryProfile(), { fixture: true, mode: 'ordinary' }));
  assert.throws(() => validateProfile(ordinaryProfile(), { fixture: true, mode: 'task' }), /task/);
});
test('ordinary account uploads and publishes with task UI absent', async t => {
  const { page, adapter } = await setup(t);
  await adapter.prepare(job);
  assert.equal(await page.locator('#title').inputValue(), job.title);
  assert.equal(await page.evaluate(() => window.clickCount), 0);
  assert.equal((await adapter.publish(job)).platformId, '90001');
  assert.equal(await page.evaluate(() => window.clickCount), 1);
});
test('mode mismatch or a task on ordinary job stops before upload', async t => {
  const { page, adapter } = await setup(t);
  await assert.rejects(adapter.prepare({ ...job, mode: 'task', taskId: '101' }), /mode|模式/);
  await assert.rejects(adapter.prepare({ ...job, taskId: '101' }), /task|任务/);
  assert.equal(await page.locator('#upload').evaluate(el => el.files.length), 0);
});
test('full copy and hashtags are filled; a changed description blocks publishing',async t=>{
 const {page,adapter}=await setup(t);
 await page.evaluate(()=>{const field=document.createElement('div');field.id='description';field.contentEditable='true';document.body.append(field);});
 adapter.ui.descriptionInput='#description';
 const withCopy={...job,description:'测试完整正文 #牙膏 #口腔护理\n#fzq_A_2'};
 await adapter.prepare(withCopy);
 assert.equal(await page.locator('#description').innerText(),withCopy.description);
 await page.locator('#description').fill('只剩标签 #牙膏');
 await assert.rejects(adapter.publish(withCopy),/文案/);
 assert.equal(await page.evaluate(()=>window.clickCount),0);
});
test('copy requires calibrated description selector before upload',async t=>{
 const {page,adapter}=await setup(t);
 await assert.rejects(adapter.prepare({...job,description:'必须填写的正文'}),/正文|description/);
 assert.equal(await page.locator('#upload').evaluate(el=>el.files.length),0);
});
test('Douyin zero-width line terminators do not change the visible copy',async t=>{
 const {page,adapter}=await setup(t);
 await page.evaluate(()=>{const field=document.createElement('div');field.id='description';field.contentEditable='true';document.body.append(field);});
 adapter.ui.descriptionInput='#description';const withCopy={...job,description:'完整文案\n#牙膏 #生活'};
 await adapter.prepare(withCopy);
 await page.locator('#description').fill('完整文案\u200b\n#牙膏 #生活\u200b');
 await adapter.verifyForm(withCopy);
});
