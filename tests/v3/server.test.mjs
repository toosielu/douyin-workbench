import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../../src/v3/server.mjs';

test('local server authenticates API and rejects hostile origin, host, paths and invalid bodies', async () => {
  const calls = [];
  const service = { getState: async () => ({ config: {}, jobs: [] }), preview: async () => ({ digest: 'abc' }), start: async body => { calls.push(body); return { active: true }; } };
  const app = await startServer(service);
  try {
    const url = new URL(app.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, 'Content-Type': 'application/json' };
    const call = (path, options = {}) => fetch(`${url.origin}${path}`, options);
    assert.equal((await call('/api/state')).status, 401);
    assert.equal((await call('/api/state', { headers })).status, 200);
    const hostileHostStatus = await new Promise((resolve, reject) => {
      http.get(`${url.origin}/api/state`, { headers: { ...headers, Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await call('/api/start', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
    assert.equal((await call('/api/start', { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await call('/api/start', { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await call('/api/start', { method: 'POST', headers, body: JSON.stringify({ digest: 'abc', confirmRemoteWrite: true, simulation: true }) })).status, 200);
    assert.equal(calls.length, 1);
    assert.equal((await call('/api/nope', { headers })).status, 404);
    assert.equal((await call('/%2e%2e/package.json')).status, 404);
    assert.equal((await call('/api/preview', { method: 'POST', headers, body: JSON.stringify({ text: 'a'.repeat(1024 * 1024) }) })).status, 413);
    const page = await call('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    assert.match(await page.text(), /本地发布工作台/);
  } finally { await app.close(); }
});

test('API dispatch preserves inputs, reports service failures and requires Origin on writes', async () => {
  const recorded = [];
  const service = Object.fromEntries(['saveConfig', 'preview', 'stop', 'retryArchive', 'reconcile', 'importPreview', 'login', 'continueLogin'].map(method => [method, async value => { recorded.push([method, value]); return { ok: true }; }]));
  service.getState = async () => { throw new Error('配置未准备好'); };
  const app = await startServer(service);
  try {
    const url = new URL(app.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, 'Content-Type': 'application/json' };
    const post = (path, body, customHeaders = headers) => fetch(`${url.origin}/api/${path}`, { method: 'POST', headers: customHeaders, body: JSON.stringify(body) });
    assert.equal((await post('stop', {}, { Authorization: headers.Authorization, 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post('config', { config: { mode: 'simulation' } })).status, 200);
    assert.equal((await post('preview', {})).status, 200);
    assert.equal((await post('stop', {})).status, 200);
    assert.equal((await post('archive', { jobId: 'one' })).status, 200);
    assert.equal((await post('reconcile', { jobId: 'one', result: 'accepted', platformId: '123', note: '已核对作品列表' })).status, 200);
    assert.equal((await post('reconcile', { jobId: 'one', result: 'accepted', note: '缺少作品编号' })).status, 400);
    assert.equal((await post('import-preview', { kind: 'copies', format: 'json', text: '[]' })).status, 200);
    assert.equal((await post('login', {})).status, 400);
    assert.equal((await post('login', { accountId: 'owned-account', extra: true })).status, 200);
    assert.equal((await post('login-continue', {})).status, 200);
    assert.deepEqual(recorded.map(call => call[0]), ['saveConfig', 'preview', 'stop', 'retryArchive', 'reconcile', 'importPreview', 'login', 'continueLogin']);
    assert.deepEqual(recorded[6][1], { accountId: 'owned-account' });
    assert.deepEqual(recorded[0][1], { mode: 'simulation' });
    assert.equal(recorded[3][1], 'one');
    const failure = await fetch(`${url.origin}/api/state`, { headers });
    assert.equal(failure.status, 400);
    assert.deepEqual(await failure.json(), { error: '配置未准备好' });
  } finally { await app.close(); }
});
