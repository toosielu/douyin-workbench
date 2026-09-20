export function fixtureProfile() {
  return {
    evidence: 'fixture', timeoutMs: 700, uploadTimeoutMs: 700,
    uploadUrl: 'https://creator.douyin.com/creator-micro/content/post/video',
    identity: { selector: '#identity' }, uploadInput: '#upload', uploadComplete: '#complete',
    titleInput: '#title', taskOpen: '#open', taskDialog: '#dialog', taskSearch: '#search',
    taskRow: '#row-{taskId}', taskIdentity: { selector: '.task-id' }, taskSelect: 'input[type=radio]',
    taskConfirm: '#confirm', selectedTask: { selector: '#bound' }, publishButton: '#publish',
    success: '#success', receipt: { selector: '#receipt', pattern: '作品 ID：(\\d+)' }
  };
}

export function fixtureHtml(options = {}) {
  // All options are test-owned fixture values. This page has no network or server writes.
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
    <div id="identity">${options.identity ?? '抖音号：123456'}</div>
    <input id="upload" type="file" accept="video/*">
    <span id="complete" hidden>当前文件上传完成</span><input id="title">
    <button id="open">星图任务</button><div id="dialog" hidden>
      <input id="search" placeholder="输入任务id/任务名称">
      <div id="row-101"><span class="task-id">101</span><input type="radio" name="task"></div>
      <button id="confirm">确定</button></div>
    <div id="bound"></div><button id="publish">发布</button>
    <span id="success" hidden>已提交审核</span>
    <span id="receipt" ${options.staleReceipt ? '' : 'hidden'}>${options.staleReceipt || options.hiddenStaleReceipt ? '作品 ID：90001' : ''}</span>
    <script>
      window.clickCount = 0;
      document.querySelector('#upload').onchange = () => { if (!${Boolean(options.uploadStuck)}) document.querySelector('#complete').hidden = false; };
      document.querySelector('#open').onclick = () => document.querySelector('#dialog').hidden = false;
      document.querySelector('#confirm').onclick = () => {
        document.querySelector('#bound').textContent = '${options.bound ?? '101'}';
        document.querySelector('#dialog').hidden = true;
      };
      document.querySelector('#publish').onclick = () => {
        window.clickCount++; document.querySelector('#success').hidden = false;
        if (!${Boolean(options.noReceipt)}) { document.querySelector('#receipt').hidden = false; document.querySelector('#receipt').textContent = '作品 ID：90001'; }
      };
    </script></body></html>`;
}
