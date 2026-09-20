# Excel 文案测试说明

示例文案位于 `tests/fixtures/copy-library.xlsx`，包含 20 条合成测试文案，每条附有 3–5 个标签，不含真实账号信息。

```powershell
node src/copy-preview.mjs --excel tests/fixtures/copy-library.xlsx --materials "D:\素材\测试视频"
```

预览只展示文案组合，不登录、不上传、不发布。请把素材路径替换成自己的本地测试目录。

真实使用请通过桌面工作台选择文案 Excel，完成账号登录、身份核对及预览，再确认发布。发布账本和平台回执保存在本机，不提交 Git。