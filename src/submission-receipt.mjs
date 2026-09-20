// Observe browser requests; never call an undocumented publishing endpoint directly.
import {randomUUID} from 'node:crypto';

export async function observeTrustedPublishClick(page, button) {
  const name = `__douyinPublish_${randomUUID().replaceAll('-','')}`;
  let resolveTime;
  const time = new Promise(resolve => {resolveTime=resolve;});
  const element = await button.elementHandle();
  if (!element) throw new Error('Publish button disappeared');
  let binding;
  try {
    binding = await page.exposeBinding(name, (source, timestamp) => {
      if (source.page === page && source.frame === page.mainFrame() && Number.isFinite(timestamp)) resolveTime(timestamp);
    });
    await element.evaluate((element, key) => {
      const handler = event => {
        if (event.isTrusted) window[key](performance.timeOrigin + performance.now()).catch(()=>{});
      };
      element[key] = handler;
      element.addEventListener('click',handler,{capture:true,once:true});
    },name);
  } catch (error) {await binding?.dispose().catch(()=>{});await element.dispose();throw error;}
  return {time, async dispose() {
    resolveTime(null);
    await element.evaluate((element,key)=>{element.removeEventListener('click',element[key],true);delete element[key];},name).catch(()=>{});
    await element.dispose().catch(()=>{});
    await binding.dispose().catch(()=>{});
  }};
}
export function validateReceiptUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://creator.douyin.com' || url.username || url.password || url.search || url.hash) throw new Error('Invalid receipt URL');
  return url;
}

export function extractSubmissionId(body) {
  if (body?.status_code !== 0) throw new Error('平台创建作品返回失败状态');
  const ids = new Set(); let invalid = false;
  function walk(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return;
    for (const [key, item] of Object.entries(value)) {
      if (['item_id','aweme_id'].includes(key)) {
        if (typeof item !== 'string' || !/^\d{15,25}$/.test(item)) invalid = true;
        else ids.add(item);
      } else if (typeof item === 'object') walk(item, depth + 1);
    }
  }
  walk(body);
  if (invalid || ids.size !== 1) throw new Error('无唯一有效投稿回执 receipt');
  return [...ids][0];
}

export async function submitWithReceipt(page, spec, click, {timeoutMs = 30000, clickTime, abortClick = async()=>{}} = {}) {
  const expected = validateReceiptUrl(spec.url);
  if (!clickTime || typeof clickTime.then !== 'function') throw new Error('Trusted click evidence required');
  let request; let timer; let done = false; let finish; let clickFinished = false; let receipt;
  let complete;
  const promise = new Promise((resolve, reject) => {
    finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer);
      page.off('request', onRequest); page.off('response', onResponse);
      if (error) {
        reject(error);
        if (!clickFinished) Promise.resolve().then(abortClick).catch(()=>{});
      } else resolve(result);
    };
    complete = () => {if (clickFinished && receipt) finish(null,receipt);};
    function onRequest(candidate) {
      try {
        const url = new URL(candidate.url());
        if (candidate.method() !== 'POST' || url.origin !== expected.origin || url.pathname !== expected.pathname || candidate.frame() !== page.mainFrame()) return;
        if (request && candidate !== request) { finish(new Error('检测到多个创建请求，需核对投稿')); return; }
        request = candidate;
      } catch { /* Non-frame requests cannot establish this page's receipt. */ }
    }
    async function onResponse(response) {
      if (!request || response.request() !== request || done) return;
      try {
        if (response.status() !== 200) throw new Error('创建作品 HTTP 状态异常');
        const actualClickAt = await clickTime;
        if (done) return;
        const startedAt = request.timing().startTime;
        if (!Number.isFinite(actualClickAt) || !Number.isFinite(startedAt) || startedAt < actualClickAt) throw new Error('创建请求早于实际点击，无法确认本次回执');
        let body;
        try { body = await response.json(); }
        catch {
          const error = new Error('平台创建作品回执为空、格式不完整或无法读取；投稿结果不明，请核对作品列表，禁止自动重发');
          error.receiptFailure={reason:'UNREADABLE_JSON',httpStatus:response.status(),url:spec.url};
          throw error;
        }
        const platformId = extractSubmissionId(body);
        receipt = {status:'PENDING_REVIEW', platformId, receiptEvidence:{
          source:'network', url:spec.url, httpStatus:200, platformStatus:0, clickAt:actualClickAt, requestAt:startedAt
        }};
        complete();
      } catch (error) { finish(error); }
    }
    page.on('request', onRequest); page.on('response', onResponse);
    timer = setTimeout(() => {
      finish(new Error('等待唯一投稿回执 receipt 超时，禁止自动重发'));
    }, timeoutMs);
  });
  // A response may reject while click is still awaiting navigation.
  promise.catch(() => {});
  try { await click(); clickFinished = true; complete(); return await promise; }
  catch (error) { finish(error); throw error; }
}
