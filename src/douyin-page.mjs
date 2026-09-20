// Playwright APIs: https://playwright.dev/docs/input and https://playwright.dev/docs/locators
import { verifyAccountIdentity, validateIdentitySpec } from './identity.mjs';
import { submitWithReceipt, validateReceiptUrl, observeTrustedPublishClick } from './submission-receipt.mjs';
const normalize = value => String(value).replace(/\s+/g, ' ').trim();
// The observed editor appends U+200B to each line as an invisible enter marker.
const normalizeDescription = value => normalize(String(value).replace(/\u200b(?=\r?\n|$)/g,''));
const commonFields = ['uploadInput', 'uploadComplete', 'titleInput', 'publishButton'];
const taskFields = ['taskOpen', 'taskDialog', 'taskSearch', 'taskRow', 'taskSelect', 'taskConfirm'];

export function validateProfile(ui, { fixture = false, mode = 'task' } = {}) {
  if (!['ordinary', 'task'].includes(mode)) throw new Error('Invalid publication mode');
  if (!ui || ui.evidence !== (fixture ? 'fixture' : 'live_verified')) {
    throw new Error('PROFILE_INCOMPLETE: 真实页面校准后才可设为 live_verified；模拟配置不能用于抖音。');
  }
  const url = new URL(ui.uploadUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'creator.douyin.com' || url.username || url.password) {
    throw new Error('Only https://creator.douyin.com upload URLs are supported');
  }
  const network = ui.receipt?.kind === 'network';
  if (ui.receipt?.kind && !['network','dom'].includes(ui.receipt.kind)) throw new Error('Invalid receipt kind');
  validateIdentitySpec(ui.identity);
  if (network) {
    validateReceiptUrl(ui.receipt.url);
    for (const key of ['visibilityLabel','scheduleLabel','crossPostLabel']) if (typeof ui.publication?.[key] !== 'string' || !ui.publication[key].trim()) throw new Error(`PROFILE_INCOMPLETE: publication.${key}`);
  }
  for (const key of [...commonFields, ...(!network ? ['success'] : []), ...(mode === 'task' ? taskFields : [])]) if (typeof ui[key] !== 'string' || !ui[key].trim() || ui[key].includes('REPLACE_')) {
    throw new Error(`PROFILE_INCOMPLETE: ${key}`);
  }
  for (const key of ['identity', ...(!network ? ['receipt'] : []), ...(mode === 'task' ? ['taskIdentity', 'selectedTask'] : [])]) {
    const field = ui[key];
    if (!field || typeof field.selector !== 'string' || !field.selector.trim() ||
      /REPLACE_|^(body|html|\*)$/i.test(field.selector)) throw new Error(`PROFILE_INCOMPLETE: ${key}`);
    if (field.pattern) new RegExp(field.pattern, 'u');
  }
  for (const key of ['timeoutMs', 'uploadTimeoutMs']) {
    if (!Number.isInteger(ui[key]) || ui[key] < 100 || ui[key] > 1200000) throw new Error(`Invalid ${key}`);
  }
  return ui;
}

export class DouyinPage {
  constructor(page, ui, account, options = {}) {
    this.page = page; this.account = account; this.mode = account.mode ?? 'task';
    this.ui = validateProfile(ui, { ...options, mode: this.mode });
    page.setDefaultTimeout(ui.timeoutMs);
  }

  async unique(scope, selector, { state = 'visible', timeout = this.ui.timeoutMs } = {}) {
    const loc = scope.locator(selector);
    await loc.waitFor({ state, timeout });
    if (await loc.count() !== 1) throw new Error(`Locator must identify exactly one element: ${selector}`);
    return loc;
  }

  async read(scope, spec) {
    const loc = await this.unique(scope, spec.selector);
    const raw = spec.attribute ? await loc.getAttribute(spec.attribute) : await loc.innerText();
    const value = normalize(raw ?? '');
    if (!spec.pattern) return value;
    const match = value.match(new RegExp(spec.pattern, 'u'));
    if (!match?.[1]) throw new Error(`Missing identity/receipt capture: ${spec.selector}`);
    return normalize(match[1]);
  }

  async verifyIdentity() {
    await verifyAccountIdentity(this.page, this.ui.identity, this.account.expectedIdentity, {timeoutMs:this.ui.timeoutMs});
  }

  async verifyForm(job) {
    this.verifyMode(job);
    await this.verifyIdentity();
    await this.unique(this.page, this.ui.uploadComplete);
    if (this.mode === 'task' && await this.read(this.page, this.ui.selectedTask) !== job.taskId) throw new Error('绑定任务 task ID 不匹配');
    const title = await this.unique(this.page, this.ui.titleInput);
    const value = await title.evaluate(el => 'value' in el ? el.value : el.innerText);
    if (normalize(value) !== normalize(job.title)) throw new Error('标题回读不一致');
    if(job.description !== undefined){
      this.verifyDescription(job);
      const field=await this.unique(this.page,this.ui.descriptionInput);
      const unsaved=await field.locator('[data-enter="true"]').allTextContents();
      if(unsaved.some(text=>text.replace(/\u200b/g,'').trim()))throw Error('正文位于编辑器换行占位符中，可能不会保存，停止发布');
      const text=await field.evaluate(el=>'value' in el ? el.value : el.innerText);
      if(normalizeDescription(text)!==normalizeDescription(job.description))throw Error('文案与标签回读不一致，停止发布');
    }
    if (this.ui.publication) {
      for (const [setting, label] of Object.entries(this.ui.publication)) {
        const option = this.page.getByLabel(label, {exact:true});
        if (setting === 'crossPostLabel' && await option.count() === 0 &&
          this.ui.crossPostUnavailableAccounts?.includes(this.account.expectedIdentity) &&
          await this.page.getByText(/同时发布|同步发布/).count() === 0) continue;
        if (await option.count() !== 1 || !await option.isChecked()) throw new Error(`发布设置不匹配：${label}`);
      }
    }
    const button = await this.unique(this.page, this.ui.publishButton);
    if (!await button.isEnabled()) throw new Error('发布按钮不可用');
  }

  async prepare(job) {
    this.verifyMode(job);
    this.verifyDescription(job);
    await this.verifyIdentity();
    // A fresh editor must not already claim upload completion for an old draft.
    if (await this.page.locator(this.ui.uploadComplete).isVisible()) throw new Error('编辑页已有上传完成状态，请使用全新投稿入口');
    const input = await this.unique(this.page, this.ui.uploadInput, { state: 'attached' });
    await input.setInputFiles(job.path);
    await this.unique(this.page, this.ui.uploadComplete, { timeout: this.ui.uploadTimeoutMs });
    await (await this.unique(this.page, this.ui.titleInput)).fill(job.title);
    if(job.description !== undefined) await this.fillDescription(job.description);
    if (this.mode === 'ordinary') { await this.verifyForm(job); return; }
    await (await this.unique(this.page, this.ui.taskOpen)).click();
    const dialog = await this.unique(this.page, this.ui.taskDialog);
    await (await this.unique(dialog, this.ui.taskSearch)).fill(job.taskId);
    if (!/^[A-Za-z0-9_-]+$/.test(job.taskId)) throw new Error('Unsupported task ID');
    const row = await this.unique(dialog, this.ui.taskRow.replaceAll('{taskId}', job.taskId));
    if (await this.read(row, this.ui.taskIdentity) !== job.taskId) throw new Error('候选任务 task ID 不匹配');
    const control = await this.unique(row, this.ui.taskSelect);
    await control.click();
    const checked = await control.evaluate(el => el.matches(':checked') || el.getAttribute('aria-checked') === 'true');
    if (!checked) throw new Error('任务单选状态未确认');
    await (await this.unique(dialog, this.ui.taskConfirm)).click();
    await dialog.waitFor({ state: 'hidden' });
    await this.verifyForm(job);
  }

  verifyMode(job) {
    if ((job.mode ?? 'task') !== this.mode) throw new Error('计划与账号 mode 模式不一致');
    if (this.mode === 'ordinary' && (job.taskId !== null || job.taskName !== null)) throw new Error('普通模式不能关联 task 任务');
  }

  verifyDescription(job){
    if(job.description === undefined)return;
    if(typeof job.description!=='string'||!job.description.trim())throw Error('正文文案不能为空');
    if(typeof this.ui.descriptionInput!=='string'||!this.ui.descriptionInput.trim()||/REPLACE_|^(body|html|\*)$/i.test(this.ui.descriptionInput))throw Error('正文 descriptionInput 尚未校准');
  }

  async fillDescription(description){
    const field=await this.unique(this.page,this.ui.descriptionInput);
    if(await field.evaluate(el=>el.isContentEditable && el.classList.contains('editor-kit-container'))){
      await field.click();await field.press('Control+A');await field.press('Backspace');
      const lines=description.replace(/\r\n/g,'\n').split('\n');
      // Create line breaks before entering hashtags: Enter otherwise selects
      // a suggested topic instead of inserting a newline in the live editor.
      // Seed real text leaves. In the live editor, typing into an empty
      // data-enter leaf can look correct but be omitted from saved content.
      for(let i=0;i<lines.length;i++){
        if(i)await field.press('Enter');
        await this.page.keyboard.insertText('x');
      }
      for(let i=lines.length-1;i>=0;i--){
        await field.press('Control+Home');
        for(let row=0;row<i;row++)await field.press('ArrowDown');
        await field.press('Home');await field.press('Shift+End');await this.page.keyboard.insertText(lines[i]);
      }
      await (await this.unique(this.page,this.ui.titleInput)).click();
    }else await field.fill(description);
  }

  async publish(job) {
    await this.verifyForm(job);
    if (this.ui.receipt.kind === 'network') {
      const button = await this.unique(this.page,this.ui.publishButton);
      const observation = await observeTrustedPublishClick(this.page,button);
      try {
        return await submitWithReceipt(this.page, this.ui.receipt, () => button.click({timeout:this.ui.timeoutMs}),
          {timeoutMs:this.ui.timeoutMs,clickTime:observation.time,abortClick:()=>this.page.close()});
      } finally {await observation.dispose();}
    }
    // Hidden old cards can reappear after submission; visibility is not freshness.
    const existingValues = await this.page.locator(this.ui.receipt.selector).evaluateAll(
      (nodes, attribute) => nodes.map(node => attribute ? node.getAttribute(attribute) : node.textContent),
      this.ui.receipt.attribute ?? null
    );
    const before = new Set(existingValues.map(raw => {
      const value = normalize(raw ?? '');
      return this.ui.receipt.pattern ? normalize(value.match(new RegExp(this.ui.receipt.pattern, 'u'))?.[1] ?? '') : value;
    }).filter(Boolean));
    if (await this.page.locator(this.ui.success).isVisible()) throw new Error('提交前已存在成功提示，不能用于核对本次投稿');
    // Exactly one click. Any subsequent uncertainty is handled as UNKNOWN by runner.
    await (await this.unique(this.page, this.ui.publishButton)).click();
    await this.unique(this.page, this.ui.success);
    const platformId = await this.read(this.page, this.ui.receipt);
    if (!platformId || before.has(platformId)) throw new Error('无新的唯一投稿回执 receipt');
    return { status: 'PENDING_REVIEW', platformId };
  }
}
