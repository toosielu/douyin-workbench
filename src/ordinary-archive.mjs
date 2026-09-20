import path from 'node:path';
import {archive} from './v3/materials.mjs';
import {parseFilename} from './v3/config.mjs';
export async function archiveOrdinary(account,job,save){
 if(!['PENDING_REVIEW','APPROVED'].includes(job.status)||!job.platformId)throw Error('只有平台已接收的投稿可以归档');
 const dayDir=path.resolve(account.materialDir),filename=path.basename(job.path);
 if(path.dirname(path.resolve(job.path))!==dayDir)throw Error('只归档当前目录直属视频');
 const {koc}=parseFilename(filename);
 const expected={status:'ACCEPTED',materialStatus:'USED',dayDir,filename,koc,path:job.path,hash:job.hash};
 if(job.archive){for(const key of Object.keys(expected))if(job.archive[key]!==expected[key])throw Error('归档记录与素材不一致');}
 else job.archive=expected;
 await archive({root:dayDir},job.archive,save);
 return job.archive;
}
