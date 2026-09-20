import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { DouyinPage, validateProfile } from '../../src/douyin-page.mjs';
import { fixtureHtml, fixtureProfile } from '../fixtures/upload-page.mjs';
import { readFile } from 'node:fs/promises';

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, channel: 'chromium' }); });
test.after(async () => { await browser?.close(); });
async function setup(t, options = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(); await page.setContent(fixtureHtml(options));
  const profile = fixtureProfile();
  const adapter = new DouyinPage(page, profile, { id: 'a', expectedIdentity: '抖音号：123456' }, { fixture: true });
  return { page, adapter };
}
const job = { id: 'j1', taskId: '101', title: '演示视频', path: { name: 'demo.mp4', mimeType: 'video/mp4', buffer: Buffer.from('synthetic fixture, not a video') } };

test('fixture profile is forbidden in real mode', () => {
  assert.throws(() => validateProfile(fixtureProfile()), /live_verified/);
});
test('sample publish selector syntax targets the exact label on fixture', async t => {
  const { page } = await setup(t);
  const sample = JSON.parse(await readFile(new URL('../../config/douyin-ui.example.json', import.meta.url), 'utf8'));
  assert.equal(await page.locator(sample.publishButton).count(), 1);
});
test('real adapter fills upload, selects exact task ID and clicks once for new receipt', async t => {
  const { page, adapter } = await setup(t);
  await adapter.prepare(job);
  assert.equal(await page.locator('#bound').innerText(), '101');
  assert.equal(await page.locator('#title').inputValue(), job.title);
  assert.deepEqual(await adapter.publish(job), { status: 'PENDING_REVIEW', platformId: '90001' });
  assert.equal(await page.evaluate(() => window.clickCount), 1);
});
test('wrong identity stops before selecting any file', async t => {
  const { page, adapter } = await setup(t, { identity: '抖音号：different' });
  await assert.rejects(adapter.prepare(job), /identity|账号/i);
  assert.equal(await page.locator('#upload').evaluate(e => e.files.length), 0);
});
test('wrong bound task blocks publish despite correct search result', async t => {
  const { page, adapter } = await setup(t, { bound: '999' });
  await assert.rejects(adapter.prepare(job), /task|任务/i);
  assert.equal(await page.evaluate(() => window.clickCount), 0);
});
test('upload incomplete cannot proceed to task selection or publication', async t => {
  const { page, adapter } = await setup(t, { uploadStuck: true });
  await assert.rejects(adapter.prepare(job));
  assert.equal(await page.evaluate(() => window.clickCount), 0);
  assert.equal(await page.locator('#dialog').isVisible(), false);
});
test('toast without a unique receipt is not success and is not clicked again', async t => {
  const { page, adapter } = await setup(t, { noReceipt: true });
  await adapter.prepare(job); await assert.rejects(adapter.publish(job));
  assert.equal(await page.evaluate(() => window.clickCount), 1);
});
test('old receipt cannot be reused to prove this submission', async t => {
  const { page, adapter } = await setup(t, { staleReceipt: true });
  await adapter.prepare(job); await assert.rejects(adapter.publish(job), /receipt|回执/i);
  assert.equal(await page.evaluate(() => window.clickCount), 1);
});
test('hidden old receipt becoming visible cannot prove a new submission', async t => {
  const { page, adapter } = await setup(t, { hiddenStaleReceipt: true });
  await adapter.prepare(job); await assert.rejects(adapter.publish(job), /receipt|回执/i);
  assert.equal(await page.evaluate(() => window.clickCount), 1);
});
