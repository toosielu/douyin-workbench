# 抖音多账号发布 Demo（social-auto-upload）

用于测试普通视频的多账号串行发布。账号和素材通过 JSON 配置；每个账号单独保存登录态。这里没有星川/星图任务绑定，也不自动查询审核结果。

**2026-09-17 本机验证状态：**45 项离线测试通过，两账号四条模拟作品及重复跳过均已验证。已按用户给出的 `D:/Demo/douyin_play/video/test1.mp4` 生成两个账号各一条的待确认预览。虚拟环境已创建，但 Patchright wheel 下载在直连及本机代理下均未完成；业务依赖、Chromium 尚未安装，未执行真实登录或发布。先完成下面第 2 步，再进入真实测试。

## 1. 先运行离线演示

在 `D:\CodexProject\tiktok_ai` 双击 `sau-demo.cmd`，或在 PowerShell 执行：

```powershell
.\sau-demo.cmd demo
```

两个虚拟账号各两条模拟作品，第一次得到 4 条 `SIMULATED`，重复执行同一批次得到 4 条 `SKIPPED`。不打开浏览器、不登录、不上传，不需要安装第三方依赖。

模拟报告在 `demo-output/sau/latest-report.json`。模拟素材是不可播放的测试文件，模拟配置明确标记为 `simulation: true`，真实入口会拒绝；不要修改标记后拿它做真实测试。

## 2. 准备本机环境

环境：Windows，Python 3.12。依赖使用本地 `.sau-demo-venv`，浏览器放在 `.sau-demo-browsers`，不会替换全局 Python 包。

```powershell
.\setup-sau-demo.cmd
```

脚本安装指定版本的公开 PyPI wheel 和 Patchright Chromium；仅在缺失时从上游样例生成 `social-auto-upload/conf.py`。网络下载失败会返回非零状态，可恢复网络后重跑。脚本不登录、不上传、不启动旧 Web 或数据库。无需安装上游聚合 CLI 的其他平台依赖。

若需要使用本机已配置的代理，可显式传入地址，例如 `.\setup-sau-demo.cmd -Proxy http://127.0.0.1:7897`。代理仅影响本次安装进程，不改系统代理；此地址在本轮也未完成大文件下载，不代表已确认能解决网络问题。

## 3. 指定两个账号和视频

```powershell
Copy-Item config/sau-accounts.example.json config/sau-accounts.local.json
```

已有本机配置时不要覆盖。修改本机配置中的 `accounts`：

```json
{
  "simulation": false,
  "headless": false,
  "intervalSeconds": 15,
  "timeoutSeconds": 600,
  "accounts": [
    {"account": "account-a", "videos": [
      {"file": "D:/Demo/douyin_play/video/test1.mp4", "title": "test1", "description": "", "tags": [], "declaration": null}
    ]},
    {"account": "account-b", "videos": [
      {"file": "D:/Demo/douyin_play/video/test1.mp4", "title": "test1", "description": "", "tags": [], "declaration": null}
    ]}
  ]
}
```

上述例子表示两个账号各发同一条视频一次；也可以给各账号配置不同视频。`file` 支持绝对路径或相对于配置文件的路径，仅接受本机 `.mp4/.mov/.m4v`，不接网络盘或链接目录。`account` 是固定本地别名，不是密码，也不是自动识别出的抖音 UID；不能改名来清空防重历史。

`declaration: null` 表示不主动设置自主声明，适配层会阻止上游自动套用“内容由AI生成”。需要声明时，填写符合实际作品的准确平台选项文字。标题限 30 个字符。首次测试建议每账号一条、保留可见浏览器。

## 4. 分别扫码登录

以下命令会访问抖音并保存本机登录态，请由操作者明确启动：

```powershell
.\sau-demo.cmd login --account account-a
.\sau-demo.cmd login --account account-b
.\sau-demo.cmd check --account account-a
.\sau-demo.cmd check --account account-b
```

每次在打开的浏览器里登录相应账号，核对实际抖音号和本地别名。凭据分别保存在 `social-auto-upload/cookies/douyin_account-a.json` 和 `douyin_account-b.json`。`check` 只检查会话能否进入创作者页面，不验证它是否属于预期的自然人或业务账号。

短信二次验证请直接在可见浏览器处理。Demo 不读取上游共用的 `verify_code.txt`，不在日志中输出短信码，也不自动处理其他安全验证。等待超过 `timeoutSeconds` 后会停止本次操作。

## 5. 预览，再明确启动发布

```powershell
.\sau-demo.cmd plan
```

检查终端及 `data/sau-publish/plan.json`：账号、完整路径、标题、话题、自主声明和数量是否正确。预览只做本地检查，不会上传。视频或配置改变后必须重新预览。

确认本批次确实可以上传并公开发布后，再执行：

```powershell
.\sau-demo.cmd publish --confirm-remote-write
.\sau-demo.cmd report
```

**这是立即发布入口，不是保存草稿。** 选择视频时就会上传到平台。未经具体批次确认，不应由助手代执行。启动器不带参数时始终只运行离线演示。

每个账号独立运行并串行处理，不同时操作两个账号。上传前保存提交意图，并校验暂存视频副本与预览指纹一致，避免浏览器启动期间原文件变化造成错发。暂存副本约需要一条视频大小的额外磁盘空间。

## 6. 如何看结果

真实台账：`data/sau-publish/ledger.json`；最近一次运行报告：`data/sau-publish/last-report.json`。模拟台账完全独立。

| 状态 | 含义与处理 |
|---|---|
| `SUBMITTED_UNVERIFIED` | 上游上传流程返回，但没有取得唯一作品 ID；请到作品管理核对，不能当作审核通过 |
| `SKIPPED` | 同账号、同素材已存在提交记录，本次不再发 |
| `FAILED_BEFORE_SUBMIT` | 明确在进入上传流程前失败，例如缺少登录态、素材变化、运行环境未就绪；处理后可重跑 |
| `SUBMITTING` | 已保存提交意图，进程可能仍在执行或中途退出；先核对平台 |
| `UNKNOWN` | 进入上传后超时、异常或回执缺失；禁止直接重发 |
| `BLOCKED` | 该账号有未核实结果，本次暂停该账号，其他账号仍可继续 |
| `SIMULATED` | 仅存在于离线模拟，无真实发布 |

同账号防重基于文件 SHA-256，跨批次有效；相同素材可分给不同账号。内容重新编码后指纹会变化，因此它不是相似视频检测。

该 Demo 不提供一键清空台账或强制重试。遇到 `UNKNOWN/SUBMITTING`，先核对实际账号的作品管理并保留证据，再处理对应记录；不要删除台账来绕过去重。提交后的异常始终按可能已发处理。

运行锁位于 `data/sau-publish/run.lock`，包含进程 ID。异常断电留下锁时，先确认那个进程确实已结束，再人工移除锁；这不会解除台账中的未决记录。硬超时停止进程后如有残留暂存视频，在确认执行已停止后清理 `.sau-demo-cache/upload-staging` 中对应目录。

## 7. 本地自动测试

```powershell
python -X utf8 -m unittest discover -s sau_demo/tests -v
```

测试使用本机临时文件与模拟上传器，覆盖账号分配、确认边界、防重、素材变更、未知结果隔离、超时、声明和日志保护；不发布真实作品。测试通过不等于当前抖音页面已完成实测。
