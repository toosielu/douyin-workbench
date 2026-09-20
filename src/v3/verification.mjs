export function verifiedContinuation({error,verificationSeen,requestCount,receipts}){
 if(/多个创建请求/.test(error)||requestCount>2||receipts.length>1)throw Error('多个创建请求或回执，必须人工核对，不能自动确认成功');
 if(!verificationSeen||!(/JSON|回执.*超时/i.test(error)))return null;
 return receipts.length===1?receipts[0]:null;
}
export async function settleWithin(promises,ms){
 let timer;try{return await Promise.race([Promise.allSettled(promises).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}finally{clearTimeout(timer);}
}
