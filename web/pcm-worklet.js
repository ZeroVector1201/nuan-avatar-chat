// Source PCM is 24 kHz; the device can be 44.1/48 kHz. Resample on the audio clock.
class PCMPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputRate=options.processorOptions?.sampleRate||24000;
    this.ratio=this.inputRate/sampleRate;this.phase=0;
    this.queue=[];this.offset=0;this.queued=0;this.played=0;
    this.started=false;this.playing=false;this.ended=false;this.stopped=false;
    this.audible=false;this.underruns=0;this.minimum=Math.round(this.inputRate*.24);
    this.port.onmessage=({data:d})=>{
      if(d.type==='stop'){this.stopped=true;this.queue=[];this.queued=0;return;}
      if(this.stopped)return;
      if(d.type==='end')this.ended=true;
      if(d.type==='pcm'){
        const samples=new Int16Array(d.audio);
        if(samples.length){this.queue.push(samples);this.queued+=samples.length;}
      }
    };
  }
  report(type){this.port.postMessage({type,playedSamples:this.played,underruns:this.underruns});}
  consume(){
    if(!this.queued)return;
    this.offset++;this.queued--;this.played++;
    if(this.offset===this.queue[0].length){this.queue.shift();this.offset=0;}
  }
  process(inputs,outputs){
    const out=outputs[0][0];out.fill(0);
    if(this.stopped)return false;
    if(!this.playing&&(this.queued>=this.minimum||(this.ended&&this.queued))){
      this.playing=true;
      if(!this.started){this.started=true;this.report('started');}
    }
    for(let i=0;this.playing&&i<out.length;i++){
      if(!this.queued||(this.queued===1&&!this.ended))break;
      const first=this.queue[0],a=first[this.offset];
      const b=this.offset+1<first.length?first[this.offset+1]:(this.queue[1]?.[0]??a);
      out[i]=(a+(b-a)*this.phase)/32768;
      this.phase+=this.ratio;
      while(this.phase>=1&&this.queued){this.consume();this.phase-=1;}
    }
    if(!this.audible&&out.some(x=>Math.abs(x)>.003)){this.audible=true;this.report('audible');}
    if(this.ended&&!this.queued){this.playing=false;this.report('finished');return false;}
    if(this.playing&&this.queued<=1&&!this.ended){
      this.playing=false;this.underruns++;this.report('buffering');
    }
    return true;
  }
}
registerProcessor('nuan-pcm-player',PCMPlayer);
