# 抖音发布工作台

面向单运营的 Windows 本地多账号视频发布工作台，使用 Electron、Node.js 和 Playwright 构建。

## 功能

- 多账号配置、独立登录态与账号身份核对。
- 导入账号表和 Excel 文案，扫描本地视频素材。
- 发布前预览账号、视频与完整文案。
- 发布回执确认、素材防重、已发素材归档与恢复。
- 本地网页入口及 Windows 桌面客户端。

当前桌面主线为普通账号发布。星图任务关联仍属于待真实验收的试点功能；模拟测试通过不代表真实平台流程已全部适配。

## 开发运行

环境：Windows、Node.js 24+；Excel 解析和打包需 Python 3.10+。

```powershell
npm.cmd ci --ignore-scripts
node node_modules/electron/install.js
npx.cmd --no-install playwright install chromium
npm.cmd run desktop
```

仓库默认禁用依赖安装脚本，Electron 的二进制需按上面的命令单独安装。首次启动创建空白本地配置，账号由用户自行添加和登录，不会自动发布。

## 打包 Windows 安装程序

```powershell
npm.cmd run desktop:build
```

安装文件位于 `dist/desktop/`。构建会收集本机 Python 标准库及已安装的 Chromium；安装包不纳入源码仓库。

## 离线演示与验证

```powershell
npm.cmd run demo
npm.cmd test
npm.cmd run test:v3
npm.cmd run test:browser
```

浏览器测试使用本地模拟页面，不向抖音发布内容。真实发布前需要用户登录、核对预览并确认执行。

## 使用说明

- [Windows 客户端试点](docs/Windows客户端试点使用说明.md)
- [普通账号网页工作台](docs/普通账号网页工作台使用说明.md)
- [普通账号运行说明](docs/普通账号运行说明.md)
- [v3 工作台](docs/v3工作台使用说明.md)
- [AI 工作流试点](docs/AI工作流试点使用说明.md)
- [Excel 文案](docs/Excel文案测试说明.md)

`config/*.example.json` 仅为示例，复制成 `*.local.json` 后按实际环境填写。本地配置不会提交。

## 可选历史适配器

`sau_demo/` 使用独立第三方项目 [social-auto-upload](https://github.com/dreammis/social-auto-upload)，通过 Git 子模块固定版本。仅在使用该适配器时执行：

```powershell
git submodule update --init
```

然后参考 [适配器说明](sau_demo/README.md)。主桌面工作台不依赖此子模块。第三方代码遵循其自身许可证。

## 数据边界

本仓库仅保存源码、测试、示例配置和使用说明。不包含真实账号登录态、Cookies、视频、Excel 业务资料、发布记录、截图或需求录音。请勿提交 `data/`、`outputs/`、`*.local.json`、`.env` 等本地数据。