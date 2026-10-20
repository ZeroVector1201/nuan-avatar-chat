const modules=new WeakMap();
export class PCMSpeech {
  constructor(head,data,callbacks){
    this.head=head;this.data=data;this.cb=callbacks;this.seq=0;this.samples=0;
    this.stopped=false;this.metrics={starts:0,underruns:0};head.currentSpeech=this;
  }
  async init(){
    const ctx=this.head.audioCtx;
    if(this.data.format!=='pcm_s16le'||this.data.sample_rate!==24000)throw Error('不支持的音频格式。');
    if(!modules.has(ctx))modules.set(ctx,ctx.audioWorklet.addModule('/static/pcm-worklet.js').catch(e=>{modules.delete(ctx);throw e;}));
    await modules.get(ctx);if(this.stopped)return;
    await ctx.resume();if(this.stopped)return;
    this.node=new AudioWorkletNode(ctx,'nuan-pcm-player',{
      numberOfInputs:0,outputChannelCount:[1],processorOptions:{sampleRate:this.data.sample_rate}
    });
    this.node.connect(this.head.audioAnalyzerNode);
    this.node.onprocessorerror=()=>{if(!this.stopped){this.stop();this.cb.error(new Error('音频播放中断，请重试。'));}};
    this.node.port.onmessage=({data:d})=>{
      if(this.stopped)return;
      this.metrics.underruns=d.underruns;
      if(d.type==='started'){this.metrics.starts++;this.head.isSpeaking=true;this.cb.start();}
      if(d.type==='audible'){this.metrics.audibleAt=performance.now();this.cb.caption(this.data.text);this.cb.audible?.();}
      if(d.type==='finished'){this.stop();this.cb.end();}
    };
  }
  push(data){
    if(this.stopped)return;
    if(data.seq!==this.seq||data.sample_offset!==this.samples)throw Error('语音数据顺序不完整。');
    const bytes=Uint8Array.from(atob(data.data),c=>c.charCodeAt(0));
    if(bytes.length%2)throw Error('语音数据不完整。');
    this.seq++;this.samples+=bytes.length/2;
    this.node.port.postMessage({type:'pcm',audio:bytes.buffer},[bytes.buffer]);
  }
  end(data){
    if(this.stopped)return;
    if(data.samples!==this.samples||data.chunks!==this.seq)throw Error('语音传输未完成。');
    this.node.port.postMessage({type:'end'});
  }
  stop(){
    if(this.stopped)return;this.stopped=true;
    if(this.node){this.node.port.postMessage({type:'stop'});this.node.disconnect();this.node.port.close();}
    if(this.head.currentSpeech===this){
      this.head.isSpeaking=false;this.head.resetLips();this.head.currentSpeech=null;
    }
  }
}
