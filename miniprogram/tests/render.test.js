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
