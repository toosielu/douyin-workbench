const $ = id => document.getElementById(id);
const fragment = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(fragment)) {
  sessionStorage.setItem('workstation-token', fragment);
  history.replaceState(null, '', location.pathname);
}
const token = sessionStorage.getItem('workstation-token') || '';
let state;
let configLoaded = false;
let busy = false;
let importDraft;
let reconcileJob;
let confirmedBatch;
const labels = { idle: '等待执行', preview: '预览就绪', scanning: '正在扫描', running: '执行中', stopped: '已停止后续发布', completed: '本轮已完成', finished: '本轮已完成', failed: '失败', error: '异常', unknown: '待核实', accepted: '平台已接收', submitted: '平台已接收', simulated: '模拟完成', simulation: '模拟完成', skipped: '已跳过', pending: '待处理', reserved: '已预占', used: '已使用', available: '可用', archived: '已归档', not_submitted: '确认未提交', not_archived: '未归档', archive_failed: '归档失败', uploading: '上传中', submitting: '提交中', preparing: '准备中', done: '已完成', none: '无需处理' };
Object.assign(labels, { ready: '准备就绪', cancelled: '已取消', stopping: '停止中', waiting_login: '等待本人完成账号登录', validating: '正在校验', reserving: '正在预占素材', archiving: '正在归档', waiting_verification: '等待人工验证', manual_reconciliation: '需要人工核实', login: '正在打开账号登录', verifying_identity: '正在核对账号身份' });
const label = value => labels[String(value).toLowerCase()] || value || '—';
const reasonLabels = { DUPLICATE_CONTENT: '相同内容已使用、已领取或待核实', NO_OWNED_AVAILABLE_ACCOUNT: '没有当前运营负责且可用的匹配账号', NO_ENABLED_COPY: '没有启用的文案', NO_ENABLED_TASK: '没有启用的任务', DESCRIPTION_TOO_LONG: '文案加标签后超过长度限制', NO_AVAILABLE_TASK: '当前账号页面没有可选的启用任务' };
const reason = value => reasonLabels[value] || value || '';
const isUnknown = job => [job.status, job.materialStatus].some(v => String(v).toLowerCase() === 'unknown');
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = !message; }
async function api(path, body) {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}
async function action(task) {
  if (busy) return;
  busy = true;
  renderControls();
  try { await task(); await refresh(); } catch (error) { notice(error.message, true); }
  finally { busy = false; renderControls(); }
}
function renderControls() {
  const active = Boolean(state?.run?.active);
  for (const id of ['preview', 'save-config', 'import-preview', 'config', 'import-kind', 'import-format', 'import-file', 'import-text']) $(id).disabled = busy || active;
  $('start').disabled = busy || active || !state?.preview?.digest || !state.preview.jobs?.length;
  $('stop').disabled = busy || !active || state?.run?.stopRequested;
  $('apply-import').disabled = busy || active || !importDraft;
  $('login-account').disabled = busy || active;
  $('login').disabled = busy || active || !$('login-account').value || state?.config?.mode !== 'live';
  $('login-continue').disabled = busy || String(state?.run?.phase).toUpperCase() !== 'WAITING_LOGIN';
}
function textCell(row, primary, secondary) {
  const cell = document.createElement('td');
  const text = document.createElement('div'); text.textContent = primary || '—'; cell.append(text);
  if (secondary) { const small = document.createElement('small'); small.textContent = secondary; cell.append(small); }
  row.append(cell); return cell;
}
function emptyRow(target, columns, message) { const row = document.createElement('tr'); const cell = textCell(row, message); cell.colSpan = columns; cell.className = 'empty'; target.append(row); }
function render() {
  const jobs = state.jobs || [];
  const preview = state.preview;
  const simulation = state.config?.mode !== 'live';
  $('mode').textContent = simulation ? '模拟模式 · 不真实投稿' : '真实发布模式';
  $('mode').classList.toggle('live', !simulation);
  $('start').textContent = simulation ? '开始本轮模拟' : '确认并发布本轮';
  $('count-candidates').textContent = preview?.jobs?.length ?? 0;
  $('count-done').textContent = jobs.filter(j => ['accepted', 'submitted', 'simulated', 'simulation'].includes(String(j.status).toLowerCase())).length;
  $('count-unknown').textContent = jobs.filter(isUnknown).length;
  $('count-errors').textContent = jobs.filter(j => ['failed', 'error', 'skipped'].includes(String(j.status).toLowerCase())).length;
  $('phase').textContent = state.run?.stopRequested ? '将在当前操作结束后停止' : label(state.run?.phase || 'idle');
  const current = state.run?.current;
  $('current').textContent = state.run?.error || (current ? (typeof current === 'string' ? current : [current.filename, current.accountId, label(current.phase || current.status)].filter(Boolean).join(' · ')) : '仅处理预览清单中的当天素材；本轮完成即结束。');
  $('preview-date').textContent = preview?.date || '尚未预览';
  const rows = $('preview-rows'); rows.replaceChildren();
  for (const job of preview?.jobs || []) {
    const row = document.createElement('tr');
    textCell(row, job.filename || job.path, job.koc);
    textCell(row, job.accountId, job.expectedIdentity);
    textCell(row, job.title, job.description);
    textCell(row, job.taskName || job.taskId || '执行时核对可选任务', (job.taskCandidates || job.candidateTasks)?.map(t => t.name || t.id || t).join('、'));
    rows.append(row);
  }
  if (!rows.children.length) emptyRow(rows, 4, '还没有候选素材。保存基础资料后，点击「扫描并预览」。');
  $('skipped').textContent = preview?.skipped?.length ? `扫描跳过 ${preview.skipped.length} 项：${preview.skipped.map(j => typeof j === 'string' ? reason(j) : `${j.filename || j.path || ''} ${reason(j.reason || j.error)}`).join('；')}` : '';
  const records = $('record-rows'); records.replaceChildren();
  for (const job of [...jobs].reverse()) {
    const row = document.createElement('tr');
    textCell(row, job.filename || job.path, job.accountId);
    const simulated = job.simulation === true || String(job.archiveStatus).toUpperCase() === 'SIMULATED';
    const needsArchive = !simulated && String(job.status).toUpperCase() === 'ACCEPTED' && String(job.materialStatus).toUpperCase() === 'USED' && String(job.archiveStatus).toUpperCase() !== 'DONE';
    const status = textCell(row, simulated && String(job.status).toUpperCase() === 'ACCEPTED' ? '模拟完成（未投稿）' : label(job.status), reason(job.error) || (job.platformId ? `${simulated ? '模拟' : '作品'}编号：${job.platformId}` : ''));
    if (isUnknown(job)) status.classList.add('warning-text');
    textCell(row, label(job.materialStatus)); textCell(row, String(job.archiveStatus).toUpperCase() === 'SIMULATED' ? '模拟归档（未移动）' : needsArchive && String(job.archiveStatus).toUpperCase() === 'NONE' ? '待归档' : label(job.archiveStatus), job.archiveError);
    const controls = document.createElement('td');
    if (!state.run?.active && (isUnknown(job) || ['RUNNING', 'SUBMITTING', 'FAILED', 'READY'].includes(String(job.status).toUpperCase()))) { const button = document.createElement('button'); button.className = 'small secondary'; button.textContent = '人工核实'; button.onclick = () => { reconcileJob = job.id; $('platform-id').value = ''; $('reconcile-note').value = ''; $('reconcile').showModal(); }; controls.append(button); }
    if (needsArchive) { const button = document.createElement('button'); button.className = 'small secondary'; button.textContent = '补归档'; button.disabled = Boolean(state.run?.active); button.onclick = () => action(async () => { await api('archive', { jobId: job.id }); notice('归档操作已完成'); }); controls.append(button); }
    if (!controls.children.length) controls.textContent = '—'; row.append(controls); records.append(row);
  }
  if (!records.children.length) emptyRow(records, 5, '暂无执行记录。模拟运行可以验证本地处理链路。');
  if (!configLoaded) { $('config').value = JSON.stringify(state.config, null, 2); configLoaded = true; }
  const previousAccount = $('login-account').value;
  $('login-account').replaceChildren();
  for (const account of (state.config?.accounts || []).filter(account => account.enabled && account.operatorId === state.config.operatorId)) {
    const option = document.createElement('option'); option.value = account.id; option.textContent = `${account.id} · ${account.expectedIdentity || account.koc || ''}`; $('login-account').append(option);
  }
  if ([...$('login-account').options].some(option => option.value === previousAccount)) $('login-account').value = previousAccount;
  $('login-status').textContent = String(state.run?.phase).toUpperCase() === 'WAITING_LOGIN' ? `请在浏览器完成账号 ${state.run.current?.accountId || state.run.current || ''} 的登录，然后点击「已完成登录，核对并保存」。` : simulation ? '当前为模拟模式。真实账号登录需保存真实发布模式配置后由本人主动启动。' : '账号登录只会在点击按钮后启动。';
  renderControls();
}
async function refresh() { state = await api('state'); render(); }
$('preview').onclick = () => action(async () => { await api('preview', {}); notice('预览已更新，请检查素材、账号与文案。'); });
$('save-config').onclick = () => action(async () => { await api('config', { config: JSON.parse($('config').value) }); configLoaded = false; notice('配置已保存，请重新扫描生成预览。'); });
$('stop').onclick = () => action(async () => { await api('stop', {}); notice('已请求停止后续发布，当前操作会先完成结果核对。'); });
$('login').onclick = () => action(async () => { await api('login', { accountId: $('login-account').value }); notice('登录浏览器已启动，请由账号本人完成登录。'); });
$('login-continue').onclick = () => action(async () => { await api('login-continue', {}); notice('正在核对身份并保存会话，请等待核对结果。'); });
async function start(batch = { digest: state.preview?.digest, simulation: state.config.mode !== 'live' }) { await api('start', { ...batch, confirmRemoteWrite: true }); notice(batch.simulation ? '模拟已启动，不会真实投稿。' : '已启动本轮发布。'); }
$('start').onclick = () => {
  if (state.config.mode !== 'live') return action(start);
  confirmedBatch = { digest: state.preview.digest, simulation: false };
  $('confirm-text').textContent = `本轮共 ${state.preview.jobs.length} 条素材。请确认账号、文案、任务配置和素材归属，并已获得发布授权。`;
  $('confirm').showModal();
};
$('confirm').addEventListener('close', () => { if ($('confirm').returnValue === 'accept') action(() => start(confirmedBatch)); });
$('import-file').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 900_000) return notice('导入文件过大，请使用小于 900 KB 的文件。', true);
  $('import-text').value = await file.text(); $('import-format').value = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
  importDraft = null; renderControls();
};
for (const id of ['import-kind', 'import-format', 'import-text']) $(id).addEventListener('input', () => { importDraft = null; renderControls(); });
$('import-preview').onclick = () => action(async () => {
  importDraft = null;
  const result = await api('import-preview', { kind: $('import-kind').value, format: $('import-format').value, text: $('import-text').value });
  importDraft = result.config;
  $('import-result').textContent = JSON.stringify(result, null, 2);
  notice('导入已校验。应用到草稿后，检查配置并点击保存。');
});
$('apply-import').onclick = () => { $('config').value = JSON.stringify(importDraft, null, 2); importDraft = null; renderControls(); notice('导入已应用到草稿，尚未保存。'); };
$('cancel-reconcile').onclick = () => $('reconcile').close();
$('reconcile-form').onsubmit = event => { event.preventDefault(); action(async () => { await api('reconcile', { jobId: reconcileJob, result: $('reconcile-result').value, platformId: $('platform-id').value.trim(), note: $('reconcile-note').value.trim() }); $('reconcile').close(); notice('人工核实结果已记录。'); }); };
refresh().catch(error => notice(error.message, true));
setInterval(() => { if (!busy && !document.hidden) refresh().catch(error => notice(error.message, true)); }, 2000);
