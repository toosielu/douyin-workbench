import {parseArgs} from 'node:util';
import {loadCopyLibrary,chooseCopy} from './copy-library.mjs';
import {scanMaterials} from './materials.mjs';
import {localPath} from './config.mjs';
const {values}=parseArgs({options:{excel:{type:'string'},materials:{type:'string'}}});
if(!values.excel||!values.materials)throw Error('需要 --excel 文案.xlsx --materials 素材目录');
const copies=await loadCopyLibrary(localPath(values.excel));
const materials=await scanMaterials(localPath(values.materials),{minFileAgeSeconds:0,recursive:false});
console.log('仅预览文案组合：不上传、不发布、不修改账本，也不检查发布历史。');
console.log(`已读取 ${copies.length} 条启用文案。`);
for(const material of materials){const copy=chooseCopy(copies,material.path);console.log(`\n视频：${material.path}\n文案编号：${copy.copyId}\n${copy.description}`);}
