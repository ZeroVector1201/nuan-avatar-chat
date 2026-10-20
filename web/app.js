import {NaturalCompanion,ContinuousActorSpeech} from './natural-companion.js';
import {Microphone} from './microphone.js';
import {Live2DCompanion} from './live2d-avatar.js';
import {PCMSpeech} from './pcm-speech.js';
const $=id=>document.getElementById(id);
const initialMode=new URLSearchParams(location.search).get('avatar')==='live2d'?'live2d':'natural';
const state={socket:null,head:null,ctx:null,turn:null,busy:false,connected:false,actor:false,epoch:0,recordPending:false,
  mode:initialMode,switching:false,headReady:false,speech:null};
// Useful for embedding and for reproducible UI tests; no personal data is persisted.
window.nuan=state;
let heartbeat,chain=Promise.resolve(),replyBubble=null,transcriptBubble=null;
const recorder=new Microphone(seconds=>{$('record-status').textContent=`正在录音 ${seconds}s · 再点发送`;});
function message(role,text='',pending=false){
  const article=document.createElement('article');article.className=`message ${role}${pending?' pending':''}`;
  const name=document.createElement('span');name.className='name';name.textContent=role==='user'?'我':'暖暖';
  const p=document.createElement('p');p.textContent=text;article.append(name,p);$('messages').append(article);scroll();
  return {article,p};
}
function scroll(){$('messages').scrollTop=$('messages').scrollHeight;}
function error(text=''){$('error').textContent=text;$('error').hidden=!text;}
function status(text){$('state-label').textContent=text;}
function controls(){
  const available=state.connected&&state.actor&&!state.switching;
  $('send').disabled=!available||state.busy||state.recordPending||recorder.recording;
  $('mic').disabled=!available||state.busy||state.recordPending;
  $('mic').textContent=recorder.recording?'■ 发送这段语音':'♩ 开始说话';
  $('interrupt').disabled=!state.busy;
  $('mic-device').disabled=recorder.recording||state.recordPending;
  $('avatar-mode').disabled=state.switching;
  $('reconnect').hidden=state.connected&&state.actor;
  $('connection').textContent=state.connected&&state.actor?'● 已连接':state.connected?'人物正在连接…':'连接已断开';
}
function send(data){
  if(state.socket?.readyState!==WebSocket.OPEN)throw Error('连接已断开，请重新连接。');
  state.socket.send(JSON.stringify(data));
}
function stopSpeech(){
  state.speech?.stop();state.speech=null;state.head?.stopSpeaking();state.turn=null;state.busy=false;$('caption').hidden=true;
  if(replyBubble?.article.classList.contains('pending')){
    replyBubble.p.textContent='回复已暂停';replyBubble.article.classList.remove('pending');replyBubble.article.classList.add('cancelled');
  }
  controls();
}
async function begin(kind,value){
  if(state.busy||!state.actor||!state.connected)return;
  await state.ctx.resume();
  error();state.busy=true;state.turn=crypto.randomUUID();
  transcriptBubble=message('user',kind==='text'?value:'正在识别语音…',kind==='audio');
  replyBubble=message('assistant','暖暖正在想…',true);state.reply='';
  controls();status('暖暖正在想…');
  send({type:kind,turn_id:state.turn,[kind]:value});
}
async function event(d,epoch){
  if(epoch!==state.epoch)return;
  if(d.type==='hello'){send({type:'avatar_select',avatar:state.mode});return;}
  if(d.type==='avatar_selected'){
    if(d.avatar===state.mode&&d.avatar==='live2d'&&state.headReady){
      state.actor=true;$('avatar-loading').hidden=true;controls();
    }
    return;
  }
  if(d.type==='actor_error'){
    if(state.mode!=='natural'||state.switching)return;
    state.actor=false;stopSpeech();state.head?.disconnectActor();$('avatar-loading').hidden=true;error(d.message);controls();return;
  }
  if(d.type==='actor_stream_start'||d.type==='actor_stream_chunk'||d.type==='actor_cue_start'||d.type==='actor_cue_end'){
    if(state.mode!=='natural'||state.switching||!state.headReady)return;
    await state.head.actorEvent(d);
    if(d.type==='actor_stream_start'){state.actor=true;controls();}
    return;
  }
  if(d.turn_id&&d.turn_id!==state.turn)return;
  if(d.type==='status')status(d.label);
  if(d.type==='transcript'){
    transcriptBubble.p.textContent=d.text||'没有识别到清楚的语音';
    transcriptBubble.article.classList.remove('pending');scroll();
  }
  if(d.type==='text')state.reply=d.text; // Kept off-screen until the speech actually starts.
  if(d.type==='actor_speech_start'||d.type==='audio_start'){
    if((d.type==='audio_start')!==(state.mode==='live2d'))return;
    const turn=state.turn;
    const Speech=state.mode==='live2d'?PCMSpeech:ContinuousActorSpeech;
    const speech=state.speech=new Speech(state.head,d,{
      start:()=>{if(state.turn===turn)status('暖暖正在说…');},
      caption:text=>{
        if(state.turn!==turn)return;
        replyBubble.p.textContent=text;replyBubble.article.classList.remove('pending');
        $('caption').textContent=text;$('caption').hidden=false;scroll();
      },
      audible:()=>{},
      end:()=>{if(state.turn!==turn)return;state.busy=false;state.turn=null;state.speech=null;$('caption').hidden=true;status('慢慢说，我在听。');controls();},
      error:e=>{if(state.turn===turn){stopSpeech();error(e.message);}}
    });
    await speech.init();
  }
  if(d.type==='audio_chunk')state.speech?.push(d);
  if(d.type==='audio_end')state.speech?.end(d);
  // done means server synthesis has ended, not that the child heard the last word.
  // Cancel/reset is applied immediately by the originating UI. A late server
  // acknowledgement must never stop the new turn started in the meantime.
  if(d.type==='error'){
    if(state.reply&&replyBubble){replyBubble.p.textContent=state.reply;replyBubble.article.classList.remove('pending');}
    stopSpeech();error(d.message);status('可以重试，或重新连接。');
  }
}
function disconnect(){
  state.epoch++;clearInterval(heartbeat);recorder.cancel();state.recordPending=false;
  state.socket?.close();state.socket=null;state.connected=false;state.actor=false;
  stopSpeech();state.head?.disconnectActor?.();$('record-status').textContent='';controls();
}
function connect(){
  disconnect();const epoch=state.epoch;chain=Promise.resolve();error();
  $('connection').textContent='正在连接…';$('avatar-loading').hidden=false;
  const socket=state.socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);
  socket.onopen=()=>{if(epoch!==state.epoch)return;state.connected=true;controls();heartbeat=setInterval(()=>send({type:'ping'}),20000);};
  socket.onmessage=({data})=>{chain=chain.then(()=>event(JSON.parse(data),epoch)).catch(()=>{
    if(epoch!==state.epoch)return;disconnect();error('播放连接发生中断，请重新连接。');
  });};
  socket.onclose=socket.onerror=()=>{if(epoch!==state.epoch)return;disconnect();$('avatar-loading').hidden=true;error('连接已断开，点击重新连接可开始新的聊天。');};
}
async function devices(){
  const selected=$('mic-device').value,all=await navigator.mediaDevices?.enumerateDevices();
  const select=$('mic-device');select.replaceChildren(new Option('系统默认麦克风','default'));
  for(const d of all||[])if(d.kind==='audioinput'){
    if(d.deviceId==='default'){select.options[0].textContent=d.label||'系统默认麦克风';continue;}
    if(d.deviceId&&d.label)select.add(new Option(d.label,d.deviceId));
  }
  if([...select.options].some(x=>x.value===selected))select.value=selected;
}
$('message-form').onsubmit=async e=>{
  e.preventDefault();const value=$('text-input').value.trim();
  if(!value||$('send').disabled)return;
  try{await begin('text',value);$('text-input').value='';}catch(e){stopSpeech();error(e.message);}
};
$('text-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('message-form').requestSubmit();}};
async function finishRecording(){
  if(!recorder.recording)return;
  state.recordPending=true;controls();
  try{const audio=await recorder.finish();state.recordPending=false;await begin('audio',audio);}
  catch(e){error(e.message);}
  finally{state.recordPending=false;$('record-status').textContent='';controls();}
}
$('mic').onclick=async()=>{
  if(recorder.recording){await finishRecording();return;}
  const epoch=state.epoch;state.recordPending=true;controls();error();
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw Error('请在 HTTPS 或 localhost 中开启麦克风。');
    await state.ctx.resume();
    const started=await recorder.start($('mic-device').value,finishRecording);
    if(epoch!==state.epoch){recorder.cancel();return;}
    if(started){status('正在听你说…');await devices();}
  }catch(e){if(epoch===state.epoch)error(e.name==='NotAllowedError'?'请允许浏览器使用麦克风，也可以输入文字。':e.message);}
  finally{if(epoch===state.epoch){state.recordPending=false;controls();}}
};
$('interrupt').onclick=()=>{send({type:'cancel'});stopSpeech();status('已暂停，我在听。');};
$('reset').onclick=()=>{
  recorder.cancel();state.recordPending=false;$('record-status').textContent='';
  if(state.connected)send({type:'reset'});
  stopSpeech();$('messages').replaceChildren();welcome();error();status('新的一次聊天，从这里开始。');
};
$('reconnect').onclick=async()=>{
  if(!state.headReady){await switchAvatar(state.mode);return;}
  connect();$('messages').replaceChildren();welcome();
};
function welcome(){message('assistant','你好呀，我是暖暖。很高兴见到你，今天想和我聊些什么？');}
window.addEventListener('pagehide',()=>{disconnect();state.head?.dispose();state.ctx?.close();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){recorder.cancel();state.recordPending=false;$('record-status').textContent='';controls();}});
async function loadAvatar(mode){
  state.headReady=false;state.head?.dispose();$('avatar').replaceChildren();
  document.querySelector('.stage').dataset.avatar=mode;
  $('live2d-credit').hidden=mode!=='live2d';
  state.head=mode==='live2d'?new Live2DCompanion($('avatar'),state.ctx):new NaturalCompanion($('avatar'),state.ctx);
  state.head.onActorError=message=>{state.actor=false;stopSpeech();error(message);controls();};
  await state.head.load();state.head.start();state.headReady=true;
}
async function switchAvatar(mode){
  if(state.switching)return;
  state.switching=true;state.actor=false;state.mode=mode;
  recorder.cancel();state.recordPending=false;$('record-status').textContent='';
  stopSpeech();error();$('avatar-loading').hidden=false;controls();
  try{
    if(state.connected)send({type:'cancel'});
    await loadAvatar(mode);
    const url=new URL(location.href);url.searchParams.set('avatar',mode);history.replaceState(null,'',url);
    if(state.connected)send({type:'avatar_select',avatar:mode});
    else connect();
    status('慢慢说，我在听。');
  }catch(e){
    state.head?.dispose();state.head=null;state.headReady=false;$('avatar-loading').hidden=true;
    error('形象加载失败：'+e.message);
  }finally{state.switching=false;controls();}
}
$('avatar-mode').value=state.mode;
$('avatar-mode').onchange=()=>switchAvatar($('avatar-mode').value);
async function main(){
  welcome();state.ctx=new AudioContext();
  await switchAvatar(state.mode);devices().catch(()=>{});
  const timer=setInterval(()=>{
    if(state.mode==='natural'&&state.head?.actorMetrics?.starts)$('avatar-loading').hidden=true;
  },200);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}
main().catch(e=>{$('avatar-loading').hidden=true;error(e.message);controls();});
