import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {scanMaterials,inspectMaterial} from '../src/materials.mjs';
import {archiveOrdinary} from '../src/ordinary-archive.mjs';
test('accepted ordinary post archives per KOC, supports recovery, and scans only direct videos',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ordinary-archive-'));
 try{
 const file=path.join(root,'fzq_A_3_KOC1.mp4');await writeFile(file,'video');
 await mkdir(path.join(root,'nested'));await writeFile(path.join(root,'nested','other.mp4'),'other');
 assert.equal((await scanMaterials(root,{minFileAgeSeconds:0,recursive:false})).length,1);
 const job={...await inspectMaterial(file,{minFileAgeSeconds:0}),status:'PENDING_REVIEW',platformId:'12345'};
 let saves=0;await archiveOrdinary({materialDir:root},job,async()=>{saves++;});
 assert.equal(job.archive.archiveStatus,'DONE');assert.ok(saves>=2);
 await access(path.join(root,'已发_KOC1','fzq_A_3_KOC1.mp4'));await assert.rejects(access(file));
 assert.equal((await scanMaterials(root,{minFileAgeSeconds:0,recursive:false})).length,0);
 await archiveOrdinary({materialDir:root},job,async()=>{});assert.equal(job.archive.archiveStatus,'DONE');
 await assert.rejects(archiveOrdinary({materialDir:root},{...job,status:'UNKNOWN'},async()=>{}),/接收/);
 }finally{await rm(root,{recursive:true,force:true});}
});
