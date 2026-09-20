import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const routes = new Set(['/api/config', '/api/preview', '/api/ai-preview', '/api/start', '/api/stop', '/api/archive', '/api/reconcile', '/api/import-preview', '/api/login', '/api/login-continue']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function validate(path, body) {
  if (!object(body)) throw new Error('请求内容必须为 JSON 对象');
  if (path === '/api/login' && (typeof body.accountId !== 'string' || !body.accountId.trim())) throw new Error('请选择登录账号');
  if (path === '/api/config' && !object(body.config)) throw new Error('缺少配置对象');
  if (path === '/api/start' && (typeof body.digest !== 'string' || !body.digest || body.confirmRemoteWrite !== true || typeof body.simulation !== 'boolean')) throw new Error('请先预览并明确确认本轮操作');
  if (['/api/archive', '/api/reconcile'].includes(path) && (typeof body.jobId !== 'string' || !body.jobId)) throw new Error('缺少任务编号');
  if (path === '/api/reconcile' && (!['accepted', 'not_submitted'].includes(body.result) || typeof body.note !== 'string' || !body.note.trim() || (body.result === 'accepted' && (typeof body.platformId !== 'string' || !body.platformId.trim())))) throw new Error('请填写核实结论、依据和已接收作品的编号');
  if (path === '/api/import-preview' && (!['accounts', 'tasks', 'copies'].includes(body.kind) || !(['csv', 'json'].includes(body.format)||(body.kind==='accounts'&&body.format==='xlsx')) || typeof body.text !== 'string')) throw new Error('导入参数无效');
}
async function readBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new Error('请使用 application/json');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) { const error = new Error('请求超过 1 MB'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('JSON 格式无效'); }
}

export async function startServer(service, { port = 0, assetDirectory = new URL('./public/', import.meta.url) } = {}) {
  const token = randomBytes(32).toString('hex');
  const staticFiles = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) => [path, { content: await readFile(new URL(file, assetDirectory)), type }])));
  if(service.templateFile)staticFiles.set('/accounts-template.xlsx',{content:await readFile(service.templateFile),type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host) return json(403, { error: '本地 Host 校验失败' });
    const path = req.url;
    if (path.startsWith('/api/')) {
      const provided = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(401, { error: '会话失效，请使用启动终端中的完整地址重新打开工作台' });
      if (req.method !== 'GET' && req.headers.origin !== `http://${host}`) return json(403, { error: '请求来源校验失败' });
      if (!((path === '/api/state' && req.method === 'GET') || (routes.has(path) && req.method === 'POST'))) return json(404, { error: '接口不存在' });
      try {
        if (path === '/api/state') return json(200, await service.getState());
        const body = await readBody(req);
        validate(path, body);
        let result;
        switch (path) {
          case '/api/config': result = await service.saveConfig(body.config); break;
          case '/api/preview': result = await service.preview(); break;
          case '/api/ai-preview':
            if(typeof service.aiPreview!=='function')throw Error('此工作台不支持 AI 预览');
            result = await service.aiPreview(body); break;
          case '/api/start': result = await service.start(body); break;
          case '/api/stop': result = await service.stop(); break;
          case '/api/archive': result = await service.retryArchive(body.jobId); break;
          case '/api/reconcile': result = await service.reconcile(body); break;
          case '/api/import-preview': result = await service.importPreview(body); break;
          case '/api/login': result = await service.login({ accountId: body.accountId }); break;
          case '/api/login-continue': result = await service.continueLogin(); break;
        }
        json(200, result ?? { ok: true });
      } catch (error) { if (!res.headersSent) json(error.status === 413 ? 413 : 400, { error: error.message || '操作失败' }); }
      return;
    }
    const asset = staticFiles.get(path);
    if (req.method !== 'GET' || !asset) return json(404, { error: '页面不存在' });
    res.writeHead(200, { 'Content-Type': asset.type });
    res.end(asset.content);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  // Callers wait for service.whenIdle() before closing. Chromium can hold a
  // speculative TCP connection without sending HTTP, which closeIdleConnections
  // does not close; that connection must not prevent desktop shutdown forever.
  return { server, url: `http://127.0.0.1:${server.address().port}/#${token}`, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
