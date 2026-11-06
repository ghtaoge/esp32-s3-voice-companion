'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const protocol=require('../../miniprogram/utils/protocol');
test('default browser timers preserve native Window/undefined receiver rather than SocketLink',()=>{
  const sandbox=vm.createContext({VoiceProtocol:protocol});
  vm.runInContext(`
    window=globalThis; timerCalls=0; clearCalls=0;
    setTimeout=function(fn,ms){'use strict';if(this!==undefined&&this!==window)throw new TypeError('Illegal invocation');timerCalls++;return timerCalls;};
    clearTimeout=function(id){'use strict';if(this!==undefined&&this!==window)throw new TypeError('Illegal invocation');clearCalls++;};
  `,sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../core.js'),'utf8'),sandbox);
  assert.doesNotThrow(()=>vm.runInContext(`
    socket={bufferedAmount:0,send:function(){},close:function(){}};
    link=new VoiceConsole.SocketLink({createSocket:function(){return socket;}});
    link.start('ws://127.0.0.1:8765');socket.onopen();link.foreground(false);
  `,sandbox));
  assert.ok(sandbox.timerCalls>=3);assert.ok(sandbox.clearCalls>=3);
});
