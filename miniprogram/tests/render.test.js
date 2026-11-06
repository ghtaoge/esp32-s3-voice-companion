'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const p=require('../utils/protocol');
const compiler=process.env.WXML_COMPILER;
let render;
if(compiler && fs.existsSync(compiler)) {
  const cwd=path.resolve(__dirname,'..');
  const result=spawnSync(compiler,['pages/index/index.wxml'],{cwd,encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr);
  const sandbox=vm.createContext({window:{},console});
  vm.runInContext(result.stdout,sandbox);
  sandbox.registry={};vm.runInContext('$gwx(undefined,registry); template=$gwx(Object.keys(registry.entrys)[0],registry)',sandbox);
  render=data=>{sandbox.json=JSON.stringify(data);return vm.runInContext('template(JSON.parse(json))',sandbox);};
}
function find(tree,predicate){if(!tree || typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of tree.children||[]){const value=find(child,predicate);if(value)return value;}return null;}
const options={skip:render?false:'Set WXML_COMPILER to the official WeChat wcc.exe to compile and render WXML'};
const base={tab:'settings',connected:true,state:'idle',pending:false,appliedKnown:true,draftDirty:true,
  draft:p.DEFAULT_SETTINGS,applied:p.DEFAULT_SETTINGS,groups:[],showPrivacy:false,fontOptions:['1','2','3','4'],modeOptions:['翻页','滚动','逐字','静态'],modeIndex:0};
test('compiled settings action reflects connection, device and ACK states',options,()=>{
  const button=data=>find(render(data),node=>node.attr && node.attr.bindtap==='applySettings');
  assert.equal(button(base).attr.disabled,false);
  for(const patch of [{connected:false},{state:'offline'},{pending:true}])assert.equal(button(Object.assign({},base,patch)).attr.disabled,true);
  const picker=find(render(Object.assign({},base,{draft:Object.assign({},p.DEFAULT_SETTINGS,{font_scale:4})})),node=>node.attr && node.attr.bindchange==='fontChanged');
  assert.equal(picker.attr.value,3);
});
test('compiled privacy agreement uses the native authorization event',options,()=>{
  const node=find(render(Object.assign({},base,{showPrivacy:true})),value=>value.attr && value.attr.id==='voice-privacy-agree');
  assert.equal(node.attr.openType,'agreePrivacyAuthorization');
  assert.equal(node.attr.bindagreeprivacyauthorization,'agreePrivacy');
});

test('compiled transcript renders text cues as literal text and separates model/rule details',options,()=>{
  const segment={key:'r:0',text:'我不开心<script>',final:true,seconds:'0.0',emotionText:'平静',
    emotion:{label:'neutral',status:'ready',event:'speech'},detailsOpen:true,
    cueTokens:[{start:0,text:'我',highlight:false},{start:1,text:'不开心',highlight:true,negated:true},{start:4,text:'<script>',highlight:false}],
    cueCount:1,detailCues:[{start:1,text:'不开心',label:'开心',negation:'否定表达',degree:'未标注',reason:'不能直接翻成相反感受'}]};
  const tree=render(Object.assign({},base,{tab:'live',groups:[{id:'r',shortId:'r',segments:[segment],hasText:true}]}));
  assert.ok(find(tree,node=>node.attr && node.attr.bindtap==='toggleEmotionDetails'));
  assert.ok(find(tree,node=>node.attr && String(node.attr.class||'').includes('text-cue')));
  assert.ok(find(tree,node=>node.attr && node.attr.dataKey==='r:0' || node.attr && node.attr['data-key']==='r:0'));
});

test('compiled history keeps raw text available and gates push by capability and device state',options,()=>{
  const segment={key:'r:0',text:'原始文字',corrected_text:'校对文字',final:true,seconds:'0.0',cueTokens:[],originalOpen:true};
  const state=Object.assign({},base,{tab:'live',historyDisplaySupported:true,historyDisplayPending:false,groups:[{id:'r',shortId:'r',segments:[segment]}]});
  const buttons=data=>{
    const tree=render(data),list=[];
    function walk(node){if(!node||typeof node!=='object')return;if(node.attr&&node.attr.bindtap==='displayHistory')list.push(node);(node.children||[]).forEach(walk);}
    walk(tree);return list;
  };
  assert.equal(buttons(state).length,2);assert.ok(buttons(state).every(node=>node.attr.disabled===false));
  assert.ok(JSON.stringify(render(state)).includes('校对文字'));assert.ok(JSON.stringify(render(state)).includes('原始文字'));
  for(const patch of [{historyDisplaySupported:false},{historyDisplayPending:true},{state:'recording'},{state:'processing'},{connected:false}])
    assert.ok(buttons(Object.assign({},state,patch)).every(node=>node.attr.disabled===true));
  const partial=Object.assign({},state,{groups:[{id:'r',segments:[Object.assign({},segment,{final:false})]}]});
  assert.equal(buttons(partial).length,0);
});

test('compiled correction editor exposes separate save, restore and conflict reload actions',options,()=>{
  const tree=render(Object.assign({},base,{historyEditor:{draft:'我的草稿',counts:{characters:4,bytes:12},saving:false,hasCorrection:true,conflict:true}}));
  const textarea=find(tree,node=>node.attr && node.attr.bindinput==='inputCorrection');
  assert.equal(textarea.attr.value,'我的草稿');
  const save=find(tree,node=>node.attr && node.attr.bindtap==='saveCorrection');
  assert.equal(save.attr.disabled,true);
  assert.ok(find(tree,node=>node.attr && node.attr.bindtap==='reloadCorrection'));
});
