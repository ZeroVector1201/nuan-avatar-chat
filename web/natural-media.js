// One continuous fMP4 timeline: AAC/H.264 decoder state survives every chunk.
// init() never waits for play(), because more chunks may arrive on the same task chain.
export class FragmentedPlayer {
  constructor(video, callbacks={}, options={}) {
    this.video=video;this.cb=callbacks;this.queue=[];this.bytes=0;this.sequence=0;
    this.metrics={starts:0,rebufferEvents:0,stalledEvents:0};this.stopped=false;this.complete=false;
    this.createdAt=performance.now();video.nuanPlayer=this;
    this.initialBuffer=options.initialBuffer??0.60;
  }
  current(){return !this.stopped&&this.video.nuanPlayer===this;}
  async init(mime){
    const Source=window.MediaSource||window.ManagedMediaSource;
    if(!Source?.isTypeSupported(mime))throw Error('当前浏览器不支持实时人物视频，请使用新版 Chrome 或 Edge。');
    const v=this.video;v.disableRemotePlayback=true;this.media=new Source();
    this.onPlaying=()=>{if(!this.current())return;if(this.waiting){this.waiting.durationMs=performance.now()-this.waiting.at;this.waiting=null;}if(!this.metrics.starts){this.metrics.starts=1;this.metrics.firstPlayingMs=performance.now()-this.createdAt;this.cb.start?.();}};
    this.onWaiting=()=>{if(this.current()&&this.metrics.starts&&!v.ended){this.metrics.rebufferEvents++;const ranges=v.buffered;this.waiting={at:performance.now(),time:v.currentTime,bufferedSeconds:ranges.length?ranges.end(ranges.length-1)-v.currentTime:0};(this.metrics.waits??=[]).push(this.waiting);if(this.metrics.waits.length>12)this.metrics.waits.shift();}};
    this.onStalled=()=>{if(this.current()&&this.metrics.starts)this.metrics.stalledEvents++;};
    this.onEnded=()=>{if(!this.current())return;this.finishMetrics();this.cb.end?.();};
    this.onError=()=>this.fail(Error('实时人物视频解码失败。'));
    for(const [event,handler] of Object.entries({playing:this.onPlaying,waiting:this.onWaiting,stalled:this.onStalled,ended:this.onEnded,error:this.onError}))v.addEventListener(event,handler);
    this.url=URL.createObjectURL(this.media);v.src=this.url;
    await new Promise((resolve,reject)=>{
      this.rejectInit=reject;
      this.openTimer=setTimeout(()=>reject(Error('视频播放器启动超时')),10000);
      this.media.addEventListener('sourceopen',()=>{
        clearTimeout(this.openTimer);this.rejectInit=null;
        if(!this.current()){resolve();return;}
        try{this.buffer=this.media.addSourceBuffer(mime);this.buffer.addEventListener('updateend',()=>this.flush());this.buffer.addEventListener('error',()=>this.fail(Error('视频片段无法播放')));resolve();}
        catch(e){reject(e);}
      },{once:true});
    });
  }
  push(data){
    if(!this.current())return;
    if(this.complete||data.seq!==this.sequence++)throw Error('人物视频片段顺序异常');
    const raw=atob(data.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    if((this.bytes+=bytes.length)>24_000_000)throw Error('人物视频缓冲超限');
    this.queue.push(bytes);this.flush();
  }
  end(data){
    if(!this.current())return;
    if(data.chunks!==this.sequence)throw Error('人物视频接收不完整');
    this.complete=true;this.metrics.allReceivedMs=performance.now()-this.createdAt;this.flush();
  }
  flush(){
    if(!this.current()||!this.buffer||this.buffer.updating||this.media.readyState!=='open')return;
    try{
      const v=this.video,ranges=this.buffer.buffered;
      const buffered=ranges.length?ranges.end(ranges.length-1)-v.currentTime:0;
      if(!this.playRequested&&buffered>=(this.complete ? 0.08 : this.initialBuffer)){
        this.playRequested=true;this.metrics.initialBufferSeconds=buffered;
        v.play().catch(e=>{if(this.current())this.fail(e);});
      }
      if(v.currentTime>12&&ranges.length&&ranges.start(0)<v.currentTime-8){this.buffer.remove(0,v.currentTime-6);return;}
      if(this.queue.length){const data=this.queue.shift();this.bytes-=data.length;this.buffer.appendBuffer(data);return;}
      if(this.complete){this.media.endOfStream();}
    }catch(e){this.fail(e);}
  }
  finishMetrics(){const q=this.video.getVideoPlaybackQuality?.();if(q){this.metrics.decodedFrames=q.totalVideoFrames;this.metrics.droppedFrames=q.droppedVideoFrames;}this.metrics.finishedAt=performance.now();}
  fail(error){if(!this.current())return;this.cb.error?.(error);this.stop();}
  stop(clear=true){
    if(this.stopped)return;this.finishMetrics();this.stopped=true;this.queue=[];this.bytes=0;
    clearTimeout(this.openTimer);this.rejectInit?.(new DOMException('Playback cancelled','AbortError'));this.rejectInit=null;
    const v=this.video;
    for(const [event,handler] of Object.entries({playing:this.onPlaying,waiting:this.onWaiting,stalled:this.onStalled,ended:this.onEnded,error:this.onError}))if(handler)v.removeEventListener(event,handler);
    if(v.nuanPlayer===this){v.pause();if(clear){v.removeAttribute('src');v.load();}v.nuanPlayer=null;}
    if(this.url)URL.revokeObjectURL(this.url);
  }
}
