import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {submitWithReceipt, extractSubmissionId} from '../src/submission-receipt.mjs';
const url='https://creator.douyin.com/web/api/media/aweme/create_v2/';
const id='7686179798686731572';
function fixture(){
  const page=new EventEmitter(); const frame={};page.mainFrame=()=>frame;
  const request={url:()=>url,method:()=> 'POST',frame:()=>frame,timing:()=>({startTime:101})};
  const response=(body={status_code:0,data:{item_id:id}},http=200,req=request)=>({request:()=>req,status:()=>http,json:async()=>body});
  return {page,request,response};
}
test('receipt accepts only one unambiguous string identifier with success status',()=>{
  assert.equal(extractSubmissionId({status_code:0,data:{item_id:id}}),id);
  for(const value of [{status_code:1,item_id:id},{status_code:0},{status_code:0,item_id:Number(id)},{status_code:0,item_id:id,aweme_id:'7686179798686731573'}]) assert.throws(()=>extractSubmissionId(value));
});
test('receipt listener is installed before click and gets the exact new request',async()=>{
  const {page,request,response}=fixture();let clicks=0;
  const result=await submitWithReceipt(page,{url},async()=>{clicks++;page.emit('request',request);page.emit('response',response());},{timeoutMs:100,clickTime:Promise.resolve(100)});
  assert.equal(result.platformId,id);assert.equal(clicks,1);
  assert.equal(page.listenerCount('request'),0);assert.equal(page.listenerCount('response'),0);
});
test('old response without a new request and unrelated frame cannot prove success',async()=>{
  for(const variant of ['old','frame']) {
    const {page,request,response}=fixture();
    const req=variant==='frame'?{...request,frame:()=>({})}:request;
    await assert.rejects(submitWithReceipt(page,{url},async()=>{if(variant==='frame')page.emit('request',req);page.emit('response',response(undefined,200,req));},{timeoutMs:20,clickTime:Promise.resolve(100)}),/receipt|回执/);
    assert.equal(page.listenerCount('response'),0);
  }
});
test('creation errors and multiple create requests fail without a second click',async()=>{
  for(const variant of ['http','status','duplicate','click']) {
    const {page,request,response}=fixture();let clicks=0;
    await assert.rejects(submitWithReceipt(page,{url},async()=>{
      clicks++;if(variant==='click')throw new Error('click failed');
      page.emit('request',request);
      if(variant==='duplicate')page.emit('request',{...request});
      page.emit('response',response({status_code:variant==='status'?1:0,item_id:id},variant==='http'?500:200));
    },{timeoutMs:100,clickTime:Promise.resolve(100)}));
    assert.equal(clicks,1);assert.equal(page.listenerCount('response'),0);
  }
});

test('creation request before the trusted click cannot establish a receipt',async()=>{
  const {page,request,response}=fixture();let markClick;
  const clickTime=new Promise(resolve=>{markClick=resolve;});
  await assert.rejects(submitWithReceipt(page,{url},async()=>{
    page.emit('request',request);page.emit('response',response());
    await new Promise(resolve=>setImmediate(resolve));markClick(102);
  },{timeoutMs:100,clickTime}),/点击|click/);
});
test('listeners remain active until click finishes, including a later duplicate',async()=>{
  const {page,request,response}=fixture();
  await assert.rejects(submitWithReceipt(page,{url},async()=>{
    page.emit('request',request);page.emit('response',response());
    await new Promise(resolve=>setImmediate(resolve));
    const second={...request};page.emit('request',second);page.emit('response',response(undefined,200,second));
  },{timeoutMs:100,clickTime:Promise.resolve(100)}),/多个/);
});
test('timeout cancels an unfinished click rather than letting it publish later',async()=>{
  const {page}=fixture();let release;let aborted=false;
  await assert.rejects(submitWithReceipt(page,{url},()=>new Promise(resolve=>{release=resolve;}),{
    timeoutMs:20,clickTime:new Promise(()=>{}),abortClick:async()=>{aborted=true;release();}
  }),/receipt|回执/);
  assert.equal(aborted,true);
});
test('unreadable JSON remains unknown, records diagnostic, and never clicks again',async()=>{
  const {page,request,response}=fixture();let clicks=0;
  await assert.rejects(submitWithReceipt(page,{url},async()=>{
    clicks++;page.emit('request',request);page.emit('response',{...response(),json:async()=>{throw new SyntaxError('Unexpected end of JSON input');}});
  },{timeoutMs:100,clickTime:Promise.resolve(100)}),error=>{
    assert.match(error.message,/结果不明/);assert.equal(error.receiptFailure.reason,'UNREADABLE_JSON');return true;
  });
  assert.equal(clicks,1);assert.equal(page.listenerCount('response'),0);
});
