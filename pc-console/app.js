(function () {
  'use strict';
  const V=window.VoiceConsole, P=window.VoiceProtocol, C=window.EmotionCues;
  const $=id=>document.getElementById(id);
  const text=(node,value)=>{const content=String(value==null?'':value);if(node.textContent!==content)node.textContent=content;};
  const make=(tag,className,content)=>{const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;};
  if(!V||!P){$('error-banner').hidden=false;text($('error-banner'),'界面资源未加载完整，请刷新此页或重启独立控制台进程。');return;}
  const stateNames={offline:'开发板离线',idle:'按住 BOOT，开始说话',recording:'正在听你说话',processing:'正在整理最后一句',error:'本次录音需要重试'};
  const connectionNames={connecting:'正在连接 ASR',connected:'实时同步已连接',reconnecting:'正在恢复连接',paused:'页面已暂停',rejected:'服务拒绝连接',disconnected:'已暂停同步'};
  const healthEmotion={ready:'已就绪 · 独立进程',loading:'模型准备中',disabled:'已关闭',error:'模型暂不可用',unavailable:'ASR 服务未连接'};
  const fields={font_scale:'font-scale',display_mode:'display-mode',page_ms:'page-ms',scroll_speed:'scroll-speed',brightness:'brightness',animation:'animation'};
  const groups=new Map(),sentences=new Map(),statsNodes=new Map();
  let model=new V.Model(''),info=null,link=null,renderTimer=null,healthTimer=null,settingsTimer=null,correctionTimer=null,displayTimer=null,toastTimer=null;
  let healthRequest=null,destroyed=false,syncPaused=false,bootstrapping=false,apiEpoch=0,currentAddress='',lastStats='',lastAnnounced='',health=null;
  const requests=new Set();

  function renderSoon(){if(destroyed||document.hidden||renderTimer!==null)return;renderTimer=setTimeout(()=>{renderTimer=null;render();},80);}
  function toast(message){text($('toast'),message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},2400);}
  function error(message){model.error=message;renderSoon();}
  async function request(path,allowError){
    const controller=new AbortController();requests.add(controller);
    const timer=setTimeout(()=>controller.abort(),6000);
    try{
      const response=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      const body=await response.json();
      if(!response.ok&&!allowError)throw new Error(response.status===403?'请在运行服务的电脑上，通过本机地址打开控制台。':'本地控制台暂未准备好，请检查独立控制台进程。');
      return body;
    }finally{clearTimeout(timer);requests.delete(controller);}
  }
  function clearPendingTimer(){clearTimeout(settingsTimer);settingsTimer=null;}
  function clearHistoryTimers(){clearTimeout(correctionTimer);clearTimeout(displayTimer);correctionTimer=displayTimer=null;}
  function requestId(prefix){return prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9);}
  async function bootstrap(){
    if(syncPaused)return;
    const epoch=++apiEpoch;
    bootstrapping=true;renderSoon();
    model.disconnected();clearPendingTimer();clearHistoryTimers();
    model.error='';text($('connection-label'),'读取本机配置…');
    try{
      const next=V.consoleInfo(await request('/api/console'));
      if(destroyed||document.hidden||syncPaused||epoch!==apiEpoch)return;
      if(!info||info.device_id!==next.device_id){model=new V.Model(next.device_id);groups.clear();sentences.clear();$('history-list').replaceChildren();}
      info=next;currentAddress=info.advertise;updatePairing();
      if(link)link.destroy();
      link=new V.SocketLink({onState:(name,delay)=>{
        model.connection=name;
        if(name!=='connected'){model.disconnected();clearPendingTimer();clearHistoryTimers();}
        if(name==='rejected')model.error='服务拒绝了连接，请检查本地配对配置与客户端版本后重新连接。';
        if(name==='reconnecting')$('connection-label').title='约 '+Math.ceil(delay/1000)+' 秒后重试；请检查 ASR 服务是否仍在运行。';
        else $('connection-label').removeAttribute('title');
        renderSoon();
      },onMessage:message=>{
        const pending=model.pending,correction=model.correctionPending,display=model.displayPending;
        if(model.receive(message))renderSoon();
        if(pending&&!model.pending)clearPendingTimer();
        if(correction&&!model.correctionPending){clearTimeout(correctionTimer);correctionTimer=null;}
        if(display&&!model.displayPending){clearTimeout(displayTimer);displayTimer=null;}
        if(message.type==='recording_done')announce('本次录音识别完成，共 '+(Number.isInteger(message.segments)?message.segments:0)+' 个分句。');
      }});
      link.start(P.socketURL(info));
      renderSoon();pollHealth();
    }catch(exc){
      if(destroyed||document.hidden||syncPaused||epoch!==apiEpoch)return;
      model.connection='disconnected';model.disconnected();
      error(exc.name==='AbortError'?'读取本地控制台超时，请检查独立控制台进程。':exc.message||'无法读取本地控制台。');
    }finally{if(epoch===apiEpoch){bootstrapping=false;renderSoon();}}
  }
  async function pollHealth(){
    if(destroyed||document.hidden||(healthRequest&&healthRequest.epoch===apiEpoch))return;
    const ticket={epoch:apiEpoch};healthRequest=ticket;
    clearTimeout(healthTimer);healthTimer=null;const epoch=ticket.epoch;
    try{const result=await request('/api/health',true);if(!destroyed&&!document.hidden&&epoch===apiEpoch){health=result;renderSoon();}}
    catch(_){if(!destroyed&&!document.hidden&&epoch===apiEpoch){health={ready:false,emotion:'unavailable',error:'无法连接 ASR 服务，请检查 8765 端口的进程。'};renderSoon();}}
    finally{if(healthRequest===ticket){healthRequest=null;if(!destroyed&&!document.hidden&&epoch===apiEpoch)healthTimer=setTimeout(pollHealth,10000);}}
  }
  function announce(message){if(lastAnnounced!==message){text($('announcement'),message);lastAnnounced=message;}}
  function qualityHint(quality){
    if(!quality)return '';
    if(quality.clipping_ratio>0.01)return '声音可能过载';
    if(['below_feature_window','short_context'].includes(quality.reason))return '片段较短，情绪仅供参考';
    if(quality.reason==='truncated')return '长句仅分析部分音频';
    if(quality.reason==='no_audio')return '没有可分析的音频';
    if(quality.reason==='no_signal')return '片段几乎无声，未运行情绪推理';
    return '';
  }
  function qualityLines(quality){
    if(!quality)return [];
    const values=[];
    if(Number.isFinite(quality.duration_ms))values.push('送入片段 '+(quality.duration_ms/1000).toFixed(2)+' 秒');
    if(Number.isFinite(quality.analyzed_ms))values.push('实际分析 '+(quality.analyzed_ms/1000).toFixed(2)+' 秒');
    if(Number.isFinite(quality.rms_dbfs))values.push('RMS '+quality.rms_dbfs.toFixed(1)+' dBFS');
    if(Number.isFinite(quality.peak))values.push('峰值 '+quality.peak.toFixed(3));
    if(Number.isFinite(quality.clipping_ratio))values.push('削波占比 '+(quality.clipping_ratio*100).toFixed(2)+'%');
    return values;
  }
  function sentenceNode(segment){
    let node=sentences.get(segment.key);
    if(!node){
      const root=make('article','sentence'),body=make('p','sentence-text'),meta=make('div','sentence-meta');
      const time=make('span'),acoustic=make('span','acoustic-tag'),partial=make('span','partial-tag'),event=make('span'),quality=make('span');
      meta.append(time,acoustic,partial,event,quality);
      const badge=make('span','correction-badge','已校对');meta.append(badge);
      const details=make('details','emotion-details'),summary=make('summary'),detailBody=make('div','details-body');details.append(summary,detailBody);
      const original=make('details','original-reference'),originalTitle=make('summary','','查看原始识别'),originalText=make('p'),copyOriginal=make('button','button text-button','复制原始识别');copyOriginal.type='button';copyOriginal.dataset.action='copy-original';copyOriginal.dataset.key=segment.key;original.append(originalTitle,originalText,copyOriginal);
      const actions=make('div','history-actions'),edit=make('button','button secondary','校对文字'),pushCorrected=make('button','button secondary','推送校对后'),pushOriginal=make('button','button text-button','推送原始识别');
      [edit,pushCorrected,pushOriginal].forEach(button=>{button.type='button';button.dataset.key=segment.key;});edit.dataset.action='edit';pushCorrected.dataset.action='display';pushCorrected.dataset.source='corrected';pushOriginal.dataset.action='display';pushOriginal.dataset.source='original';actions.append(edit,pushCorrected,pushOriginal);
      const notice=make('p','history-notice');notice.setAttribute('role','status');root.append(body,meta,details,original,actions,notice);
      node={root,body,time,acoustic,partial,event,quality,badge,details,summary,detailBody,original,originalText,edit,pushCorrected,pushOriginal,notice,text:null,cues:[]};sentences.set(segment.key,node);
    }
    node.edit.disabled=!segment.final||Boolean(model.correctionPending);
    node.pushCorrected.disabled=!segment.final||!model.canDisplay()||segment.corrected_text===null;
    node.pushOriginal.disabled=!segment.final||!model.canDisplay();
    const notice=model.historyKey===segment.key?model.historyMessage:'';
    text(node.notice,notice);node.notice.hidden=!notice;
    if(node.segment===segment)return node.root;
    node.root.classList.toggle('partial',!segment.final);
    const shown=P.displayText(segment);
    if(node.text!==shown){
      const analysis=C&&typeof C.analyze==='function'?C.analyze(shown):{cues:[]};
      node.cues=(analysis.cues||[]).slice(0,16);node.cueCount=(analysis.cues||[]).length;
      const fragment=document.createDocumentFragment();
      V.cueParts(shown,node.cues).forEach(part=>{
        if(!part.cue)fragment.append(document.createTextNode(part.text));
        else{const mark=make('mark',part.cue.negated?'negated':'',part.text);mark.dataset.emotion=P.EMOTIONS[part.cue.label]?part.cue.label:'unknown';mark.title=part.cue.reason||'文本词语线索';fragment.append(mark);}
      });
      node.body.replaceChildren(fragment);node.text=shown;
    }
    node.badge.hidden=segment.corrected_text===null;text(node.originalText,segment.text);node.original.hidden=!segment.final;
    const emotion=segment.emotion,label=emotion&&emotion.status==='ready'?P.emotionText(emotion):emotion?P.emotionText(emotion):'';
    text(node.time,(segment.start_ms/1000).toFixed(1)+'s');
    text(node.partial,segment.final?'':'实时字幕 · 待确认');node.partial.hidden=segment.final;
    text(node.acoustic,emotion&&emotion.status==='ready'?'声学 · '+label:label);node.acoustic.hidden=!label;
    text(node.event,emotion&&emotion.event&&emotion.event!=='unknown'?'声音事件 · '+emotion.event:'');
    const hint=qualityHint(emotion&&emotion.audio_quality);text(node.quality,hint);node.quality.hidden=!hint;
    text(node.summary,'情绪详情'+(node.cues.length?' · '+node.cueCount+' 处文本线索':''));
    const detail=document.createDocumentFragment();
    detail.append(make('p','',emotion&&emotion.status==='ready'?'整句声学标签：'+label+'。来自本地 SenseVoice，未提供词级标签或置信度。':'声学标签尚未返回、未识别或分析已跳过。'));
    detail.append(make('p','',segment.corrected_text===null?'文本线索基于原始识别；声学标签属于原录音。':'文本线索基于已保存的校对版；声学标签仍属于原录音，不因文字校对改变。'));
    if(node.cues.length){
      detail.append(make('p','','文本线索来自词语规则，与整句声学标签独立；否定和程度只描述语境。'));
      const list=make('ul');
      node.cues.forEach(cue=>list.append(make('li','','“'+cue.text+'”：'+(cue.labelText||P.EMOTIONS[cue.label]||'情绪')+'线索；'+(cue.reason||'规则匹配'))));detail.append(list);
      if(node.cueCount>16)detail.append(make('p','','为保持界面流畅，仅展示前 16 处高亮线索。'));
    }else detail.append(make('p','','当前句子没有命中文本情绪词规则；不据此判断真实感受。'));
    const qualityValues=qualityLines(emotion&&emotion.audio_quality);
    if(qualityValues.length)detail.append(make('p','','音频测量（情绪进程）：'+qualityValues.join(' · ')+'。这些数值不是情绪置信度。'));
    if(emotion&&Array.isArray(emotion.candidates)&&emotion.candidates.length){
      const candidates=emotion.candidates.map(candidate=>(P.EMOTIONS[candidate.label]||candidate.label)+' '+candidate.score.toFixed(3)).join('、');
      detail.append(make('p','','参考候选：'+candidates+'。这是模型未校准的原始分数，仅供参考；不替换主标签，也不计入情绪分布。'));
    }
    node.detailBody.replaceChildren(detail);node.segment=segment;
    return node.root;
  }
  function renderHistory(){
    const views=model.groups(),aliveGroups=new Set(),aliveSentences=new Set(),container=$('history-list');
    views.forEach((group,index)=>{
      aliveGroups.add(group.id);let node=groups.get(group.id);
      if(!node){
        const root=make('section','history-card'),heading=make('div','history-card-heading'),label=make('span','recording-label'),dot=make('i'),name=make('span'),copy=make('button','copy-record','复制文字'),body=make('div');
        label.append(dot,name);copy.type='button';copy.dataset.recording=group.id;heading.append(label,copy);root.append(heading,body);node={root,name,copy,body};groups.set(group.id,node);
      }
      node.root.classList.toggle('active',group.active);text(node.name,(group.active?'本次录音':'录音')+' · '+group.shortId);node.copy.disabled=!group.hasText;
      group.segments.forEach((segment,n)=>{aliveSentences.add(segment.key);const child=sentenceNode(segment);if(node.body.children[n]!==child)node.body.insertBefore(child,node.body.children[n]||null);});
      while(node.body.children.length>group.segments.length)node.body.lastElementChild.remove();
      if(container.children[index]!==node.root)container.insertBefore(node.root,container.children[index]||null);
    });
    groups.forEach((node,key)=>{if(!aliveGroups.has(key)){node.root.remove();groups.delete(key);}});
    sentences.forEach((node,key)=>{if(!aliveSentences.has(key)){node.root.remove();sentences.delete(key);}});
    $('history-empty').hidden=views.length>0;
    $('history-capability-note').hidden=!views.length||model.connection!=='connected'||model.state.state==='offline'||model.state.capabilities.includes('history_display');
    text($('history-count'),views.length?views.length+' 段录音 · '+model.state.segments.length+' 个分句':'等待第一句声音');
  }
  function renderStats(){
    const stats=V.emotionStats(model.state),signature=stats.items.map(item=>item.count).join(',');
    if(signature===lastStats)return;lastStats=signature;
    text($('emotion-summary'),stats.total?'当前缓存中 '+stats.total+' 个分句已返回模型情绪标签。':'等待本地模型返回情绪标签；未识别、跳过和失败不计入分布。');
    stats.items.forEach(item=>{
      let row=statsNodes.get(item.label);
      if(!row){const root=make('div','emotion-row'),label=make('span','',item.text),track=make('span','emotion-bar'),fill=make('i'),count=make('output');track.append(fill);root.append(label,track,count);$('emotion-distribution').append(root);row={root,fill,count};statsNodes.set(item.label,row);}
      row.root.hidden=item.count===0;row.fill.style.width=(item.share*100).toFixed(1)+'%';text(row.count,item.count);row.root.setAttribute('aria-label',item.text+' '+item.count+' 句，占 '+(item.share*100).toFixed(1)+'%');
    });
  }
  function render(){
    if(destroyed||document.hidden)return;
    $('error-banner').hidden=!model.error;text($('error-banner'),model.error);
    text($('connection-label'),connectionNames[model.connection]||'连接尚未就绪');$('connection-pill').classList.toggle('connected',model.connection==='connected');
    $('pause-connection').disabled=syncPaused||(!bootstrapping&&(!link||!link.enabled));
    let state=model.connection==='connected'?model.state.state:'offline';
    text($('live-state-label'),model.connection==='disconnected'?'同步已暂停':stateNames[state]||stateNames.offline);$('live-state').dataset.state=state;
    text($('live-description'),model.state.message||(state==='recording'?'继续按住 BOOT 说话。松开后会完成最后一句，情绪标签随后补齐。':state==='processing'?'采音已结束，正在等待最后的断句与标点。':'按住开发板 BOOT 说话，松开结束。字幕会同步出现在 OLED 和小程序。'));
    const level=state==='recording'?model.level:0,percent=Math.round(level*100);
    text($('volume-value'),percent+'%');$('volume-fill').style.transform='scaleX('+level+')';$('volume-meter').setAttribute('aria-valuenow',String(percent));
    $('companion').dataset.state=state;$('companion').style.setProperty('--voice-level',String(level));
    const latest=model.state.segments[model.state.segments.length-1],emotion=latest&&latest.emotion;
    $('companion').dataset.emotion=state==='recording'?'neutral':emotion&&emotion.status==='ready'?emotion.label:'neutral';
    const metrics=model.metrics;text($('metric-audio'),metrics&&metrics.audio_ms!==null?(metrics.audio_ms/1000).toFixed(1)+' s':'—');
    text($('metric-first'),metrics&&metrics.first_partial_ms!==null?Math.round(metrics.first_partial_ms)+' ms':'—');
    text($('metric-final'),metrics&&metrics.final_latency_ms!==null?Math.round(metrics.final_latency_ms)+' ms':'—');
    const known=model.state.settings_known,actual=model.state.settings;
    text($('applied-summary'),known?actual.font_scale+' 倍字号 · '+P.MODES[actual.display_mode]+' · 亮度 '+actual.brightness:'连接后读取开发板实际设置');
    $('settings-fields').disabled=Boolean(model.pending);$('apply-settings').disabled=model.connection!=='connected'||state==='offline'||Boolean(model.pending);text($('apply-settings'),model.pending?'等待设备确认…':'应用到 OLED');
    $('restore-settings').disabled=!known||Boolean(model.pending)||!model.dirty;text($('settings-status'),model.settingsMessage);
    Object.entries(fields).forEach(([key,id])=>{const node=$(id),value=model.draft[key];if(node.type==='checkbox')node.checked=value;else if(document.activeElement!==node&&node.value!==String(value))node.value=String(value);});
    text($('page-ms-value'),(model.draft.page_ms/1000).toFixed(1)+' 秒');text($('scroll-speed-value'),model.draft.scroll_speed+' 像素/秒');text($('brightness-value'),model.draft.brightness+' / 255');
    text($('service-device'),info?info.device_id:'—');text($('service-asr'),health?(health.ready?'Paraformer · INT8 已就绪':health.error||'模型尚未就绪'):'正在检查');
    text($('service-emotion'),health?healthEmotion[health.emotion]||'等待状态':'正在检查');
    renderHistory();renderStats();renderEditor();
  }
  function renderEditor(){
    const dialog=$('correction-dialog'),editor=model.editor;
    if(!editor){if(dialog.open){if(dialog.close)dialog.close();else dialog.removeAttribute('open');}return;}
    const segment=model.segment(editor.key);
    if(!segment){text($('correction-status'),'这句话已移出显示缓存，草稿仍保留；请复制草稿后刷新历史。');$('save-correction').disabled=true;return;}
    text($('correction-original'),segment.text);text($('correction-current'),P.displayText(segment));text($('correction-version'),'保存版本 '+segment.edit_version+(segment.corrected_at?' · '+segment.corrected_at:''));
    if($('correction-text').value!==editor.text)$('correction-text').value=editor.text;
    let invalid='';try{P.validateCorrection(editor.text);}catch(exc){invalid=exc.message;}
    text($('correction-count'),Array.from(editor.text).length+' / 512 字'+(invalid?' · '+invalid:''));
    text($('correction-status'),model.historyMessage);$('correction-rebase').hidden=!editor.conflict;
    const waiting=Boolean(model.correctionPending);
    $('correction-text').disabled=waiting;$('close-correction').disabled=waiting;
    $('save-correction').disabled=waiting||editor.conflict||Boolean(invalid)||model.connection!=='connected';text($('save-correction'),waiting?'等待保存确认…':'保存校对');
    $('restore-original').disabled=waiting||editor.conflict||segment.corrected_text===null||model.connection!=='connected';$('correction-rebase').disabled=waiting;
  }
  function saveCorrection(restore){
    if(model.correctionPending)return;
    const id=requestId('pc-edit');
    try{const message=model.correct(id,restore);link.send(message);clearTimeout(correctionTimer);correctionTimer=setTimeout(()=>{if(model.correctionPending&&model.correctionPending.id===id){model.failCorrection('保存结果未确认，草稿保留。请刷新历史后核对再保存。');renderSoon();}},12000);}
    catch(exc){if(model.correctionPending&&model.correctionPending.id===id)model.failCorrection(exc.message);else model.historyMessage=exc.message;}
    renderSoon();
  }
  function pushHistory(key,source){
    if(model.displayPending)return;
    const id=requestId('pc-display');
    try{const message=model.display(id,key,source);link.send(message);clearTimeout(displayTimer);displayTimer=setTimeout(()=>{if(model.displayPending&&model.displayPending.id===id){model.failDisplay('等待 OLED 确认超时，屏幕结果未知，请检查后重试。');renderSoon();}},12000);}
    catch(exc){if(model.displayPending&&model.displayPending.id===id)model.failDisplay(exc.message);else{model.historyKey=key;model.historyMessage=exc.message;}}
    renderSoon();
  }
  function updatePairing(){
    if(!info)return;
    const select=$('pair-address');select.replaceChildren();
    info.addresses.forEach(address=>{const option=make('option','',address);option.value=address;select.append(option);});
    select.disabled=!info.addresses.length;select.value=currentAddress;paintPairing();
  }
  function paintPairing(){
    if(!info)return;
    const available=info.addresses.includes(currentAddress),image=$('pair-qr');
    image.hidden=!available;$('pairing-hint').hidden=available;
    text($('pairing-hint'),available?'':'没有发现可供手机连接的 IPv4 地址。请连接可互通的有线或 Wi-Fi 网络。');
    $('pair-url').value=available?V.pairing(info,currentAddress).url:'';$('pair-token').value=info.token;text($('pair-device'),info.device_id);
    $('copy-pairing').disabled=!available;$('copy-address').disabled=!available;
    if(available){const src='/api/pairing/qr?address='+encodeURIComponent(currentAddress)+'&device_id='+encodeURIComponent(info.device_id);if(image.getAttribute('src')!==src)image.src=src;}
    else image.removeAttribute('src');
  }
  async function copy(value){
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText)await navigator.clipboard.writeText(value);
      else{const area=make('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw new Error();}
      toast('已复制');
    }catch(_){toast('复制未完成，请手动选择文字复制');}
  }
  $('settings-form').addEventListener('submit',event=>{
    event.preventDefault();
    // The DOM is deliberately batched. Block repeat Enter/click immediately,
    // before the next frame disables the form, without clearing the first ACK.
    if(model.pending)return;
    let id=null;
    try{
      id='pc-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9);const message=model.apply(id);
      link.send(message);clearPendingTimer();settingsTimer=setTimeout(()=>{if(model.pending&&model.pending.id===id){model.failSettings('等待设备确认超时，应用结果未知；请重连读取实际值');renderSoon();}},12000);
    }catch(exc){if(model.pending&&model.pending.id===id)model.failSettings('设置尚未确认');error(exc.message||'设置发送失败');}
    renderSoon();
  });
  Object.entries(fields).forEach(([key,id])=>$(id).addEventListener('input',event=>{
    try{model.edit({[key]:key==='animation'?event.target.checked:key==='display_mode'?event.target.value:Number(event.target.value)});renderSoon();}catch(exc){error(exc.message);}
  }));
  $('restore-settings').addEventListener('click',()=>{model.restore();renderSoon();});
  $('reconnect').addEventListener('click',()=>{syncPaused=false;clearPendingTimer();bootstrap();});
  $('pause-connection').addEventListener('click',()=>{
    syncPaused=true;bootstrapping=false;apiEpoch++;
    requests.forEach(controller=>controller.abort());
    if(link)link.destroy();model.connection='disconnected';model.disconnected();clearPendingTimer();clearHistoryTimers();pollHealth();renderSoon();
  });
  $('refresh-history').addEventListener('click',()=>{try{link.send({type:'history_get'});toast('正在同步最近记录');}catch(exc){error(exc.message);}});
  $('history-list').addEventListener('click',event=>{
    const group=event.target.closest('button[data-recording]');if(group){copy(P.recordingText(model.state,group.dataset.recording));return;}
    const button=event.target.closest('button[data-action]');if(!button)return;
    if(button.dataset.action==='display'){pushHistory(button.dataset.key,button.dataset.source);return;}
    const segment=model.segment(button.dataset.key);if(!segment)return;
    if(button.dataset.action==='copy-original'){copy(segment.text);return;}
    if(button.dataset.action==='edit'){
      try{model.openEditor(segment.key);renderEditor();const dialog=$('correction-dialog');if(!dialog.open){if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');}}
      catch(exc){toast(exc.message);}
    }
  });
  $('correction-form').addEventListener('submit',event=>{event.preventDefault();saveCorrection(false);});
  $('correction-text').addEventListener('input',event=>{model.changeCorrection(event.target.value);renderSoon();});
  $('restore-original').addEventListener('click',()=>saveCorrection(true));
  $('correction-rebase').addEventListener('click',()=>{model.rebaseCorrection();renderSoon();});
  function closeCorrection(){if(model.correctionPending)return;model.editor=null;const dialog=$('correction-dialog');if(dialog.close)dialog.close();else dialog.removeAttribute('open');renderSoon();}
  $('close-correction').addEventListener('click',closeCorrection);
  $('correction-dialog').addEventListener('cancel',event=>{if(model.correctionPending)event.preventDefault();else model.editor=null;});
  $('copy-editor-original').addEventListener('click',()=>{if(model.editor){const segment=model.segment(model.editor.key);if(segment)copy(segment.text);}});
  $('open-pairing').addEventListener('click',()=>{if(!info){toast('请先启动独立控制台服务');return;}const dialog=$('pairing-dialog');if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');});
  function closePairing(){const dialog=$('pairing-dialog');if(dialog.close)dialog.close();else dialog.removeAttribute('open');$('pair-token').type='password';text($('toggle-token'),'显示');$('toggle-token').setAttribute('aria-pressed','false');}
  $('close-pairing').addEventListener('click',closePairing);$('pairing-dialog').addEventListener('click',event=>{if(event.target===$('pairing-dialog'))closePairing();});
  $('pair-address').addEventListener('change',event=>{currentAddress=event.target.value;paintPairing();});
  $('copy-address').addEventListener('click',()=>{if(info&&currentAddress)copy(V.pairing(info,currentAddress).url);});
  $('copy-pairing').addEventListener('click',()=>{if(info&&currentAddress)copy(JSON.stringify(V.pairing(info,currentAddress)));});
  $('toggle-token').addEventListener('click',()=>{const show=$('pair-token').type==='password';$('pair-token').type=show?'text':'password';text($('toggle-token'),show?'隐藏':'显示');$('toggle-token').setAttribute('aria-pressed',String(show));});
  $('pair-qr').addEventListener('error',()=>{$('pair-qr').hidden=true;$('pairing-hint').hidden=false;text($('pairing-hint'),'二维码未加载，可复制完整配对信息到手机，或手动填写地址与口令。');});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){apiEpoch++;clearTimeout(renderTimer);renderTimer=null;clearTimeout(healthTimer);healthTimer=null;clearPendingTimer();clearHistoryTimers();requests.forEach(controller=>controller.abort());if(link)link.foreground(false);model.disconnected();}
    else{if(syncPaused)model.connection='disconnected';else if(link)link.foreground(true);else bootstrap();pollHealth();renderSoon();}
  });
  window.addEventListener('beforeunload',()=>{destroyed=true;apiEpoch++;[renderTimer,healthTimer,settingsTimer,correctionTimer,displayTimer,toastTimer].forEach(clearTimeout);requests.forEach(controller=>controller.abort());if(link)link.destroy();});
  render();bootstrap();
})();
