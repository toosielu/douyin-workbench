import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { DouyinPage, validateProfile } from './douyin-page.mjs';
import { verifyMaterial } from './materials.mjs';
import { atomicJson } from './store.mjs';
import { verifyAccountIdentity } from './identity.mjs';

const authPath = (config, account) => path.join(config.dataDir, 'auth', `${account.id}.json`);

export async function loadProfile(config, { live = true, mode = 'task' } = {}) {
  const ui = JSON.parse(await readFile(config.uiFile, 'utf8'));
  const url = new URL(ui.uploadUrl);
  if (url.origin !== 'https://creator.douyin.com' || url.username || url.password) throw new Error('Invalid Douyin URL');
  if (live) validateProfile(ui, { mode });
  return ui;
}

async function loadAuth(config, account, optional = false, allowUnverified = false) {
  try {
    const data = JSON.parse(await readFile(authPath(config, account), 'utf8'));
    if (data.accountId !== account.id || data.expectedIdentity !== account.expectedIdentity || !data.storageState) {
      throw new Error(`登录态归属不匹配：${account.id}`);
    }
    if (data.identityVerified !== true && !allowUnverified) throw new Error(`账号 ${account.id} 尚未核对身份；完成页面校准并执行 verify 或 login 后再上传`);
    return data.storageState;
  } catch (e) {
    if (e.code === 'ENOENT' && optional) return undefined;
    if (e.code === 'ENOENT') throw new Error(`请先执行 login --account ${account.id}`);
    throw e;
  }
}

export async function assertAuthFiles(config, accounts) {
  for (const account of accounts) await loadAuth(config, account);
}

function launchOptions(config, forceVisible = false) {
  return { headless: forceVisible ? false : config.browser.headless, channel: config.browser.channel ?? 'chromium' };
}

export async function interactiveBrowser(config, account, mode, log = console.log, services = {}) {
  const ask = services.ask ?? (async message => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { return await prompt.question(message); } finally { prompt.close(); }
  });
  const ui = await loadProfile(config, { live: false });
  const browser = await (services.launch ?? (options => chromium.launch(options)))(mode === 'verify' ? {...launchOptions(config),headless:true} : launchOptions(config, true));
  try {
    const context = await browser.newContext({ storageState: await loadAuth(config, account, mode !== 'verify', true), locale: 'zh-CN', serviceWorkers:'block' });
    if (mode === 'verify') await context.route('**/*', route => ['GET','HEAD','OPTIONS'].includes(route.request().method()) ? route.continue() : route.abort());
    const page = await context.newPage();
    if (mode === 'verify') {
      if (!ui.identity?.url) await page.goto(ui.uploadUrl, {waitUntil:'domcontentloaded'});
      await verifyAccountIdentity(page, ui.identity, account.expectedIdentity);
      await atomicJson(authPath(config, account), {accountId:account.id,expectedIdentity:account.expectedIdentity,
        identityVerified:true,savedAt:new Date().toISOString(),storageState:await context.storageState({indexedDB:true})});
      log(`已核对 ${account.id}（${account.expectedIdentity}），未上传或发布。`);
      return {accountId:account.id,status:'IDENTITY_VERIFIED'};
    }
    await page.goto(ui.uploadUrl, { waitUntil: 'domcontentloaded' });
    if (mode === 'connect') {
      log(`请在浏览器手动登录 ${account.id}。此步骤不选择视频、不保存草稿、不点击发布。`);
      await ask('登录后进入创作者首页或视频投稿入口，保持未选择素材，回到这里按 Enter：');
      if (new URL(page.url()).origin !== 'https://creator.douyin.com') throw new Error('请先进入抖音创作者中心');
      const directory = path.join(config.dataDir, 'calibration');
      await mkdir(directory, { recursive: true });
      const snapshot = await page.evaluate(() => {
        const visible = el => el.getClientRects().length > 0;
        return {
          controls: [...document.querySelectorAll('input, textarea, button, [role=button], [contenteditable=true]')]
            .filter(el => visible(el) && el.getAttribute('type') !== 'password').slice(0, 100).map(el => ({
              tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), id: el.id,
              placeholder: el.getAttribute('placeholder'), ariaLabel: el.getAttribute('aria-label'),
              text: el.matches('input, textarea, [contenteditable=true]') ? '' : (el.innerText ?? '').trim().slice(0, 80)
            })),
          identityLabels: [...document.querySelectorAll('span, p, div')].filter(visible)
            .map(el => (el.textContent ?? '').trim()).filter(text => /^(抖音号|UID)\s*[:：]/i.test(text) && text.length <= 100).slice(0, 10)
        };
      });
      await atomicJson(path.join(directory, `${account.id}.json`), { url: page.url(), ...snapshot });
      await page.screenshot({ path: path.join(directory, `${account.id}.png`), fullPage: true });
      await atomicJson(authPath(config, account), { accountId: account.id, expectedIdentity: account.expectedIdentity,
        identityVerified: false, savedAt: new Date().toISOString(), storageState: await context.storageState({ indexedDB: true }) });
      log(`已保存本机页面检查资料：${directory}。会话尚未核对，当前不能用于上传。`);
      return { accountId: account.id, status: 'CONNECTED_UNVERIFIED' };
    }
    if (mode === 'inspect') {
      log('使用 Playwright Inspector 的 Pick locator 查看控件。检查完点击 Resume；本命令不选择素材或点击发布。');
      await page.pause();
      return { accountId: account.id, status: 'INSPECTED' };
    }
    log(`请手动登录 ${account.id}。脚本会从配置的页面核对账号标识，不会处理验证码。`);
    await ask('确认页面账号正确后，按 Enter 校验并保存本机登录态：');
    await verifyAccountIdentity(page, ui.identity, account.expectedIdentity);
    // Official auth pattern: https://playwright.dev/docs/auth . Never log cookies.
    await atomicJson(authPath(config, account), { accountId: account.id, expectedIdentity: account.expectedIdentity, identityVerified: true,
      savedAt: new Date().toISOString(), storageState: await context.storageState({ indexedDB: true }) });
    log(`已保存 ${account.id} 的独立登录态。`);
    return { accountId: account.id, status: 'LOGGED_IN' };
  } finally { await browser.close(); }
}

export async function openAccount(config, ui, account) {
  validateProfile(ui, { mode: account.mode ?? 'task' });
  const storageState = await loadAuth(config, account);
  const browser = await chromium.launch(launchOptions(config));
  try {
    const context = await browser.newContext({ storageState, locale: 'zh-CN', serviceWorkers:'block', viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const adapter = new DouyinPage(page, ui, account);
    async function screenshot(job, suffix) {
      const directory = path.join(config.dataDir, 'screenshots');
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, `${job.id}-${suffix}.png`), fullPage: true }).catch(() => {});
    }
    return {
      async prepare(job) {
        try {
          await page.goto(ui.uploadUrl, { waitUntil: 'domcontentloaded', timeout: ui.uploadTimeoutMs });
          await adapter.verifyIdentity();
          await verifyMaterial(job, account.materialDir, { minFileAgeSeconds: config.minFileAgeSeconds });
          await adapter.prepare(job);
          await screenshot(job, 'ready');
        } catch (e) { await screenshot(job, 'prepare-error'); throw e; }
      },
      async publish(job) {
        try { const result = await adapter.publish(job); await screenshot(job, 'receipt'); return result; }
        catch (e) { await screenshot(job, 'unknown'); throw e; }
      },
      close: () => browser.close()
    };
  } catch (e) { await browser.close(); throw e; }
}
