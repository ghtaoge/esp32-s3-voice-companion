'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const cues=require('../utils/emotion-cues');

test('negation explains the original word without inventing an opposite emotion',()=>{
  for(const text of ['不开心','一点也不开心','我并不是很开心']){
    const value=cues.analyze(text).cues[0];
    assert.equal(value.label,'happy');assert.equal(value.negated,true);
    assert.equal(value.negation,'negated');assert.ok(value.reason.includes('不能直接翻成相反'));
  }
  const double=cues.analyze('不是不开心').cues[0];
  assert.equal(double.label,'happy');assert.equal(double.negated,false);assert.equal(double.negation,'double_negated');
  assert.equal(double.text,'不是不开心');
});
test('degree, longest phrases and clause boundaries have independent meanings',()=>{
  const list=cues.analyze('我非常生气，但没有担心；这件事令人失望。').cues;
  assert.deepEqual(list.map(item=>item.word),['生气','担心','令人失望']);
  assert.equal(list[0].degree,'high');assert.equal(list[0].negated,false);
  assert.equal(list[1].label,'fearful');assert.equal(list[1].negated,true);
  assert.equal(list[2].label,'sad');assert.equal(list[2].negated,false);
  assert.equal(cues.analyze('无比开心').cues[0].degree,'high');
  assert.equal(cues.analyze('不太开心').cues[0].degree,'low');
  assert.equal(cues.analyze('不但开心，还很兴奋').cues[0].negated,false);
  assert.equal(cues.analyze('开心果很好吃').cues.length,0);
});
test('UTF16 ranges and tokens round-trip punctuation, emoji and literal markup safely',()=>{
  const text='😀我不开心，但很平静。<script>不执行</script>';
  const result=cues.tokensFor(text);
  assert.equal(result.tokens.map(item=>item.text).join(''),text);
  assert.equal(result.cues[0].start,3);
  result.cues.forEach(item=>assert.equal(text.slice(item.start,item.end),item.text));
  assert.equal(result.tokens.find(item=>item.text.includes('<script>')).highlight,false);
  assert.equal(cues.tokensFor('').tokens.length,0);
  assert.equal(cues.analyze(null).text,'');
});
test('input and cue caps bound repetitive work without splitting an emoji surrogate pair',()=>{
  const long='字'.repeat(4095)+'😀开心';
  const limited=cues.analyze(long);
  assert.equal(limited.text.length,4095);assert.equal(limited.truncated,true);
  const repeated=cues.tokensFor('开心'.repeat(10000));
  assert.equal(repeated.cues.length,64);assert.equal(repeated.text.length,4096);
  assert.equal(repeated.tokens.map(item=>item.text).join(''),repeated.text);
  assert.equal(repeated.truncated,true);
});
test('browser UMD and CommonJS yield the same bounded lexical interface',()=>{
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../utils/emotion-cues.js'),'utf8'),context);
  assert.ok(context.EmotionCues);
  assert.equal(JSON.stringify(context.EmotionCues.analyze('不是不开心，但非常生气。')),JSON.stringify(cues.analyze('不是不开心，但非常生气。')));
  const value=cues.analyze('我开心');
  assert.equal(value.source,'text_rules');assert.equal(value.cues[0].polarity,'affirmed');
  assert.equal(value.acousticLabel,undefined);
});
