import path from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { atomicJson, withStore } from './store.mjs';
import { inspectMaterial } from './materials.mjs';
import { loadConfig } from './config.mjs';
import { main as cli } from './cli.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function exists(file) {
  try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export async function setupOrdinary({ projectDir = project, file, douyinId, uiTemplate, minFileAgeSeconds = 60 }) {
  const identity = String(douyinId ?? '').replace(/^\s*抖音号\s*[:：]\s*/, '').trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(identity)) throw new Error('请输入个人主页上的抖音号，不是昵称、密码或验证码。');
  const material = await inspectMaterial(file, { minFileAgeSeconds });
  const configFile = path.join(projectDir, 'config', 'ordinary-account.local.json');
  const uiFile = path.join(projectDir, 'config', 'ordinary-ui.local.json');
  const dataDir = path.join(projectDir, 'data', 'ordinary-test');
  return withStore(dataDir, async () => {
    if (await exists(configFile)) {
      const saved = await loadConfig(configFile);
      if (saved.accounts.length !== 1 || saved.accounts[0].id !== 'ordinary-test' ||
        saved.accounts[0].mode !== 'ordinary' || saved.accounts[0].expectedIdentity !== identity ||
        saved.accounts[0].materialFile !== material.path || saved.dailyTarget !== 1) {
        throw new Error('已有 existing 普通账号配置与输入不同，未覆盖；请先核对配置和历史记录。');
      }
      return { configFile, accountId: 'ordinary-test', material };
    }
    if (!await exists(uiFile)) {
      const template = uiTemplate ?? JSON.parse(await readFile(path.join(projectDir, 'config', 'ordinary-ui.example.json'), 'utf8'));
      await atomicJson(uiFile, template);
    }
    await atomicJson(configFile, { dataDir, uiFile, dailyTarget: 1, maxAttemptsPerDay: 1,
      minFileAgeSeconds, intervalSeconds: 0, browser: { headless: false }, accounts: [{
        id: 'ordinary-test', mode: 'ordinary', expectedIdentity: identity,
        materialDir: path.dirname(material.path), materialFile: material.path, titleTemplate: '{filename}', tasks: []
      }] });
    return { configFile, accountId: 'ordinary-test', material };
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    file: { type: 'string' }, 'douyin-id': { type: 'string' }, 'setup-only': { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log('node src/ordinary-login.mjs --file <视频完整路径> [--douyin-id <抖音号>] [--setup-only]\n只准备单条配置和扫码登录，不上传、不保存草稿、不发布。');
    return;
  }
  if (!values.file) throw new Error('请指定 --file 视频完整路径');
  let identity = values['douyin-id'];
  if (!identity) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { identity = await prompt.question('输入测试账号的抖音号（不是昵称，不要输入密码或验证码）：'); }
    finally { prompt.close(); }
  }
  const result = await setupOrdinary({ file: values.file, douyinId: identity });
  console.log(`单条视频：${result.material.path}\n标题：${path.basename(result.material.path, path.extname(result.material.path))}\n模式：普通视频，无商业任务。`);
  if (!values['setup-only']) await cli(['connect', '--config', result.configFile, '--account', result.accountId]);
  else console.log(`配置已准备：${result.configFile}；未打开浏览器。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
