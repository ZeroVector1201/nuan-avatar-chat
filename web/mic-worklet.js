class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();this.frame=new Float32Array(Math.round(sampleRate*.02));this.offset=0;
    this.port.onmessage=({data})=>{
      if(data?.type!=='flush')return;
      if(this.offset){const tail=this.frame.slice(0,this.offset);this.port.postMessage(tail,[tail.buffer]);this.offset=0;}
      this.port.postMessage({type:'flushed'});
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if(channel)for(const value of channel){
      this.frame[this.offset++]=value;
      if(this.offset===this.frame.length){
        this.port.postMessage(this.frame,[this.frame.buffer]);
        this.frame=new Float32Array(Math.round(sampleRate*.02));this.offset=0;
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', CaptureProcessor);
