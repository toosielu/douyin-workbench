import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {startServer} from '../src/v3/server.mjs';
test('server shutdown does not hang on a browser preconnected socket',async()=>{
 const host=await startServer({getState:async()=>({})});
 const socket=net.connect(new URL(host.url).port,'127.0.0.1');
 await new Promise(resolve=>socket.once('connect',resolve));
 let timer;
 try{const result=await Promise.race([host.close().then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);assert.equal(result,true);}
 finally{clearTimeout(timer);socket.destroy();}
});
