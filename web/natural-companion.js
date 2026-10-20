// A single video carries image and sound on the browser's native media clock.
// No separate mouth sprites or synthesized idle head rotation.
import {FragmentedPlayer} from './natural-media.js?v=pause-prepare-20261009';
export class NaturalCompanion{
  constructor(element,audioCtx){this.element=element;this.audioCtx=audioCtx;this.isHuman=true;this.isNatural=true;this.animQueue=[];this.animClock=0;this.stateName='idle';this.audioAnalyzerNode=audioCtx.createAnalyser();this.audioGainNode=audioCtx.createGain();this.audioAnalyzerNode.connect(this.audioGainNode);this.audioGainNode.connect(audioCtx.destination);this.image=new Image();this.image.className='human-portrait';this.video=document.createElement('video');this.video.className='human-portrait';this.video.playsInline=true;this.video.preload='auto';this.video.style.display='none';this.idle=document.createElement('video');this.idle.className='human-portrait';this.idle.playsInline=true;this.idle.muted=true;this.idle.loop=true;this.idle.style.display='none';this.idle.onerror=()=>{this.idle.style.display='none';};this.idle.onplaying=()=>{if(!this.isSpeaking)this.idle.style.display='block';};this.video.style.transition='opacity 180ms ease';this.element.append(this.image,this.idle,this.video);const label=document.createElement('span');label.className='human-disclosure';label.textContent='暖暖 · AI 数字人';element.append(label);this.source=audioCtx.createMediaElementSource(this.video);this.source.connect(this.audioAnalyzerNode);}
  async load(){this.variant='lite';try{this.portraitId=localStorage.getItem('nuan-natural-portrait')||'nuannuan';}catch{this.portraitId='nuannuan';}const r=await fetch('/api/natural/portraits');if(!r.ok)throw Error('自然人物服务未就绪');const data=await r.json();if(!data.portraits.some(p=>p.id===this.portraitId))this.portraitId=data.portraits[0]?.id||'nuannuan';this.image.src='/api/natural/portraits/'+encodeURIComponent(this.portraitId);await this.image.decode();}
  start(){this.isRunning=true;this.image.style.display='block';this.requestActor?.();}
  showIdle(){if(this.actorPlayer?.current())return;if(this.isRunning)this.image.style.display='block';}
  stop(){this.isRunning=false;this.releaseActor?.();this.disconnectActor();}
  stopSpeaking(){this.currentVideoSpeech?.stop();this.isSpeaking=false;this.video.muted=true;this.audioGainNode.gain.setValueAtTime(0,this.audioCtx.currentTime);}
  setInteractionState(state){this.stateName=state;}setMood(){}lookAtCamera(){}playGesture(){}stopGesture(){}speakWithHands(){}
  async actorEvent(data){
    if(data.type==='actor_stream_start'){
      this.disconnectActor();this.streamId=data.stream_id;this.cues=new Map();
      this.video.muted=true;this.video.style.display='block';this.video.style.opacity='0';
      this.actorPlayer=new FragmentedPlayer(this.video,{
        start:()=>{this.image.style.display='none';this.video.style.opacity='1';},
        error:e=>this.onActorError?.(e.message)
      },{initialBuffer:0.32});this.actorMetrics=this.actorPlayer.metrics;
      await this.actorPlayer.init(data.mime);this.watchActor();return;
    }
    if(data.stream_id!==this.streamId)return;
    if(data.type==='actor_stream_chunk')this.actorPlayer?.push(data);
    if(data.type==='actor_cue_start'||data.type==='actor_cue_end'){
      const cue=this.cues.get(data.turn_id)||{};
      cue[data.type==='actor_cue_start'?'start':'end']=data.pts;
      if(data.underflows!==undefined)cue.underflows=data.underflows;
      this.cues.set(data.turn_id,cue);
      while(this.cues.size>20)this.cues.delete(this.cues.keys().next().value);
    }
  }
  watchActor(){
    const tick=()=>{
      if(!this.actorPlayer?.current())return;
      this.currentVideoSpeech?.tick();this.actorFrame=requestAnimationFrame(tick);
    };this.actorFrame=requestAnimationFrame(tick);
  }
  disconnectActor(){cancelAnimationFrame(this.actorFrame);this.stopSpeaking();this.actorPlayer?.stop();this.actorPlayer=null;this.cues?.clear();this.video.style.display='none';this.image.style.display='block';}
  dispose(){this.stop();this.source.disconnect();this.audioAnalyzerNode.disconnect();this.audioGainNode.disconnect();this.video.removeAttribute('src');this.video.load();this.idle.removeAttribute('src');this.idle.load();this.element.replaceChildren();}
}
// Speech boundaries are timestamp cues on the existing actor's media clock.
// Ending/cancelling a reply never replaces the actor, decoder or head pose.
export class ContinuousActorSpeech {
  constructor(head,data,callbacks){this.head=head;this.data=data;this.cb=callbacks;this.stopped=false;this.metrics={starts:0,rebufferEvents:0,stalledEvents:0};head.currentVideoSpeech=this;}
  async init(){await this.head.audioCtx.resume();this.rebuffers=this.head.actorMetrics?.rebufferEvents||0;}
  tick(){
    if(this.stopped)return;
    const cue=this.head.cues?.get(this.data.turn_id),v=this.head.video;
    if(cue?.start===undefined||v.currentTime<cue.start)return;
    if(!this.metrics.starts){
      this.metrics.starts=1;this.metrics.startPts=cue.start;this.metrics.startedAt=performance.now();
      v.muted=false;this.head.audioGainNode.gain.setValueAtTime(1,this.head.audioCtx.currentTime);
      this.head.isSpeaking=true;this.cb.start();this.cb.caption(this.data.text);this.watchAudio();
    }
    if(cue.end!==undefined&&v.currentTime>=cue.end){
      this.metrics.endPts=cue.end;this.metrics.underflows=cue.underflows;this.stop(true);this.cb.end();
    }
  }
  watchAudio(){
    const samples=new Float32Array(this.head.audioAnalyzerNode.fftSize);
    const tick=()=>{
      if(this.stopped||this.head.currentVideoSpeech!==this)return;
      this.head.audioAnalyzerNode.getFloatTimeDomainData(samples);
      if(samples.some(x=>Math.abs(x)>.003)){this.metrics.audibleAt=performance.now();this.cb.audible?.();}
      else this.audioFrame=requestAnimationFrame(tick);
    };this.audioFrame=requestAnimationFrame(tick);
  }
  stop(natural=false){
    if(this.stopped)return;this.stopped=true;cancelAnimationFrame(this.audioFrame);
    this.metrics.finishedAt=performance.now();this.metrics.cancelled=!natural;
    this.metrics.rebufferEvents=(this.head.actorMetrics?.rebufferEvents||0)-(this.rebuffers||0);
    if(this.head.currentVideoSpeech!==this)return;
    this.head.video.muted=true;this.head.audioGainNode.gain.setValueAtTime(0,this.head.audioCtx.currentTime);this.head.isSpeaking=false;
  }
}
