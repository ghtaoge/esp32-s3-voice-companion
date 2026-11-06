(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmotionCues = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
'use strict';

// Text cues are lexical explanations, never replacements for acoustic labels.
const MAX_TEXT = 4096, MAX_CUES = 64, PREFIX_UNITS = 12;
const LABELS = Object.freeze({ happy:'开心', sad:'低落', angry:'生气', fearful:'担忧或害怕',
  disgusted:'厌恶', surprised:'惊讶', neutral:'平静' });
const DEGREES = Object.freeze({low:'较弱', normal:'未标注', high:'较强'});
const NEGATIONS = Object.freeze({none:'未见局部否定', negated:'否定表达', double_negated:'双重否定表达'});
const WORDS = {
  happy:['开心','高兴','快乐','愉快','兴奋','激动','喜悦','欣喜','满意','幸福','欣慰','感动','舒心','雀跃','喜欢','喜爱','期待','振奋'],
  sad:['令人失望','伤心','难过','难受','低落','失落','失望','沮丧','委屈','悲伤','悲痛','痛苦','心酸','遗憾','郁闷','孤独','寂寞','不舍'],
  angry:['火冒三丈','生气','愤怒','恼火','气愤','火大','烦躁','愤慨','暴躁','气死','气坏'],
  fearful:['担心','担忧','忧虑','害怕','恐惧','紧张','焦虑','不安','忐忑','慌张','惊恐','心慌','畏惧'],
  disgusted:['讨厌','厌恶','反感','恶心','嫌弃','厌烦'],
  surprised:['不可思议','惊讶','吃惊','震惊','意外','惊喜','诧异'],
  neutral:['平静','冷静','淡定','安心','放松','平和','从容','踏实']
};
const trie = Object.create(null);
Object.keys(WORDS).forEach(label => WORDS[label].forEach(word => {
  let node = trie;
  for (let n=0;n<word.length;n++) node = node[word[n]] || (node[word[n]] = Object.create(null));
  node.word = word; node.label = label;
}));
const modifiers = [];
function addModifiers(words, data) { words.forEach(text => modifiers.push(Object.assign({text},data))); }
addModifiers(['并不是不','不可能不','不是没有','并非不','不是不','不能不','不得不','没有不'], {negations:2});
addModifiers(['一点儿也没有','一点儿都没有','一点也没有','一点都没有','一点儿也不','一点儿都不','一点也不','一点都不','根本没有','根本不','毫无','从不','毫不','绝不'], {negations:1,strong:true});
addModifiers(['并不觉得','并不认为','没有感到','不觉得','不认为','没觉得','没感到','不感到','并没有','并不是','不再','不是','并不','并非','没有','不怎么','不太','不','没','未','无'], {negations:1});
addModifiers(['非常','特别','十分','极其','超级','格外','无比','很','太'], {degree:'high'});
addModifiers(['有点儿','有一点','一点点','稍微','稍稍','略微','有点','有些','一点','比较'], {degree:'low'});
modifiers.sort((a,b) => b.text.length-a.text.length);

function boundedText(value) {
  if (typeof value !== 'string') return '';
  let end = Math.min(value.length,MAX_TEXT);
  const last = value.charCodeAt(end-1);
  if (end < value.length && last >= 0xD800 && last <= 0xDBFF) end--;
  return value.slice(0,end);
}
function longest(text,start) {
  let node=trie, found=null;
  for(let n=start;n<text.length;n++) {
    node=node[text[n]];
    if(!node)break;
    if(node.word)found={word:node.word,label:node.label,end:n+1};
  }
  return found;
}
function prefix(text,start,floor) {
  const earliest=Math.max(floor,start-PREFIX_UNITS);
  let cursor=start, count=0, degree='normal', strong=false;
  const seen=[];
  for(let step=0;step<4;step++) {
    let at=cursor;
    while(at>earliest && (text[at-1]===' ' || text[at-1]==='\t'))at--;
    let found=null;
    for(let n=0;n<modifiers.length;n++) {
      const item=modifiers[n], begin=at-item.text.length;
      if(begin>=earliest && text.slice(begin,at)===item.text){found=item;break;}
    }
    if(!found)break;
    cursor=at-found.text.length;
    count+=found.negations||0; strong=strong||Boolean(found.strong);
    if(found.degree && degree==='normal')degree=found.degree;
    if(found.text==='不太' || found.text==='不怎么')degree='low';
    seen.unshift(found.text);
  }
  return {start:cursor,count,degree,strong,words:seen};
}
function analyze(value) {
  const text=boundedText(value),cues=[];
  let cursor=0, floor=0;
  while(cursor<text.length && cues.length<MAX_CUES) {
    // A frequent lexical homograph: this is a nut, not an emotion expression.
    if(text.slice(cursor,cursor+3)==='开心果'){cursor+=3;continue;}
    const found=longest(text,cursor);
    if(!found){cursor++;continue;}
    const context=prefix(text,cursor,floor);
    const negated=context.count%2===1;
    const negation=!context.count?'none':negated?'negated':'double_negated';
    let reason='出现“'+found.word+'”这一文字线索';
    if(negation==='negated')reason+='；'+(context.strong?'强调否定':'存在否定')+'，不能直接翻成相反感受';
    else if(negation==='double_negated')reason+='；存在双重否定，不能仅凭这句话断定真实感受';
    if(context.degree!=='normal')reason+='；程度词标注为'+DEGREES[context.degree]+(negated?'（位于否定表达内）':'');
    cues.push({start:context.start,end:found.end,text:text.slice(context.start,found.end),
      word:found.word,label:found.label,labelText:LABELS[found.label],negated,negation,
      polarity:negation==='none'?'affirmed':negation,degree:context.degree,
      negationStrong:context.strong,reason});
    cursor=found.end;floor=cursor;
  }
  return {text,cues,truncated:typeof value==='string' && value.length>text.length || cursor<text.length && cues.length===MAX_CUES,source:'text_rules'};
}
function tokensFor(value) {
  const result=analyze(value),tokens=[];
  let cursor=0;
  result.cues.forEach(cue => {
    if(cue.start>cursor)tokens.push({text:result.text.slice(cursor,cue.start),start:cursor,end:cue.start,highlight:false});
    tokens.push(Object.assign({highlight:true},cue));cursor=cue.end;
  });
  if(cursor<result.text.length)tokens.push({text:result.text.slice(cursor),start:cursor,end:result.text.length,highlight:false});
  return Object.assign({},result,{tokens});
}
return {analyze,tokensFor,MAX_TEXT,MAX_CUES,LABELS,DEGREES,NEGATIONS};
});
