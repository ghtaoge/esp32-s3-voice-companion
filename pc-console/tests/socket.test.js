'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SocketLink}=require('../core');
function harness(){let now=0,id=0;const timers=new Map(),sockets=[],states=[];
  const later=(fn,delay)=>{const key=++id;timers.set(key,{fn,at:now+delay});return key;};
  const advance=ms=>{const end=now+ms;for(let n=0;n<10000;n++){const due=Array.from(timers).filter(([,value])=>value.at<=end).sort((a,b)=>a[1].at-b[1].at);if(!due.length){now=end;return;}const[key,value]=due[0];timers.delete(key);now=value.at;value.fn();}throw Error('timer loop');};
  const link=new SocketLink({now:()=>now,setTimeout:later,clearTimeout:key=>timers.delete(key),random:()=>.5,onState:name=>states.push(name),createSocket:()=>{const socket={sent:[],bufferedAmount:0,send(data){this.sent.push(JSON.parse(data));},close(){if(this.onclose)this.onclose({code:1000});}};sockets.push(socket);return socket;}});
  return{link,timers,sockets,states,advance};
}
test('manual disconnect remains disconnected after hide/show',()=>{const h=harness();h.link.start('ws://local');h.sockets[0].onopen();h.link.destroy();h.link.foreground(false);h.link.foreground(true);h.advance(60000);assert.equal(h.sockets.length,1);assert.equal(h.timers.size,0);});
test('flapping sockets preserve backoff; stale native close/error events cannot multiply retries',()=>{
  const h=harness();h.link.start('ws://local');h.sockets[0].onopen();h.sockets[0].onerror();h.sockets[0].onclose({code:1006});h.advance(800);
  assert.equal(h.sockets.length,2);h.sockets[1].onopen();h.sockets[1].onclose({code:1006});h.advance(800);assert.equal(h.sockets.length,2);h.advance(800);assert.equal(h.sockets.length,3);
});
test('heartbeat cannot conceal missing incoming messages, and hidden pages retain no timers',()=>{
  const h=harness();h.link.start('ws://local');h.sockets[0].onopen();h.advance(35000);assert.ok(h.states.includes('reconnecting'));h.link.foreground(false);assert.equal(h.timers.size,0);
});
test('outgoing control backlog is bounded and causes explicit reconnection',()=>{
  const h=harness();h.link.start('ws://local');h.sockets[0].onopen();h.sockets[0].bufferedAmount=40000;assert.throws(()=>h.link.send({type:'settings_set'}));assert.ok(h.states.includes('reconnecting'));
});
