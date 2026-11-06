'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Connection}=require('../utils/connection');

function harness() {
  let time=0, sequence=0;
  const timers=new Map(),tasks=[],states=[],messages=[];
  const later=(fn,ms)=>{const id=++sequence;timers.set(id,{fn,at:time+ms});return id;};
  const advance=(ms)=>{
    const end=time+ms;
    for (let loops=0;loops<1000;loops++) {
      const list=Array.from(timers).filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at);
      if (!list.length) {time=end;return;}
      const [id,timer]=list[0];timers.delete(id);time=timer.at;timer.fn();
    }
    throw new Error('Timer loop did not settle');
  };
  const wx={connectSocket:()=>{
    const events={},sent=[];
    const task={events,sent,closed:false,
      onOpen(fn){events.open=fn;},onMessage(fn){events.message=fn;},onClose(fn){events.close=fn;},onError(fn){events.error=fn;},
      send(value){sent.push(JSON.parse(value.data));value.success();},
      close(){task.closed=true;if(events.close)events.close({code:1000});}};
    tasks.push(task);return task;
  }};
  const manager=new Connection({wx,onState:(...args)=>states.push(args),onMessage:value=>messages.push(value),setTimeout:later,clearTimeout:id=>timers.delete(id),random:()=>0.5,now:()=>time});
  return {manager,tasks,states,messages,advance,timers};
}
test('no background connections, and hide invalidates all pending callbacks', () => {
  const h=harness();h.manager.start('ws://pc/path');
  assert.equal(h.tasks.length,0);
  h.manager.setForeground(true);assert.equal(h.tasks.length,1);
  h.tasks[0].events.open();
  h.manager.setForeground(false);
  h.tasks[0].events.error();h.tasks[0].events.open();
  h.advance(100000);
  assert.equal(h.tasks.length,1);
  assert.equal(h.timers.size,0);
  h.manager.setForeground(true);assert.equal(h.tasks.length,2);
});
test('duplicate failures schedule one retry and only a stable open resets backoff', () => {
  const h=harness();h.manager.setForeground(true);h.manager.start('ws://pc/path');
  h.tasks[0].events.error();h.tasks[0].events.close({code:1006});
  assert.deepEqual(h.states[h.states.length-1],['reconnecting',800]);
  h.advance(799);assert.equal(h.tasks.length,1);
  h.advance(1);assert.equal(h.tasks.length,2);
  h.tasks[1].events.error();assert.deepEqual(h.states[h.states.length-1],['reconnecting',1600]);
  h.advance(1600);h.tasks[2].events.open();h.advance(10000);h.tasks[2].events.error();
  assert.deepEqual(h.states[h.states.length-1],['reconnecting',800]);
});
test('outgoing heartbeats cannot conceal a silent or half-open server connection', () => {
  const h=harness();h.manager.setForeground(true);h.manager.start('ws://pc/path');h.tasks[0].events.open();
  h.advance(30000);assert.equal(h.tasks[0].sent.length,2);
  h.advance(5000);assert.equal(h.tasks[0].closed,true);
  assert.equal(h.states[h.states.length-1][0],'reconnecting');
});
test('received messages refresh watchdog and stale socket messages are ignored', () => {
  const h=harness();h.manager.setForeground(true);h.manager.start('ws://pc/first');h.tasks[0].events.open();
  h.advance(20000);h.tasks[0].events.message({data:'pong'});
  h.advance(30000);assert.equal(h.tasks[0].closed,false);
  h.manager.start('ws://pc/second');h.tasks[0].events.message({data:'old'});
  assert.deepEqual(h.messages,['pong']);
  h.tasks[1].events.open();h.tasks[1].events.message({data:'new'});
  assert.deepEqual(h.messages,['pong','new']);
});
test('policy close on an established connection stops retrying until user reconnects', () => {
  const h=harness();h.manager.setForeground(true);h.manager.start('ws://pc/path');
  h.tasks[0].events.open();
  h.tasks[0].events.close({code:1008});h.advance(100000);
  assert.equal(h.tasks.length,1);assert.equal(h.manager.enabled,false);
  assert.deepEqual(h.states[h.states.length-1],['rejected']);
});
test('consecutive handshake failures remain visible but keep retrying and reset after success', () => {
  const h=harness();h.manager.setForeground(true);h.manager.start('ws://pc/path');
  h.tasks[0].events.error();h.advance(800);
  h.tasks[1].events.close({code:1006});h.advance(1600);
  h.tasks[2].events.error();
  assert.equal(h.manager.handshakeFailures,3);
  assert.equal(h.manager.enabled,true);
  h.advance(3200);assert.equal(h.tasks.length,4);
  h.tasks[3].events.open();assert.equal(h.manager.handshakeFailures,0);
});
test('send requires an open foreground connection and never queues stale control commands', async () => {
  const h=harness();h.manager.setForeground(true);h.manager.start('ws://pc/path');
  await assert.rejects(h.manager.send({type:'settings_set'}));
  h.tasks[0].events.open();await h.manager.send({type:'history_get'});
  assert.deepEqual(h.tasks[0].sent,[{type:'history_get'}]);
  h.manager.stop();await assert.rejects(h.manager.send({type:'settings_set'}));h.advance(100000);
  assert.equal(h.tasks.length,1);
});
