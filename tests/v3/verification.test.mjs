import test from 'node:test';import assert from 'node:assert/strict';
import {verifiedContinuation,settleWithin} from '../../src/v3/verification.mjs';
test('only observed verification with a single continued successful receipt resolves uncertainty',()=>{
 const receipt={platformId:'7686206594555727139'};
 const base={error:'Unexpected end of JSON input',verificationSeen:true,requestCount:2,receipts:[receipt]};
 assert.deepEqual(verifiedContinuation(base),receipt);
 assert.equal(verifiedContinuation({...base,verificationSeen:false}),null);
 assert.throws(()=>verifiedContinuation({...base,error:'检测到多个创建请求，需核对投稿'}));
 assert.throws(()=>verifiedContinuation({...base,receipts:[receipt,receipt]}));
 assert.throws(()=>verifiedContinuation({...base,requestCount:3}));
 assert.equal(verifiedContinuation({...base,error:'平台创建作品返回失败状态'}),null);
});
test('manual verification deadline cannot be blocked by an unresolved response handler',async()=>{
 assert.equal(await settleWithin([new Promise(()=>{})],10),false);
 assert.equal(await settleWithin([Promise.resolve()],10),true);
});
