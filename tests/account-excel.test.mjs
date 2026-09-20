import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAccountRows,readAccountExcel} from '../src/account-excel.mjs';
import {fileURLToPath} from 'node:url';
const header=['抖音号','负责运营','剪辑师代号','KOC','素材目录','是否启用'];
test('account Excel validates complete rows, duplicate IDs, and enabled flags',()=>{
  const row=['00123','运营甲','fzq','KOC1',process.cwd(),'是'];
  assert.equal(normalizeAccountRows([header,row])[0].expectedIdentity,'00123');
  assert.throws(()=>normalizeAccountRows([header,row,row]),/第 3 行.*重复/);
  assert.throws(()=>normalizeAccountRows([header,[...row.slice(0,5),'maybe']]),/是否启用/);
  assert.throws(()=>normalizeAccountRows([['错误表头'],row]),/表头/);
});
test('generated XLSX template is readable and example is disabled',async()=>{
  const rows=await readAccountExcel(fileURLToPath(new URL('../src/ordinary-public/accounts-template.xlsx',import.meta.url)));
  assert.equal(rows.length,1);assert.equal(rows[0].enabled,false);assert.equal(rows[0].koc,'KOC1');
});
