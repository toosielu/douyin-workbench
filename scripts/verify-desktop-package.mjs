import {execFileSync} from 'node:child_process';
import {access,readdir} from 'node:fs/promises';
import path from 'node:path';
const resources=path.resolve('dist/desktop/win-unpacked/resources');
const app=path.join(resources,'app');
for(const forbidden of ['config','data','outputs','.env']){
  if((await readdir(app)).includes(forbidden))throw Error(`安装包含禁止分发目录 ${forbidden}`);
}
const python=path.join(resources,'runtime/python/python.exe');
const result=JSON.parse(execFileSync(python,[path.join(app,'src/read-copy-xlsx.py'),path.join(app,'src/ordinary-public/accounts-template.xlsx'),'accounts'],{encoding:'utf8',windowsHide:true}));
if(result[0][0]!=='抖音号')throw Error('随包 Excel 读取失败');
process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(resources,'runtime/browsers');
const {chromium}=await import('playwright');await access(chromium.executablePath());
const browser=await chromium.launch({channel:'chromium',headless:true});
try{const page=await browser.newPage();await page.setContent('<h1>runtime ready</h1>');if(await page.locator('h1').innerText()!=='runtime ready')throw Error('随包浏览器失败');}
finally{await browser.close();}
console.log('安装包数据隔离、随包 Python Excel 读取、随包 Chromium 启动均通过。');
